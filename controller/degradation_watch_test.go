package controller

import (
	"context"
	"fmt"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/service"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestDegradationWatchChannelsIncludesUnsavedGroupsWithoutCredentials(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
	previousDB := model.DB
	model.DB = db
	t.Cleanup(func() { model.DB = previousDB })
	setting := operation_setting.GetDegradationWatchSetting()
	previousSetting := *setting
	t.Cleanup(func() { *setting = previousSetting })
	setting.Targets = []operation_setting.DegradationWatchTarget{{Group: "alpha", Model: "model-a", Enabled: true}}
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.DegradationWatchRecord{}))
	require.NoError(t, db.Create(&[]model.Channel{
		{Id: 1, Name: "Alpha", Group: "alpha", Models: "model-a", Status: 1, Key: "test-secret-alpha"},
		{Id: 2, Name: "Beta", Group: "beta", Models: "model-b,shared", Status: 1, Key: "test-secret-beta"},
	}).Error)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	GetDegradationWatchChannels(c)
	var response struct {
		Success bool `json:"success"`
		Data    struct {
			Channels  []degradationWatchChannelItem      `json:"channels"`
			Available []degradationWatchAvailableChannel `json:"available_channels"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success, recorder.Body.String())
	require.Len(t, response.Data.Channels, 1)
	assert.Equal(t, 1, response.Data.Channels[0].Id)
	assert.ElementsMatch(t, []degradationWatchAvailableChannel{
		{Id: 1, Name: "Alpha", Status: 1, Groups: []string{"alpha"}, Models: []string{"model-a"}},
		{Id: 2, Name: "Beta", Status: 1, Groups: []string{"beta"}, Models: []string{"model-b", "shared"}},
	}, response.Data.Available)
	assert.NotContains(t, recorder.Body.String(), "test-secret")
	assert.NotContains(t, recorder.Body.String(), `"key"`)
}

func TestExtractDegradationWatchHtml(t *testing.T) {
	for _, tc := range []struct {
		name   string
		text   string
		html   string
		reason string
	}{
		{"empty", "  \n", "", degradationWatchReasonEmpty},
		{"no html", "抱歉，我无法完成。", "", degradationWatchReasonNoHtml},
		{"html without svg", "<!doctype html><html><canvas></canvas></html>", "", degradationWatchReasonNoSvg},
		{
			"fenced with commentary",
			"好的：\n```html\n<!DOCTYPE html><html><body><svg viewBox=\"0 0 16 10\"></svg></body></html>\n```\n说明",
			"<!DOCTYPE html><html><body><svg viewBox=\"0 0 16 10\"></svg></body></html>",
			"",
		},
		{"no doctype", "<html><svg/></html>", "<html><svg/></html>", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			html, reason := extractDegradationWatchHtml(tc.text)
			assert.Equal(t, tc.html, html)
			assert.Equal(t, tc.reason, reason)
		})
	}
}

func TestCollectDegradationWatchStreamText(t *testing.T) {
	chat := []byte("data: {\"choices\":[{\"delta\":{\"content\":\"<html>\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"</html>\"}}]}\n\ndata: [DONE]\n")
	assert.Equal(t, "<html></html>", collectDegradationWatchStreamText(chat))

	responses := []byte("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"<svg>\"}\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"content\":[{\"type\":\"output_text\",\"text\":\"<svg>\"}]}]}}\n")
	assert.Equal(t, "<svg>", collectDegradationWatchStreamText(responses))

	completedOnly := []byte("data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"reasoning\"},{\"content\":[{\"type\":\"output_text\",\"text\":\"<svg>\"}]}]}}\n")
	assert.Equal(t, "<svg>", collectDegradationWatchStreamText(completedOnly))
}

func TestDegradationWatchRecordItemMasksUpstreamErrorsForUsers(t *testing.T) {
	aliases := map[string]string{"7": "Alpha"}
	upstream := &model.DegradationWatchRecord{ChannelId: 7, FailureReason: "upstream error: dial tcp 10.0.0.8:443: timeout"}
	assert.Equal(t, degradationWatchReasonUpstream, toDegradationWatchRecordItem(upstream, false, aliases).FailureReason)
	assert.Equal(t, upstream.FailureReason, toDegradationWatchRecordItem(upstream, true, aliases).FailureReason)

	coded := &model.DegradationWatchRecord{ChannelId: 7, FailureReason: degradationWatchReasonNoSvg}
	assert.Equal(t, degradationWatchReasonNoSvg, toDegradationWatchRecordItem(coded, false, aliases).FailureReason)
}

func TestDegradationWatchRecordItemHidesChannelIdFromUsers(t *testing.T) {
	aliases := map[string]string{"7": "Alpha"}
	record := &model.DegradationWatchRecord{ChannelId: 7}

	user := toDegradationWatchRecordItem(record, false, aliases)
	assert.Empty(t, user.ChannelTitle)
	assert.False(t, user.Aliased)
	assert.Zero(t, user.ChannelId, "users must never receive channel ids")

	admin := toDegradationWatchRecordItem(record, true, aliases)
	assert.Equal(t, "Alpha", admin.ChannelTitle)
	assert.Equal(t, 7, admin.ChannelId)
}

func TestIsDegradationWatchCandidate(t *testing.T) {
	channel := &model.Channel{Status: 1, Group: "default,GPT-企业", Models: "gpt-5, gpt-6-astra"}
	assert.True(t, isDegradationWatchCandidate(channel, "GPT-企业", "gpt-6-astra"))
	assert.False(t, isDegradationWatchCandidate(channel, "GPT-企业", "gpt-6"))
	assert.False(t, isDegradationWatchCandidate(channel, "vip", "gpt-6-astra"))
	channel.Status = 3
	assert.False(t, isDegradationWatchCandidate(channel, "GPT-企业", "gpt-6-astra"))
}

func TestSelectDegradationWatchJobsRespectsTargetAndChannelFilters(t *testing.T) {
	channels := []*model.Channel{
		{Id: 1, Status: 1, Group: "vip", Models: "sol,luna"},
		{Id: 2, Status: 1, Group: "vip", Models: "sol"},
	}
	targets := []operation_setting.DegradationWatchTarget{
		{Model: "sol", Group: "vip", Enabled: true},
		{Model: "luna", Group: "vip", Enabled: false},
	}
	describe := func(jobs []degradationWatchJob) []string {
		out := make([]string, 0, len(jobs))
		for _, job := range jobs {
			out = append(out, fmt.Sprintf("%s@%d", job.target.Model, job.channel.Id))
		}
		return out
	}

	assert.Equal(t, []string{"sol@1", "sol@2"}, describe(selectDegradationWatchJobs(channels, targets, degradationWatchTaskPayload{})), "scheduled rounds skip disabled targets")
	assert.Equal(t, []string{"luna@1"}, describe(selectDegradationWatchJobs(channels, targets, degradationWatchTaskPayload{Model: "luna"})), "a named target runs even when disabled")
	assert.Equal(t, []string{"sol@2"}, describe(selectDegradationWatchJobs(channels, targets, degradationWatchTaskPayload{Model: "sol", ChannelId: 2})))
	assert.Empty(t, selectDegradationWatchJobs(channels, targets, degradationWatchTaskPayload{Model: "luna", ChannelId: 2}))
}

