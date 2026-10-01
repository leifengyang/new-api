package controller

import (
	"context"
	"fmt"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/service"
	"net/http"
	"net/http/httptest"
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
	assert.Equal(t, "Alpha", user.ChannelTitle)
	assert.True(t, user.Aliased)
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
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Channel{}, &model.DegradationWatchRecord{}, &model.SystemTask{}))
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
	require.NoError(t, db.AutoMigrate(&model.DegradationWatchRecord{}, &model.SystemTask{}))
	slow := &model.DegradationWatchRecord{ChannelId: 1, ModelName: "slow", FailureReason: "upstream_error", ErrorDetails: "full private upstream diagnostic", OutputText: "partial output"}
	require.NoError(t, model.CreateDegradationWatchRecord(slow))
	for range 12 {
		require.NoError(t, model.CreateDegradationWatchRecord(&model.DegradationWatchRecord{ChannelId: 1, ModelName: "fast"}))
	}
	for _, admin := range []bool{false, true} {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("GET", "/api/degradation_watch/wall?model=slow", nil)
		if admin {
			c.Set("role", common.RoleAdminUser)
		}
		GetDegradationWatchWall(c)
		var result struct {
			Success bool
			Data    struct {
				Records []degradationWatchRecordItem `json:"records"`
			}
		}
		require.NoError(t, common.Unmarshal(w.Body.Bytes(), &result))
		require.True(t, result.Success, w.Body.String())
		require.Len(t, result.Data.Records, 1)
		assert.Equal(t, slow.Id, result.Data.Records[0].Id)
		if admin {
			assert.Equal(t, string(slow.ErrorDetails), result.Data.Records[0].ErrorDetails)
		} else {
			assert.Empty(t, result.Data.Records[0].ErrorDetails)
			assert.Zero(t, result.Data.Records[0].ChannelId)
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