func TestGroupDegradationWatchRoundsSplitsByRunId(t *testing.T) {
	records := []*model.DegradationWatchRecord{
		{Id: 6, RunId: "b", ChannelId: 1, ModelName: "sol", CreatedAt: 2000},
		{Id: 5, RunId: "b", ChannelId: 1, ModelName: "luna", CreatedAt: 1990},
		{Id: 4, RunId: "a", ChannelId: 1, ModelName: "sol", CreatedAt: 1000},
	}

	rounds := groupDegradationWatchRounds(records)

	assert.Len(t, rounds, 2)
	assert.Equal(t, "b", rounds[0].Key)
	assert.EqualValues(t, 1990, rounds[0].StartedAt)
	assert.Equal(t, 5, rounds[0].minId)
	assert.Len(t, rounds[0].records, 2)
	assert.Equal(t, "a", rounds[1].Key)
}

func TestGroupDegradationWatchRoundsSplitsLegacyRecordsByGapAndRepeatedSeries(t *testing.T) {
	records := []*model.DegradationWatchRecord{
		{Id: 9, ChannelId: 1, ModelName: "sol", CreatedAt: 5000},
		{Id: 8, ChannelId: 2, ModelName: "sol", CreatedAt: 4990},
		{Id: 7, ChannelId: 1, ModelName: "sol", CreatedAt: 4980},
		{Id: 6, ChannelId: 2, ModelName: "sol", CreatedAt: 4000},
	}

	rounds := groupDegradationWatchRounds(records)

	assert.Len(t, rounds, 3)
	assert.Equal(t, "legacy-8", rounds[0].Key, "a repeated channel+model starts a new round")
	assert.Equal(t, "legacy-7", rounds[1].Key)
	assert.Equal(t, "legacy-6", rounds[2].Key, "a gap longer than the legacy window starts a new round")
}

func TestDegradationWatchRunAllPublishesIndependentLiveJobs(t *testing.T) {
	previousTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = previousTimeout })
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	previousDB, redis, cache := model.DB, common.RedisEnabled, common.MemoryCacheEnabled
	model.DB, common.RedisEnabled, common.MemoryCacheEnabled = db, false, false
	setting := operation_setting.GetDegradationWatchSetting()
	previousSetting := *setting
	t.Cleanup(func() {
		model.DB, common.RedisEnabled, common.MemoryCacheEnabled = previousDB, redis, cache
		*setting = previousSetting
		_ = sqlDB.Close()
	})
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Channel{}, &model.DegradationWatchRecord{}, &model.SystemTask{}, &model.SystemTaskLock{}))
	user := model.User{Username: "watch-test", Role: common.RoleRootUser, Group: "default", Quota: 10000, Status: 1}
	require.NoError(t, db.Create(&user).Error)
	release := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Model string `json:"model"`
		}
		if err := common.DecodeJson(r.Body, &request); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if request.Model == "astra" {
			http.Error(w, strings.Repeat("full error detail ", 100)+"test-channel-secret final-error-line", 429)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"<html><svg>"}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"<circle/>"}}]}`+"\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		case <-ctx.Done():
			return
		}
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"</svg></html>"},"finish_reason":"stop"}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}`+"\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	base := upstream.URL
	channel := model.Channel{Type: constant.ChannelTypeOpenAI, Name: "test-channel", Key: "test-channel-secret", BaseURL: &base, Group: "default", Models: "sol,astra", Status: common.ChannelStatusEnabled}
	require.NoError(t, db.Create(&channel).Error)
	setting.Targets = []operation_setting.DegradationWatchTarget{{Model: "sol", Group: "default", Enabled: true}, {Model: "astra", Group: "default", Enabled: true}}
	setting.Concurrency = 2
	service.InitHttpClient()
	done := make(chan struct{})
	var summary degradationWatchSummary
	var runErr error
	go func() {
		defer close(done)
		summary, runErr = runDegradationWatchTask(ctx, "live-test", degradationWatchTaskPayload{}, nil)
	}()
	// Observe actual persisted progress before releasing the upstream response.
	observed := assert.Eventually(t, func() bool {
		records, err := model.ListDegradationWatchRecords(channel.Id, 0, 10, true)
		if err != nil || len(records) != 2 {
			return false
		}
		return records[0].Status == "failed" && records[1].Status == "running" && records[1].CompletionTokens > 0
	}, 10*time.Second, 20*time.Millisecond)
	close(release)
	if !observed {
		rows, _ := model.ListDegradationWatchRecords(channel.Id, 0, 10, true)
		for _, row := range rows {
			t.Logf("%s %s %s", row.ModelName, row.Status, row.ErrorDetails)
		}
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("batch did not complete")
	}
	require.NoError(t, runErr)
	assert.Equal(t, 1, summary.Succeeded)
	assert.Equal(t, 1, summary.Failed)
	records, err := model.ListDegradationWatchRecords(channel.Id, 0, 10, true)
	require.NoError(t, err)
	require.Len(t, records, 2)
	assert.Equal(t, "failed", records[0].Status)
	assert.Contains(t, string(records[0].ErrorDetails), "final-error-line")
	assert.NotContains(t, string(records[0].ErrorDetails), channel.Key)
	assert.Equal(t, "succeeded", records[1].Status)
	assert.Equal(t, 12, records[1].PromptTokens)
	assert.Equal(t, 34, records[1].CompletionTokens)
	assert.False(t, records[1].TokensEstimated)
	var unchanged model.User
	require.NoError(t, db.First(&unchanged, user.Id).Error)
	assert.Equal(t, user.Quota, unchanged.Quota)
	assert.Zero(t, unchanged.UsedQuota)
}

func TestDegradationWatchProgressPreservesExplicitZeroAndIgnoresPartialEvents(t *testing.T) {
	record := degradationWatchProgress([]byte(`data: {"choices":[{"delta":{"content":"abc"}}]}`+"\n\n"+`data: {"usage":{"prompt_tokens":0,"completion_tokens":0}}`+"\n\n"+`data: {"choices":[{"delta":{"content":"partial`), "input", "sol")
	assert.Equal(t, "abc", string(record.OutputText))
	assert.Zero(t, record.PromptTokens)
	assert.Zero(t, record.CompletionTokens)
	assert.False(t, record.TokensEstimated)
}

func TestDegradationWatchModelHistoryAndDetailVisibility(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	previousDB := model.DB
	model.DB = db
	setting := operation_setting.GetDegradationWatchSetting()
	previousSetting := *setting
	t.Cleanup(func() { model.DB = previousDB; *setting = previousSetting; _ = sqlDB.Close() })
	setting.Targets = []operation_setting.DegradationWatchTarget{{Model: "slow", Group: "default", Enabled: true}, {Model: "fast", Group: "default", Enabled: true}}
	setting.ChannelAliases = map[string]string{"1": "Public alias"}
	require.NoError(t, db.AutoMigrate(&model.DegradationWatchRecord{}, &model.SystemTask{}, &model.Channel{}))
	require.NoError(t, db.Create(&model.Channel{Id: 1, Name: "private", Models: "slow,fast", Group: "default", Status: 1, Key: "secret"}).Error)
	slow := &model.DegradationWatchRecord{ChannelId: 1, ModelName: "slow", FailureReason: "upstream_error", ErrorDetails: "full private upstream diagnostic", OutputText: "partial output"}
	require.NoError(t, model.CreateDegradationWatchRecord(slow))
	for range 12 {
		require.NoError(t, model.CreateDegradationWatchRecord(&model.DegradationWatchRecord{ChannelId: 1, ModelName: "fast"}))
	}
	for _, admin := range []bool{false, true} {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("GET", "/api/degradation_watch/monitor?model=slow&group=default&channel_id=1", nil)
		if admin {
			c.Set("role", common.RoleAdminUser)
		}
		GetDegradationProbeWall(c)
		var result struct {
			Success bool
			Data    struct {
				Probes []degradationProbeHistory `json:"probes"`
			}
		}
		require.NoError(t, common.Unmarshal(w.Body.Bytes(), &result))
		require.True(t, result.Success, w.Body.String())
		require.Len(t, result.Data.Probes[1].Records, 1)
		assert.Equal(t, slow.Id, result.Data.Probes[1].Records[0].Id)
		if admin {
			assert.Empty(t, result.Data.Probes[1].Records[0].ErrorDetails)
		} else {
			assert.Empty(t, result.Data.Probes[1].Records[0].ErrorDetails)
			assert.Zero(t, result.Data.Probes[1].Records[0].ChannelId)
		}
	}
	require.NoError(t, model.SetDegradationWatchRecordHidden(slow.Id, true))
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{{Key: "id", Value: fmt.Sprint(slow.Id)}}
	GetDegradationWatchRecord(c)
	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.NotContains(t, w.Body.String(), "partial output")
}

func TestDegradationProbeRulesAndPlanValidation(t *testing.T) {
	probe := operation_setting.DegradationProbe{ID: "sanae", Name: "Sanae", Kind: "text", Prompt: operation_setting.SanaeProbePrompt, Expected: "高市早苗", Match: "exact", IntervalMinutes: 5}
	for _, tc := range []struct {
		output string
		passed bool
	}{{"<html><svg/></html>", true}, {"<html><svg viewBox=\"0 0 10 10\"><circle/></svg></html>", true}, {"<html><svg></html>", false}, {"<html><svgfake/></html>", false}} {
		record := &model.DegradationWatchRecord{}
		evaluateDegradationProbe(record, operation_setting.DegradationProbe{Kind: "drawing"}, tc.output)
		assert.Equal(t, tc.passed, record.Success, tc.output)
	}
	for _, tc := range []struct {
		output string
		passed bool
	}{{"高市早苗", true}, {" \n高市早苗\t", true}, {"高市早苗。", false}, {"uncertain", false}, {"", false}, {"答案是高市早苗", false}} {
		record := &model.DegradationWatchRecord{}
		evaluateDegradationProbe(record, probe, tc.output)
		assert.Equal(t, tc.passed, record.Success, tc.output)
		assert.NotEqual(t, "error", record.Verdict)
	}
	plan := operation_setting.DegradationProbePlan{Concurrency: 2, TimeoutSeconds: 1200, Probes: []operation_setting.DegradationProbe{probe}, Targets: []operation_setting.DegradationProbeTarget{
		{Group: "a", Model: "sol", ChannelID: 1, Public: true, Probes: []operation_setting.DegradationProbeBinding{{ProbeID: "sanae", Enabled: true}}},
		{Group: "b", Model: "sol", ChannelID: 1, Public: true},
	}}
	raw, err := common.Marshal(plan)
	require.NoError(t, err)
	_, err = operation_setting.ParseDegradationProbePlan(string(raw))
	require.NoError(t, err)
	plan.Targets[1].Group, plan.Targets[1].ChannelID = "a", 2
	raw, err = common.Marshal(plan)
	require.NoError(t, err)
	_, err = operation_setting.ParseDegradationProbePlan(string(raw))
	require.NoError(t, err, "multiple public channels are allowed")
	plan.Targets[1].Public = false
	plan.Targets[0].Probes[0].IntervalMinutes = -1
	raw, err = common.Marshal(plan)
	require.NoError(t, err)
	_, err = operation_setting.ParseDegradationProbePlan(string(raw))
	assert.ErrorContains(t, err, "invalid probe binding")
}

func TestDegradationProbeIndependentSchedulesAndPublicSelection(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	previous := model.DB
	model.DB = db
	setting := operation_setting.GetDegradationWatchSetting()
	saved := *setting
	t.Cleanup(func() { model.DB = previous; *setting = saved; _ = sqlDB.Close() })
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.DegradationWatchRecord{}, &model.SystemTask{}))
	channels := []*model.Channel{{Id: 1, Name: "private-one", Status: 1, Group: "a,b", Models: "sol", Key: "sk-private-secret"}, {Id: 2, Name: "private-two", Status: 1, Group: "a", Models: "sol", Key: "sk-second-secret"}}
	for _, channel := range channels {
		require.NoError(t, db.Create(channel).Error)
	}
	textProbe := operation_setting.DegradationProbe{ID: "sanae", Name: "Sanae", Kind: "text", Prompt: "prompt", Expected: "高市早苗", Match: "exact", IntervalMinutes: 5}
	plan := operation_setting.DegradationProbePlan{Enabled: true, Concurrency: 2, TimeoutSeconds: 1200, Probes: []operation_setting.DegradationProbe{textProbe, {ID: "drawing", Name: "Drawing", Kind: "drawing", Prompt: "draw", IntervalMinutes: 60}}}
	for _, target := range []operation_setting.DegradationProbeTarget{{Group: "a", Model: "sol", ChannelID: 1, Enabled: true, Public: true}, {Group: "b", Model: "sol", ChannelID: 1, Enabled: true, Public: true}, {Group: "a", Model: "sol", ChannelID: 2, Enabled: true}} {
		target.Probes = []operation_setting.DegradationProbeBinding{{ProbeID: "sanae", Enabled: true}, {ProbeID: "drawing", Enabled: true}}
		plan.Targets = append(plan.Targets, target)
	}
	raw, err := common.Marshal(plan)
	require.NoError(t, err)
	setting.ProbePlan = string(raw)
	now := common.GetTimestamp()
	first := &model.DegradationWatchRecord{ChannelId: 1, GroupName: "a", ModelName: "sol", ProbeID: "sanae", CreatedAt: now, Status: "succeeded", Success: true, OutputText: "高市早苗", PromptSnapshot: "old prompt", ExpectedSnapshot: "old answer"}
	require.NoError(t, model.CreateDegradationWatchRecord(first))
	jobs, err := selectDegradationProbeJobs(&plan, channels, degradationWatchTaskPayload{Scheduled: true}, "text", now+299)
	require.NoError(t, err)
	require.Len(t, jobs, 2)
	assert.Equal(t, "b", jobs[0].target.Group)
	assert.Equal(t, 2, jobs[1].target.ChannelID)
	jobs, err = selectDegradationProbeJobs(&plan, channels, degradationWatchTaskPayload{Scheduled: true}, "text", now+300)
	require.NoError(t, err)
	assert.Len(t, jobs, 3)
	jobs, err = selectDegradationProbeJobs(&plan, channels, degradationWatchTaskPayload{Scheduled: true}, "drawing", now)
	require.NoError(t, err)
	assert.Len(t, jobs, 3)
	private := &model.DegradationWatchRecord{ChannelId: 2, GroupName: "a", ModelName: "sol", ProbeID: "sanae", CreatedAt: now, Status: "failed", OutputText: "private response"}
	require.NoError(t, model.CreateDegradationWatchRecord(private))
	for _, query := range []string{"", "?group=a&model=sol&channel_id=2"} {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("GET", "/monitor"+query, nil)
		GetDegradationProbeWall(c)
		assert.NotContains(t, w.Body.String(), "channel_id")
		assert.NotContains(t, w.Body.String(), "channel_name")
		assert.NotContains(t, w.Body.String(), "private-")
		assert.NotContains(t, w.Body.String(), "private response")
		assert.Contains(t, w.Body.String(), `"success":true`)
	}
	for _, record := range []*model.DegradationWatchRecord{first, private} {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Params = gin.Params{{Key: "id", Value: strconv.Itoa(record.Id)}}
		GetDegradationWatchRecord(c)
		if record == first {
			assert.Contains(t, w.Body.String(), "old prompt")
			assert.Contains(t, w.Body.String(), "old answer")
		} else {
			assert.Equal(t, 404, w.Code)
		}
	}
	redacted := publicDegradationProbeError("HTTP 429 private-one https://provider.example/v1 sk-private-secret channel_id=1\nrequest-id: final-line", 1)
	for _, secret := range []string{"private-one", "provider.example", "sk-private-secret", "channel_id=1"} {
		assert.NotContains(t, redacted, secret)
	}
	assert.Contains(t, redacted, "HTTP 429")
	assert.Contains(t, redacted, "final-line")
	redacted = publicDegradationProbeError(`dial tcp 10.0.0.8:443 [2001:db8::1]:443 {"channel_id":1,"message":"try later"}`, 1)
	assert.NotContains(t, redacted, "10.0.0.8")
	assert.NotContains(t, redacted, "2001:db8")
	assert.NotContains(t, redacted, "channel_id")
	assert.Contains(t, redacted, "try later")

	// Visibility belongs to each binding; legacy target visibility is only a fallback.
	yes, no := true, false
	plan.Targets[0].Probes[0].Public = &no
	plan.Targets[2].Probes[0].Public = &yes
	raw, err = common.Marshal(plan)
	require.NoError(t, err)
	setting.ProbePlan = string(raw)
	assert.False(t, canViewDegradationProbeRecord(first))
	assert.True(t, canViewDegradationProbeRecord(private))
	plan.Targets[0].Probes[0].Public = &yes
	plan.Targets[0].Probes[1].Public = &no
	raw, err = common.Marshal(plan)
	require.NoError(t, err)
	setting.ProbePlan = string(raw)
	assert.True(t, canViewDegradationProbeRecord(first))
	drawing := &model.DegradationWatchRecord{ChannelId: 1, GroupName: "a", ModelName: "sol", ProbeID: "drawing", CreatedAt: now, Status: "succeeded", Success: true, Html: "<html><svg/></html>"}
	require.NoError(t, model.CreateDegradationWatchRecord(drawing))
	assert.False(t, canViewDegradationProbeRecord(drawing))
	for _, path := range []string{"/monitor?group=a&model=sol", "/monitor?group=a&model=sol&channel_id=999"} {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("GET", path, nil)
		GetDegradationProbeWall(c)
		var response struct {
			Data struct {
				Probes []degradationProbeHistory `json:"probes"`
			} `json:"data"`
		}
		require.NoError(t, common.Unmarshal(w.Body.Bytes(), &response))
		require.Len(t, response.Data.Probes, 1)
		assert.Equal(t, "sanae", response.Data.Probes[0].ID)
		require.Len(t, response.Data.Probes[0].Records, 2)
		assert.Equal(t, private.Id, response.Data.Probes[0].Records[0].Id)
		assert.Equal(t, first.Id, response.Data.Probes[0].Records[1].Id)
		assert.NotContains(t, w.Body.String(), "channel_id")
		assert.NotContains(t, w.Body.String(), "private-one")
	}
	for _, html := range []bool{false, true} {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Params = gin.Params{{Key: "id", Value: strconv.Itoa(drawing.Id)}}
		if html {
			GetDegradationWatchRecordHtml(c)
		} else {
			GetDegradationWatchRecord(c)
		}
		assert.Equal(t, 404, w.Code)
	}
	wCatalog := httptest.NewRecorder()
	cCatalog, _ := gin.CreateTestContext(wCatalog)
	cCatalog.Request = httptest.NewRequest("GET", "/monitor", nil)
	GetDegradationProbeWall(cCatalog)
	var catalog struct {
		Data struct {
			Lanes []degradationProbeLane `json:"lanes"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(wCatalog.Body.Bytes(), &catalog))
	assert.Len(t, catalog.Data.Lanes, 2, "one lane per group and model, without duplicate public channels")
	wAdmin := httptest.NewRecorder()
	cAdmin, _ := gin.CreateTestContext(wAdmin)
	cAdmin.Set("role", common.RoleAdminUser)
	cAdmin.Request = httptest.NewRequest("GET", "/monitor?group=a&model=sol&channel_id=1", nil)
	GetDegradationProbeWall(cAdmin)
	var adminHistory struct {
		Data struct {
			Probes []degradationProbeHistory `json:"probes"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(wAdmin.Body.Bytes(), &adminHistory))
	require.Len(t, adminHistory.Data.Probes, 2)
	require.NotNil(t, adminHistory.Data.Probes[1].Public)
	assert.False(t, *adminHistory.Data.Probes[1].Public)
	require.Len(t, adminHistory.Data.Probes[1].Records, 1)
	require.NotNil(t, adminHistory.Data.Probes[1].Records[0].PublicVisible)
	assert.False(t, *adminHistory.Data.Probes[1].Records[0].PublicVisible)

	// A drawing task already in progress must not silently drop a manual run,
	// or enqueue the text half before reporting the conflict.
	_, err = model.CreateSystemTask(model.SystemTaskTypeDegradationWatch, degradationWatchTaskPayload{}, nil)
	require.NoError(t, err)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/probe-run", strings.NewReader(`{}`))
	RunDegradationProbes(c)
	assert.Equal(t, http.StatusConflict, w.Code)
	var taskCount int64
	require.NoError(t, db.Model(&model.SystemTask{}).Count(&taskCount).Error)
	assert.Equal(t, int64(1), taskCount)
}

func TestDegradationProbeExecutionPersistsPromptVerdictUsageAndErrors(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	previous, redis, cache := model.DB, common.RedisEnabled, common.MemoryCacheEnabled
	model.DB, common.RedisEnabled, common.MemoryCacheEnabled = db, false, false
	setting := operation_setting.GetDegradationWatchSetting()
	saved := *setting
	streamingTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() {
		model.DB, common.RedisEnabled, common.MemoryCacheEnabled = previous, redis, cache
		*setting = saved
		constant.StreamingTimeout = streamingTimeout
		_ = sqlDB.Close()
	})
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Channel{}, &model.DegradationWatchRecord{}, &model.SystemTask{}))
	require.NoError(t, db.Create(&model.User{Username: "probe-test", Role: common.RoleRootUser, Group: "default", Quota: 10000, Status: 1}).Error)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Model           string `json:"model"`
			ReasoningEffort string `json:"reasoning_effort"`
			Messages        []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := common.DecodeJson(r.Body, &request); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if request.Model == "broken" {
			http.Error(w, "HTTP detail\nsecret-probe-key\nfinal-error-line", 429)
			return
		}
		output := "高市早苗"
		if request.Model == "blue" {
			output = "石破茂"
		}
		if len(request.Messages) > 0 {
			expectedEffort := map[string]string{"who": "low", "draw": "high", "another": ""}[request.Messages[0].Content]
			assert.Equal(t, expectedEffort, request.ReasoningEffort, "probe override reaches the actual upstream request")
		}
		if len(request.Messages) > 0 && request.Messages[0].Content == "draw" {
			output = "<html><svg/></html>"
		}
		delta, err := common.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": output}, "finish_reason": "stop"}}})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":4,\"total_tokens\":16}}\n\ndata: [DONE]\n\n", delta)
	}))
	defer upstream.Close()
	base := upstream.URL
	require.NoError(t, db.Create(&model.Channel{Id: 1, Name: "private provider", Type: constant.ChannelTypeOpenAI, Key: "secret-probe-key", BaseURL: &base, Group: "a,b", Models: "sol,broken,blue", Status: 1}).Error)
	plan := operation_setting.DegradationProbePlan{Enabled: true, Concurrency: 2, TimeoutSeconds: 30, Probes: []operation_setting.DegradationProbe{
		{ID: "sanae", Name: "Sanae", Kind: "text", Prompt: "who", Expected: "高市早苗", Match: "exact", IntervalMinutes: 5},
		{ID: "other", Name: "Other", Kind: "text", Prompt: "another", Expected: "uncertain", Match: "exact", IntervalMinutes: 5},
		{ID: "drawing", Name: "Drawing", Kind: "drawing", Prompt: "draw", IntervalMinutes: 60},
	}, Targets: []operation_setting.DegradationProbeTarget{
		{Group: "a", Model: "sol", ChannelID: 1, Enabled: true, Public: true, Probes: []operation_setting.DegradationProbeBinding{{ProbeID: "sanae", Enabled: true}, {ProbeID: "drawing", Enabled: true}}},
		{Group: "b", Model: "sol", ChannelID: 1, Enabled: true, Public: true, Probes: []operation_setting.DegradationProbeBinding{{ProbeID: "other", Enabled: true}}},
		{Group: "a", Model: "broken", ChannelID: 1, Enabled: true, Probes: []operation_setting.DegradationProbeBinding{{ProbeID: "sanae", Enabled: true}}},
	}}
	low, defaultEffort := "low", ""
	plan.Targets[0].ReasoningEffort = "high"
	plan.Targets[0].Probes[0].ReasoningEffort = &low
	plan.Targets[1].ReasoningEffort = "high"
	plan.Targets[1].Probes[0].ReasoningEffort = &defaultEffort
	raw, err := common.Marshal(plan)
	require.NoError(t, err)
	setting.ProbePlan = string(raw)
	service.InitHttpClient()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, kind := range []string{"text", "drawing"} {
		task := &model.SystemTask{TaskID: "probe-" + kind, Type: "degradation_probe_text", Payload: "{}", Status: model.SystemTaskStatusRunning}
		if kind == "drawing" {
			task.Type = model.SystemTaskTypeDegradationWatch
		}
		require.NoError(t, db.Create(task).Error)
		summary, err := executeDegradationProbes(ctx, task, "test", kind)
		require.NoError(t, err)
		assert.Equal(t, 1, summary.Succeeded)
	}
	var rows []model.DegradationWatchRecord
	require.NoError(t, db.Order("id asc").Find(&rows).Error)
	require.Len(t, rows, 4)
	assert.Equal(t, "passed", rows[0].Verdict)
	assert.Equal(t, "a", rows[0].GroupName)
	assert.Equal(t, "who", string(rows[0].PromptSnapshot))
	assert.Equal(t, "low", rows[0].ReasoningEffort)
	assert.Equal(t, "高市早苗", string(rows[0].ExpectedSnapshot))
	assert.Equal(t, 12, rows[0].PromptTokens)
	assert.Equal(t, 4, rows[0].CompletionTokens)
	assert.False(t, rows[0].TokensEstimated)
	assert.Equal(t, "mismatch", rows[1].Verdict)
	assert.Equal(t, "b", rows[1].GroupName)
	assert.Equal(t, "another", string(rows[1].PromptSnapshot))
	assert.Empty(t, rows[1].ReasoningEffort)
	assert.Equal(t, "error", rows[2].Verdict)
	assert.Contains(t, string(rows[2].ErrorDetails), "final-error-line")
	assert.NotContains(t, string(rows[2].ErrorDetails), "secret-probe-key")
	assert.Equal(t, "passed", rows[3].Verdict)
	assert.Equal(t, "<html><svg/></html>", string(rows[3].Html))
	assert.Equal(t, "high", rows[3].ReasoningEffort)
	_, activity, err := model.GetDegradationWatchActivity()
	require.NoError(t, err)
	assert.Len(t, activity, 4)

	// A blue result creates its own drawing even with periodic drawing disabled.
	plan.Targets = plan.Targets[:1]
	plan.Targets[0].Model = "blue"
	plan.Targets[0].Probes[1].Enabled = false
	raw, err = common.Marshal(plan)
	require.NoError(t, err)
	setting.ProbePlan = string(raw)
	textTask := &model.SystemTask{TaskID: "blue-text", Type: "degradation_probe_text", Payload: "{}", Status: model.SystemTaskStatusRunning}
	require.NoError(t, db.Create(textTask).Error)
	_, err = executeDegradationProbes(ctx, textTask, "test", "text")
	require.NoError(t, err)
	var parent, child model.DegradationWatchRecord
	require.NoError(t, db.Where("model_name = ? AND probe_kind = ?", "blue", "text").First(&parent).Error)
	assert.Equal(t, "intermediate", parent.Verdict)
	require.NoError(t, db.Where("trigger_record_id = ?", parent.Id).First(&child).Error)
	assert.Equal(t, "queued", child.Status)
	assert.Equal(t, model.LongText("draw"), child.PromptSnapshot)
	assert.Equal(t, "high", child.ReasoningEffort)
	var followup model.SystemTask
	require.NoError(t, db.Where("type = ?", "degradation_probe_followup").First(&followup).Error)
	require.NoError(t, executeBlueProbeDrawings(ctx, &followup))
	require.NoError(t, db.First(&child, child.Id).Error)
	assert.Equal(t, "succeeded", child.Status)
	assert.Equal(t, model.LongText("<html><svg/></html>"), child.Html)
	assert.Equal(t, 12, child.PromptTokens)
	assert.Equal(t, 4, child.CompletionTokens)
	require.NoError(t, executeBlueProbeDrawings(ctx, &followup))
	var linkedCount int64
	require.NoError(t, db.Model(&model.DegradationWatchRecord{}).Where("trigger_record_id = ?", parent.Id).Count(&linkedCount).Error)
	assert.EqualValues(t, 1, linkedCount)
	assert.True(t, canViewDegradationProbeRecord(&child))
	private := false
	plan.Targets[0].Probes[1].Public = &private
	raw, err = common.Marshal(plan)
	require.NoError(t, err)
	setting.ProbePlan = string(raw)
	assert.False(t, canViewDegradationProbeRecord(&child), "a public blue probe cannot expose a private drawing")
	plan.Targets[0].Probes[1].Public = nil
	raw, err = common.Marshal(plan)
	require.NoError(t, err)
	setting.ProbePlan = string(raw)
	require.NoError(t, model.SetDegradationWatchRecordHidden(parent.Id, true))
	assert.False(t, canViewDegradationProbeRecord(&child), "a hidden source probe cannot expose a linked drawing")
	parent.Id, parent.Status, parent.Hidden = 0, "running", false
	require.NoError(t, model.CreateDegradationWatchRecord(&parent))
	failedDrawing := blueProbeDrawingRecord(&plan, plan.Targets[0], &parent)
	require.NoError(t, model.FinishDegradationWatchRecordAndQueueDrawing(&parent, failedDrawing))
	require.NoError(t, db.Model(&model.Channel{}).Where("id = ?", 1).Update("status", 2).Error)
	require.NoError(t, executeBlueProbeDrawings(ctx, &followup))
	require.NoError(t, db.First(failedDrawing, failedDrawing.Id).Error)
	assert.Equal(t, "failed", failedDrawing.Status)
	assert.Contains(t, string(failedDrawing.ErrorDetails), "source channel")
}

func TestSaveDegradationProbePlanRejectsInvalidTargetsAndDatabaseFailure(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	previous := model.DB
	model.DB = db
	setting := operation_setting.GetDegradationWatchSetting()
	saved := *setting
	optionMap := common.OptionMap
	common.OptionMap = map[string]string{}
	t.Cleanup(func() { model.DB = previous; *setting = saved; common.OptionMap = optionMap; _ = sqlDB.Close() })
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.Option{}))
	require.NoError(t, db.Create(&model.Channel{Id: 1, Group: "alpha", Models: "sol", Status: 1}).Error)
	plan := operation_setting.DegradationProbePlan{Concurrency: 2, TimeoutSeconds: 1200, Targets: []operation_setting.DegradationProbeTarget{{ChannelID: 1, Group: "alpha", Model: "sol", Public: true}}}
	raw, err := common.Marshal(plan)
	require.NoError(t, err)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("PUT", "/probe-plan", strings.NewReader(string(raw)))
	SaveDegradationProbePlan(c)
	require.Contains(t, w.Body.String(), `"success":true`)
	assert.Equal(t, string(raw), setting.ProbePlan)
	plan.Targets[0].Group = "not-a-channel-group"
	invalid, err := common.Marshal(plan)
	require.NoError(t, err)
	w = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("PUT", "/probe-plan", strings.NewReader(string(invalid)))
	SaveDegradationProbePlan(c)
	assert.Contains(t, w.Body.String(), `"success":false`)
	assert.Equal(t, string(raw), setting.ProbePlan)
	require.NoError(t, db.Migrator().DropTable(&model.Option{}))
	plan.Targets[0].Group = "alpha"
	plan.Concurrency = 3
	updated, err := common.Marshal(plan)
	require.NoError(t, err)
	w = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("PUT", "/probe-plan", strings.NewReader(string(updated)))
	SaveDegradationProbePlan(c)
	assert.Contains(t, w.Body.String(), `"success":false`)
	assert.Equal(t, string(raw), setting.ProbePlan)
}

func TestDegradationProbeGrades(t *testing.T) {
	custom, disabled, duplicate := "石破茂", "", "高市早苗"
	for _, tc := range []struct {
		name, expected, output, match, verdict string
		blue                                   *string
	}{
		{"green", "高市早苗", " 高市早苗\n", "exact", "passed", nil},
		{"default blue", "高市早苗", "\n石破茂 ", "exact", "intermediate", nil},
		{"red", "高市早苗", "uncertain", "exact", "mismatch", nil},
		{"empty answer", "高市早苗", "", "exact", "mismatch", nil},
		{"exact blue", "高市早苗", "石破茂。", "exact", "mismatch", nil},
		{"contains blue", "高市早苗", "答案是石破茂。", "contains", "intermediate", nil},
		{"green priority", "高市早苗", "石破茂、高市早苗", "contains", "passed", nil},
		{"explicitly disabled", "高市早苗", "石破茂", "exact", "mismatch", &disabled},
		{"generic probe", "yes", "石破茂", "exact", "mismatch", nil},
		{"custom blue", "yes", "石破茂", "exact", "intermediate", &custom},
	} {
		t.Run(tc.name, func(t *testing.T) {
			probe := operation_setting.DegradationProbe{Kind: "text", Expected: tc.expected, IntermediateExpected: tc.blue, Match: tc.match}
			record := &model.DegradationWatchRecord{}
			evaluateDegradationProbe(record, probe, tc.output)
			assert.Equal(t, tc.verdict, record.Verdict)
			assert.Equal(t, tc.verdict == "passed", record.Success)
			if tc.verdict == "intermediate" {
				assert.Empty(t, record.FailureReason)
			}
		})
	}
	for _, tc := range []struct {
		blue  *string
		valid bool
	}{{nil, true}, {&disabled, true}, {&custom, true}, {&duplicate, false}} {
		plan := operation_setting.DegradationProbePlan{Concurrency: 1, TimeoutSeconds: 1200, Probes: []operation_setting.DegradationProbe{{ID: "sanae", Name: "Sanae", Kind: "text", Prompt: "who", Expected: "高市早苗", IntermediateExpected: tc.blue, Match: "exact", IntervalMinutes: 3}}}
		raw, err := common.Marshal(plan)
		require.NoError(t, err)
		_, err = operation_setting.ParseDegradationProbePlan(string(raw))
		assert.Equal(t, tc.valid, err == nil)
	}
}

func TestDegradationProbeGradingDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		for _, upgrade := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/upgrade=%t", dialect, upgrade), func(t *testing.T) {
				db := selfTestDB(t, dialect)
				require.NoError(t, db.AutoMigrate(&model.Channel{}))
				var version string
				if dialect == "sqlite" {
					require.NoError(t, db.Raw("SELECT sqlite_version()").Scan(&version).Error)
				} else {
					require.NoError(t, db.Raw("SELECT version()").Scan(&version).Error)
				}
				t.Logf("database version: %s", version)
				schemas := []struct {
					table string
					value any
					added string
				}{
					{"degradation_watch_records", &model.DegradationWatchRecord{}, "TriggerRecordID"},
					{"temporary_monitors", &model.TemporaryMonitor{}, ""},
					{"temporary_monitor_attempts", &model.TemporaryMonitorAttempt{}, "TriggerAttemptID"},
				}
				for _, schema := range schemas {
					require.NoError(t, db.Migrator().DropTable(schema.value))
				}
				now := common.GetTimestamp()
				secret, err := service.EncryptSelfTestKey(1, "https://example.com/v1:chat", "fixture-key")
				require.NoError(t, err)
				monitor := model.TemporaryMonitor{UserID: 1, Name: "existing", Status: "running", CreatedAt: now, EndsAt: now + 86400, BaseURL: "https://example.com/v1", Model: "model", Protocol: "chat", Secret: model.LongText(secret), TextPrompt: "who", TextExpected: "高市早苗"}
				oldRecord := model.DegradationWatchRecord{ChannelId: 1, GroupName: "a", ModelName: "model", ProbeID: "sanae", ProbeKind: "text", Status: "failed", Verdict: "mismatch", CreatedAt: now, OutputText: "石破茂", PromptSnapshot: "old prompt", ExpectedSnapshot: "高市早苗"}
				oldAttempt := model.TemporaryMonitorAttempt{Kind: "text", Slot: 1, Verdict: "mismatch", Prompt: "old prompt", Expected: "高市早苗", PromptCaptured: true, SelfTestAttempt: model.SelfTestAttempt{Status: "failed", Output: "石破茂", CreatedAt: now - 300}}
				if upgrade {
					// custom-v1.0.0-rc.39.34 has these models without the trigger link fields.
					// Retain every released tag, embedded field and index in the upgrade fixture.
					for _, schema := range schemas {
						current := reflect.TypeOf(schema.value).Elem()
						fields := []reflect.StructField{}
						for i := range current.NumField() {
							field := current.Field(i)
							if field.Name != schema.added {
								fields = append(fields, field)
							}
						}
						released := reflect.New(reflect.StructOf(fields)).Interface()
						require.NoError(t, db.Table(schema.table).AutoMigrate(released))
					}
					require.NoError(t, db.Omit("TextIntermediateExpected").Create(&monitor).Error)
					require.NoError(t, db.Omit("TriggerRecordID").Create(&oldRecord).Error)
					oldAttempt.MonitorID = monitor.ID
					require.NoError(t, db.Omit("TriggerAttemptID").Create(&oldAttempt).Error)
				}
				for range 2 {
					require.NoError(t, db.AutoMigrate(&model.DegradationWatchRecord{}, &model.TemporaryMonitor{}, &model.TemporaryMonitorAttempt{}))
				}
				require.True(t, db.Migrator().HasIndex(&model.TemporaryMonitorAttempt{}, "idx_temp_monitor_slot"))
				require.True(t, db.Migrator().HasIndex(&model.TemporaryMonitorAttempt{}, "idx_temporary_monitor_attempts_trigger_attempt_id"))
				require.True(t, db.Migrator().HasIndex(&model.DegradationWatchRecord{}, "idx_degradation_watch_records_trigger_record_id"))
				if upgrade {
					var preserved model.DegradationWatchRecord
					require.NoError(t, db.First(&preserved, oldRecord.Id).Error)
					assert.Equal(t, "mismatch", preserved.Verdict)
					assert.Equal(t, model.LongText("石破茂"), preserved.OutputText)
					assert.Empty(t, preserved.IntermediateExpectedSnapshot)
					require.NoError(t, db.First(&monitor, monitor.ID).Error)
					assert.Nil(t, monitor.TextIntermediateExpected)
					duplicate := oldAttempt
					duplicate.ID = 0
					assert.Error(t, db.Omit("ID").Create(&duplicate).Error, "slot uniqueness survives migration")
				} else {
					require.NoError(t, model.CreateTemporaryMonitor(&monitor))
				}
				// Exercise the worker: a blue response is completed normally, with snapshotted rules.
				require.NoError(t, db.Model(&monitor).Update("drawing_disabled", true).Error)
				oldClient := selfTestClient
				t.Cleanup(func() { selfTestClient = oldClient })
				selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"石破茂"},"finish_reason":"stop"}]}`))}, nil
				})}
				attempt, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "grade-worker", now)
				require.NoError(t, err)
				require.NotNil(t, attempt)
				assert.Equal(t, model.LongText("石破茂"), attempt.IntermediateExpected)
				runTemporaryMonitorAttempt(context.Background(), monitor, *attempt, "grade-worker")
				var finished model.TemporaryMonitorAttempt
				require.NoError(t, db.First(&finished, attempt.ID).Error)
				assert.Equal(t, "intermediate", finished.Verdict)
				assert.Equal(t, "succeeded", finished.Status)
				assert.Empty(t, finished.Error)
				detail := selfTestAPI(t, GetTemporaryMonitorAttempt, 1, attempt.ID, nil)
				require.Equal(t, 200, detail.Code)
				assert.Contains(t, detail.Body.String(), `"intermediate_expected":"石破茂"`)
				assert.Contains(t, detail.Body.String(), `"linked_drawing":`)
				var linked []model.TemporaryMonitorAttempt
				require.NoError(t, db.Where("trigger_attempt_id = ?", attempt.ID).Find(&linked).Error)
				require.Len(t, linked, 1)
				assert.Equal(t, "queued", linked[0].Status)
				assert.Negative(t, linked[0].Slot, "does not move the periodic schedule")
				require.NoError(t, model.UpdateTemporaryMonitorAttempt(*attempt, "grade-worker", map[string]any{"status": "succeeded", "verdict": "intermediate"}, true))
				var linkCount int64
				require.NoError(t, db.Model(&model.TemporaryMonitorAttempt{}).Where("trigger_attempt_id = ?", attempt.ID).Count(&linkCount).Error)
				assert.Equal(t, int64(1), linkCount, "replayed completion cannot duplicate the drawing")
				drawing, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "drawing", "grade-worker", now)
				require.NoError(t, err)
				require.NotNil(t, drawing)
				assert.Equal(t, linked[0].ID, drawing.ID, "disabled schedule still runs the dedicated blue follow-up")
				busy, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "drawing", "another-worker", now)
				require.NoError(t, err)
				assert.Nil(t, busy)
				// Updates affect future attempts only; blank explicitly disables the blue grade.
				disabled := ""
				require.NoError(t, model.UpdateTemporaryMonitorPrompt(monitor.ID, "text", "new prompt", "高市早苗", &disabled, now+1))
				require.NoError(t, db.First(&monitor, monitor.ID).Error)
				require.NotNil(t, monitor.TextIntermediateExpected)
				assert.Empty(t, *monitor.TextIntermediateExpected)
				require.NoError(t, db.First(&finished, attempt.ID).Error)
				assert.Equal(t, model.LongText("石破茂"), finished.IntermediateExpected)
				next, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "grade-worker", now+181)
				require.NoError(t, err)
				require.NotNil(t, next)
				assert.Empty(t, next.IntermediateExpected)
				custom := "blue"
				require.NoError(t, model.UpdateTemporaryMonitorPrompt(monitor.ID, "text", "new prompt", "green", &custom, now+2))
				assert.Error(t, model.UpdateTemporaryMonitorPrompt(monitor.ID, "text", "new prompt", "blue", nil, now+3), "omitted blue must not bypass collision validation")
				// Formal history keeps intermediate, passed, mismatch and request errors disjoint.
				series := model.DegradationProbeSeries{ChannelID: 2, GroupName: "grade", Model: "model", ProbeID: "sanae"}
				for _, answer := range []string{"高市早苗", "石破茂", "uncertain"} {
					record := model.DegradationWatchRecord{ChannelId: 2, GroupName: "grade", ModelName: "model", ProbeID: "sanae", ProbeKind: "text", Status: "running", CreatedAt: now, PromptSnapshot: "who", ExpectedSnapshot: "高市早苗", IntermediateExpectedSnapshot: "石破茂", OutputText: model.LongText(answer)}
					require.NoError(t, model.CreateDegradationWatchRecord(&record))
					evaluateDegradationProbe(&record, operation_setting.DegradationProbe{Kind: "text", Expected: "高市早苗", Match: "exact"}, answer)
					require.NoError(t, model.FinishDegradationWatchRecord(&record))
					content, err := model.GetDegradationProbeContent(record.Id)
					require.NoError(t, err)
					assert.Equal(t, model.LongText("石破茂"), content.IntermediateExpectedSnapshot)
					if answer == "石破茂" {
						assert.Equal(t, "succeeded", record.Status)
						assert.False(t, record.Success)
						// A blue result and its child commit together; scheduled attempts
						// never satisfy or replace the one-to-one link.
						parent := record
						parent.Id, parent.Status = 0, "running"
						require.NoError(t, model.CreateDegradationWatchRecord(&parent))
						child := &model.DegradationWatchRecord{ChannelId: 2, GroupName: "grade", ModelName: "model", ProbeID: "drawing", ProbeKind: "drawing", PromptSnapshot: "draw", CreatedAt: now}
						require.NoError(t, model.FinishDegradationWatchRecordAndQueueDrawing(&parent, child))
						require.NoError(t, model.FinishDegradationWatchRecordAndQueueDrawing(&parent, child))
						var count int64
						require.NoError(t, db.Model(&model.DegradationWatchRecord{}).Where("trigger_record_id = ?", parent.Id).Count(&count).Error)
						assert.Equal(t, int64(1), count)
						require.NoError(t, model.FailInterruptedDegradationWatchRecords())
						require.NoError(t, db.First(child, child.Id).Error)
						assert.Equal(t, "queued", child.Status, "queued trigger survives dispatcher downtime")
						last, err := model.LastDegradationProbeAttempt(model.DegradationProbeSeries{ChannelID: 2, GroupName: "grade", Model: "model", ProbeID: "drawing"})
						require.NoError(t, err)
						assert.Zero(t, last, "triggered draws do not postpone scheduled drawing")
						busyDrawing := model.DegradationWatchRecord{ChannelId: 2, ModelName: "model", ProbeKind: "drawing", Status: "running"}
						require.NoError(t, db.Create(&busyDrawing).Error)
						claimed, err := model.ClaimBlueProbeDrawing(child.Id, "drawing-worker")
						require.NoError(t, err)
						assert.False(t, claimed, "an existing drawing keeps the follow-up queued")
						require.NoError(t, db.Delete(&busyDrawing).Error)
						claimed, err = model.ClaimBlueProbeDrawing(child.Id, "drawing-worker")
						require.NoError(t, err)
						assert.True(t, claimed)
						claimed, err = model.ClaimBlueProbeDrawing(child.Id, "another-worker")
						require.NoError(t, err)
						assert.False(t, claimed, "a linked drawing is claimed only once")
						require.NoError(t, db.Delete(&parent).Error)
					}
				}
				require.NoError(t, model.CreateDegradationWatchRecord(&model.DegradationWatchRecord{ChannelId: 2, GroupName: "grade", ModelName: "model", ProbeID: "sanae", ProbeKind: "text", Status: "failed", Verdict: "error", FailureReason: "timeout", CreatedAt: now}))
				records, stats, _, err := model.GetDegradationProbeHistory(series, now-1, 0, 20, true)
				require.NoError(t, err)
				require.Len(t, records, 4)
				assert.Equal(t, int64(1), stats.Passed)
				assert.Equal(t, int64(1), stats.Intermediate)
				assert.Equal(t, int64(1), stats.Mismatched)
				assert.Equal(t, int64(1), stats.Errors)
			})
		}
	}
}
