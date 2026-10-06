package controller

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

func temporaryRewriterFixture(t *testing.T) {
	t.Helper()
	require.NoError(t, model.DB.AutoMigrate(&model.Option{}))
	secret, err := service.EncryptSelfTestKey(1, "https://example.org/v1:chat", "rewrite-private-key")
	require.NoError(t, err)
	limit := uint(4096)
	require.NoError(t, model.SaveTemporaryMonitorRewriter(model.SelfTestProfile{UserID: 1, Name: "Dedicated rewriter", BaseURL: "https://example.org/v1", Model: "rewriter-model", Protocol: "chat", Effort: "minimal", MaxOutputTokens: &limit, Secret: model.LongText(secret)}))
}

func TestTemporaryMonitorDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := selfTestDB(t, dialect)
			temporaryRewriterFixture(t)
			// Upgrade a representative released self-test schema with retained data.
			previous := model.SelfTestProfile{UserID: 1, Name: "retained profile", BaseURL: "https://example.com/v1", Model: "previous"}
			require.NoError(t, db.Create(&previous).Error)
			require.NoError(t, db.Migrator().DropTable(&model.TemporaryMonitorAttempt{}, &model.TemporaryMonitor{}))
			// Released .31 schema, before editable prompts and input snapshots.
			legacy := struct {
				ID                     int
				UserID                 int    `gorm:"index"`
				Name                   string `gorm:"size:128"`
				BaseURL                string `gorm:"size:1024"`
				Model                  string `gorm:"size:128"`
				Protocol               string `gorm:"size:32"`
				TextEffort             string `gorm:"size:32"`
				DrawingEffort          string `gorm:"size:32"`
				MaxOutputTokens        *uint
				Secret                 model.LongText
				DrawingPrompt          model.LongText
				TextDisabled           bool
				DrawingDisabled        bool
				TextIntervalMinutes    int
				DrawingIntervalMinutes int
				Status                 string `gorm:"size:16;index"`
				CreatedAt              int64
				EndsAt                 int64 `gorm:"index"`
			}{UserID: 1, Name: "released monitor", Status: "stopped", Secret: "preserved encrypted key", DrawingPrompt: "retained prompt", EndsAt: common.GetTimestamp() + 86400}
			require.NoError(t, db.Table("temporary_monitors").AutoMigrate(&legacy))
			require.NoError(t, db.Table("temporary_monitors").Create(&legacy).Error)
			legacyAttempt := struct {
				model.SelfTestAttempt `gorm:"embedded"`
				MonitorID             int    `gorm:"uniqueIndex:idx_temp_monitor_slot;index"`
				Kind                  string `gorm:"size:16;uniqueIndex:idx_temp_monitor_slot"`
				Slot                  int64  `gorm:"uniqueIndex:idx_temp_monitor_slot"`
				Verdict               string `gorm:"size:16"`
			}{MonitorID: legacy.ID, Kind: "drawing", Verdict: "passed", SelfTestAttempt: model.SelfTestAttempt{Status: "succeeded", Output: "retained artwork"}}
			require.NoError(t, db.Table("temporary_monitor_attempts").AutoMigrate(&legacyAttempt))
			require.NoError(t, db.Table("temporary_monitor_attempts").Create(&legacyAttempt).Error)
			for range 2 {
				require.NoError(t, db.AutoMigrate(&model.TemporaryMonitor{}, &model.TemporaryMonitorAttempt{}))
			}
			var upgraded model.TemporaryMonitor
			require.NoError(t, db.First(&upgraded, legacy.ID).Error)
			assert.Equal(t, legacy.Secret, upgraded.Secret)
			assert.Equal(t, legacy.DrawingPrompt, upgraded.DrawingPrompt)
			textDefaults, err := upgraded.ProbeSettings("text")
			require.NoError(t, err)
			assert.Equal(t, model.TemporaryProbeSettings{Enabled: true, IntervalMinutes: 3}, textDefaults)
			drawingDefaults, err := upgraded.ProbeSettings("drawing")
			require.NoError(t, err)
			assert.Equal(t, model.TemporaryProbeSettings{Enabled: true, IntervalMinutes: 10}, drawingDefaults)
			require.NoError(t, db.Model(&upgraded).Update("status", "running").Error)
			require.NoError(t, model.UpdateTemporaryMonitorPrompt(upgraded.ID, "drawing", "new template", "", common.GetTimestamp()))
			legacyDetail := selfTestAPI(t, GetTemporaryMonitorAttempt, 1, legacyAttempt.ID, nil)
			require.Equal(t, 200, legacyDetail.Code, legacyDetail.Body.String())
			assert.Equal(t, "retained prompt", gjson.Get(legacyDetail.Body.String(), "data.prompt").String())
			assert.Equal(t, "retained artwork", gjson.Get(legacyDetail.Body.String(), "data.output").String())
			require.NoError(t, db.Where("monitor_id = ?", upgraded.ID).Delete(&model.TemporaryMonitorAttempt{}).Error)
			require.NoError(t, db.Delete(&upgraded).Error)
			assert.False(t, (temporaryMonitorHandler{}).Enabled())
			var retained model.SelfTestProfile
			require.NoError(t, db.First(&retained, previous.ID).Error)
			assert.Equal(t, previous.Name, retained.Name)
			var version string
			query := "SELECT version()"
			if dialect == "sqlite" {
				query = "SELECT sqlite_version()"
			}
			require.NoError(t, db.Raw(query).Scan(&version).Error)
			t.Logf("%s version: %s", dialect, version)

			secret, err := service.EncryptSelfTestKey(1, "https://example.com/v1:chat", "temporary-private-key")
			require.NoError(t, err)
			now := common.GetTimestamp()
			monitor := model.TemporaryMonitor{UserID: 1, Name: "candidate", BaseURL: "https://example.com/v1", Model: "test-model", Protocol: "chat", TextEffort: "low", DrawingEffort: "high", Secret: model.LongText(secret), Status: "running", CreatedAt: now, EndsAt: now + 86400, DrawingPrompt: "draw a complete HTML SVG"}
			require.NoError(t, model.CreateTemporaryMonitor(&monitor))
			assert.True(t, (temporaryMonitorHandler{}).Enabled())
			for range 2 {
				require.NoError(t, db.AutoMigrate(&model.TemporaryMonitor{}, &model.TemporaryMonitorAttempt{}))
			}
			var stored model.TemporaryMonitor
			require.NoError(t, db.First(&stored, monitor.ID).Error)
			assert.Equal(t, monitor.Secret, stored.Secret)
			assert.NotContains(t, string(stored.Secret), "temporary-private-key")

			text, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "worker", now)
			require.NoError(t, err)
			require.NotNil(t, text)
			drawing, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "drawing", "worker", now)
			require.NoError(t, err)
			require.NotNil(t, drawing)
			assert.Equal(t, "low", text.Effort)
			assert.Equal(t, "high", drawing.Effort)
			require.NoError(t, model.UpdateTemporaryMonitorPrompt(monitor.ID, "text", "new question for later checks", "new answer", now))
			require.NoError(t, model.UpdateTemporaryMonitorPrompt(monitor.ID, "drawing", "new drawing template", "", now))
			var storedAttempt model.TemporaryMonitorAttempt
			require.NoError(t, db.First(&storedAttempt, text.ID).Error)
			assert.Empty(t, storedAttempt.Secret)
			duplicate := *text
			duplicate.ID = 0
			duplicate.Secret = ""
			assert.Error(t, db.Create(&duplicate).Error, "slot remains unique after repeated migration")
			overlap, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "worker", now+180)
			require.NoError(t, err)
			assert.Nil(t, overlap, "slow probes must not overlap")

			oldClient := selfTestClient
			t.Cleanup(func() { selfTestClient = oldClient })
			selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
				body, readErr := io.ReadAll(req.Body)
				require.NoError(t, readErr)
				if req.URL.Host == "example.org" {
					assert.Equal(t, "Bearer rewrite-private-key", req.Header.Get("Authorization"))
					assert.Equal(t, "rewriter-model", gjson.GetBytes(body, "model").String())
					assert.Equal(t, "minimal", gjson.GetBytes(body, "reasoning_effort").String())
					assert.Equal(t, int64(4096), gjson.GetBytes(body, "max_completion_tokens").Int())
				} else {
					assert.Equal(t, "Bearer temporary-private-key", req.Header.Get("Authorization"))
					assert.Equal(t, "test-model", gjson.GetBytes(body, "model").String())
				}
				output := "<html><svg/></html>"
				if gjson.GetBytes(body, "messages.0.content").String() == operation_setting.SanaeProbePrompt {
					assert.Equal(t, "low", gjson.GetBytes(body, "reasoning_effort").String())
					output = "高市早苗"
				} else {
					prompt := gjson.GetBytes(body, "messages.0.content").String()
					if strings.Contains(prompt, "<原始提示词>") {
						assert.Contains(t, prompt, string(monitor.DrawingPrompt))
						assert.NotContains(t, prompt, "new drawing template")
						output = "Draw " + drawing.Subject + " in a complete HTML SVG"
					} else {
						assert.Equal(t, "high", gjson.GetBytes(body, "reasoning_effort").String())
						assert.Equal(t, "Draw "+drawing.Subject+" in a complete HTML SVG", prompt)
					}
				}
				raw, marshalErr := common.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": output}, "finish_reason": "stop"}}, "usage": map[string]any{"prompt_tokens": 15, "completion_tokens": 8}})
				require.NoError(t, marshalErr)
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
			})}
			runTemporaryMonitorAttempt(context.Background(), monitor, *text, "worker")
			runTemporaryMonitorAttempt(context.Background(), monitor, *drawing, "worker")
			require.NoError(t, db.First(&storedAttempt, text.ID).Error)
			assert.Equal(t, "passed", storedAttempt.Verdict)
			assert.Equal(t, 15, storedAttempt.InputTokens)
			assert.Equal(t, "高市早苗", string(storedAttempt.Output))
			var artwork model.TemporaryMonitorAttempt
			require.NoError(t, db.First(&artwork, drawing.ID).Error)
			assert.Equal(t, "passed", artwork.Verdict)
			assert.Equal(t, "Draw "+drawing.Subject+" in a complete HTML SVG", string(artwork.Prompt))
			assert.Equal(t, int64(15), gjson.Get(string(artwork.RewriteResult), "input_tokens").Int())
			assert.NotContains(t, string(artwork.RewriteResult), "temporary-private-key")
			assert.NotContains(t, string(artwork.RewriteResult), "rewrite-private-key")
			history := selfTestAPI(t, GetTemporaryMonitor, 1, monitor.ID, nil)
			require.Equal(t, 200, history.Code, history.Body.String())
			assert.Equal(t, int64(1), gjson.Get(history.Body.String(), "data.stats.0.count").Int())
			assert.Empty(t, gjson.Get(history.Body.String(), "data.attempts.0.output").String())
			for _, tc := range []struct {
				kind   string
				offset int64
				due    bool
			}{{"text", 179, false}, {"text", 180, true}, {"drawing", 599, false}, {"drawing", 600, true}} {
				attempt, claimErr := model.ClaimTemporaryMonitorAttempt(monitor.ID, tc.kind, "worker", now+tc.offset)
				require.NoError(t, claimErr)
				if tc.due {
					require.NotNil(t, attempt)
				} else {
					assert.Nil(t, attempt)
				}
			}
			// New lease marks interrupted attempts, but never replays their paid slot.
			require.NoError(t, model.MaintainTemporaryMonitors(now+601, "replacement"))
			replay, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "drawing", "replacement", now+601)
			require.NoError(t, err)
			assert.Nil(t, replay)
			next, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "replacement", now+720)
			require.NoError(t, err)
			require.NotNil(t, next)
			require.NoError(t, model.StopTemporaryMonitor(monitor.ID))
			assert.False(t, (temporaryMonitorHandler{}).Enabled())
			require.NoError(t, db.First(&stored, monitor.ID).Error)
			assert.Equal(t, "stopped", stored.Status)
			assert.Empty(t, stored.Secret)
			// Late workers cannot replace a cancellation with success.
			runTemporaryMonitorAttempt(context.Background(), monitor, *next, "replacement")
			var stopped model.TemporaryMonitorAttempt
			require.NoError(t, db.First(&stopped, next.ID).Error)
			assert.Equal(t, "cancelled", stopped.Status)

			monitor.ID = 0
			monitor.Secret = model.LongText(secret)
			require.NoError(t, model.CreateTemporaryMonitor(&monitor))
			require.NoError(t, model.MaintainTemporaryMonitors(monitor.EndsAt, "replacement"))
			after, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "replacement", monitor.EndsAt)
			require.NoError(t, err)
			assert.Nil(t, after)
			var expired model.TemporaryMonitor
			require.NoError(t, db.First(&expired, monitor.ID).Error)
			assert.Equal(t, "completed", expired.Status)
			assert.Empty(t, expired.Secret)
			require.NoError(t, model.MaintainTemporaryMonitors(monitor.EndsAt+model.DegradationWatchRetentionSeconds+1, "replacement"))
			var count int64
			require.NoError(t, db.Model(&model.TemporaryMonitor{}).Count(&count).Error)
			assert.Zero(t, count)
			require.NoError(t, db.Model(&model.TemporaryMonitorAttempt{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}

func TestTemporaryMonitorIndependentProbeControls(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := selfTestDB(t, dialect)
			require.NoError(t, db.Migrator().DropTable(&model.TemporaryMonitorAttempt{}, &model.TemporaryMonitor{}))
			for range 2 {
				require.NoError(t, db.AutoMigrate(&model.TemporaryMonitor{}, &model.TemporaryMonitorAttempt{}))
			}
			now := common.GetTimestamp()
			monitor := model.TemporaryMonitor{UserID: 1, Status: "running", CreatedAt: now, EndsAt: now + 86400, Secret: "fixture", TextEffort: "low", DrawingEffort: "high"}
			require.NoError(t, model.CreateTemporaryMonitor(&monitor))
			settings := model.TemporaryProbeSettings{Enabled: false, IntervalMinutes: 7}
			require.NoError(t, model.UpdateTemporaryMonitorProbe(monitor.ID, "text", settings, now))
			text, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "worker", now)
			require.NoError(t, err)
			assert.Nil(t, text, "disabled probe must not run automatically")
			drawing, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "drawing", "worker", now)
			require.NoError(t, err)
			require.NotNil(t, drawing, "text settings must not disable drawing")
			manual, err := model.QueueTemporaryMonitorProbe(monitor.ID, "text", now)
			require.NoError(t, err)
			assert.Equal(t, "queued", manual.Status)
			assert.Empty(t, manual.Secret)
			duplicate, err := model.QueueTemporaryMonitorProbe(monitor.ID, "text", now)
			require.NoError(t, err)
			assert.Equal(t, manual.ID, duplicate.ID)
			require.NoError(t, model.MaintainTemporaryMonitors(now, "worker"))
			claimed, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "worker", now)
			require.NoError(t, err)
			require.NotNil(t, claimed, "disabled probes still allow a queued manual run")
			assert.Equal(t, manual.ID, claimed.ID)
			assert.Equal(t, "low", claimed.Effort)
			overlap, err := model.QueueTemporaryMonitorProbe(monitor.ID, "text", now+1)
			require.NoError(t, err)
			assert.Equal(t, manual.ID, overlap.ID, "do not overlap manual runs")
			require.NoError(t, db.Model(claimed).Update("status", "succeeded").Error)
			settings.Enabled = true
			require.NoError(t, model.UpdateTemporaryMonitorProbe(monitor.ID, "text", settings, now))
			auto, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "worker", now)
			require.NoError(t, err)
			require.NotNil(t, auto, "manual run does not consume the automatic schedule")
			require.NoError(t, db.Model(auto).Update("status", "succeeded").Error)
			for _, offset := range []int64{180, 419} {
				attempt, claimErr := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "worker", now+offset)
				require.NoError(t, claimErr)
				assert.Nil(t, attempt)
			}
			due, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "worker", now+420)
			require.NoError(t, err)
			require.NotNil(t, due)
			require.NoError(t, db.Model(due).Update("status", "succeeded").Error)
			settings.IntervalMinutes = 2
			require.NoError(t, model.UpdateTemporaryMonitorProbe(monitor.ID, "text", settings, now+420))
			next, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "worker", now+540)
			require.NoError(t, err)
			require.NotNil(t, next, "shortened intervals must not collide with old slots")
			for _, interval := range []int{0, -1, 1441} {
				assert.Error(t, model.UpdateTemporaryMonitorProbe(monitor.ID, "text", model.TemporaryProbeSettings{Enabled: true, IntervalMinutes: interval}, now))
			}
			_, err = model.QueueTemporaryMonitorProbe(monitor.ID, "unknown", now)
			assert.Error(t, err)
			_, err = model.QueueTemporaryMonitorProbe(monitor.ID, "drawing", monitor.EndsAt)
			assert.Error(t, err, "expired monitors must not allow a manual request")
			require.NoError(t, model.StopTemporaryMonitor(monitor.ID))
			_, err = model.QueueTemporaryMonitorProbe(monitor.ID, "text", now)
			assert.Error(t, err)
			assert.Error(t, model.UpdateTemporaryMonitorProbe(monitor.ID, "drawing", settings, now))
		})
	}
}

func TestTemporaryMonitorEditablePromptSnapshots(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := selfTestDB(t, dialect)
			require.NoError(t, db.Migrator().DropTable(&model.TemporaryMonitorAttempt{}, &model.TemporaryMonitor{}))
			require.NoError(t, db.AutoMigrate(&model.TemporaryMonitor{}, &model.TemporaryMonitorAttempt{}))
			now := common.GetTimestamp()
			monitor := model.TemporaryMonitor{UserID: 1, Status: "running", CreatedAt: now, EndsAt: now + 86400, Secret: "fixture", TextPrompt: "old question", TextExpected: "old answer", DrawingPrompt: "draw 鹈鹕"}
			require.NoError(t, model.CreateTemporaryMonitor(&monitor))
			text, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "worker", now)
			require.NoError(t, err)
			require.NotNil(t, text)
			queued, err := model.QueueTemporaryMonitorProbe(monitor.ID, "drawing", now)
			require.NoError(t, err)
			for _, kind := range []string{"text", "drawing"} {
				response := selfTestAPI(t, func(c *gin.Context) {
					c.Params = append(c.Params, gin.Param{Key: "kind", Value: kind})
					UpdateTemporaryMonitorPrompt(c)
				}, 1, monitor.ID, map[string]any{"prompt": "new " + kind, "expected": "new answer"})
				require.Equal(t, 200, response.Code, response.Body.String())
			}
			var unchanged model.TemporaryMonitorAttempt
			require.NoError(t, db.First(&unchanged, text.ID).Error)
			assert.Equal(t, model.LongText("old question"), unchanged.Prompt)
			assert.Equal(t, model.LongText("old answer"), unchanged.Expected)
			drawing, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "drawing", "worker", now)
			require.NoError(t, err)
			require.NotNil(t, drawing)
			assert.Equal(t, queued.ID, drawing.ID)
			assert.Equal(t, model.LongText("new drawing"), drawing.OriginalPrompt)
			assert.Empty(t, drawing.Prompt, "drawing input is not sent until rewriting succeeds")
			require.NoError(t, db.Model(text).Update("status", "succeeded").Error)
			require.NoError(t, db.Model(drawing).Update("status", "succeeded").Error)
			next, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "text", "worker", now+180)
			require.NoError(t, err)
			require.NotNil(t, next)
			assert.Equal(t, model.LongText("new text"), next.Prompt)
			assert.Equal(t, model.LongText("new answer"), next.Expected)
			secondDrawing, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "drawing", "worker", now+600)
			require.NoError(t, err)
			require.NotNil(t, secondDrawing)
			assert.NotEqual(t, drawing.Subject, secondDrawing.Subject)
			for _, tc := range []struct{ kind, prompt, expected string }{{"text", "", "answer"}, {"text", "question", " "}, {"unknown", "question", "answer"}, {"drawing", strings.Repeat("a", 20001), ""}} {
				assert.Error(t, model.UpdateTemporaryMonitorPrompt(monitor.ID, tc.kind, tc.prompt, tc.expected, now))
			}
			assert.Error(t, model.UpdateTemporaryMonitorPrompt(monitor.ID, "drawing", "expired", "", monitor.EndsAt))
			require.NoError(t, model.StopTemporaryMonitor(monitor.ID))
			assert.Error(t, model.UpdateTemporaryMonitorPrompt(monitor.ID, "text", "ended", "answer", now))
		})
	}
}

func TestTemporaryMonitorDedicatedRewriterSettings(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := selfTestDB(t, dialect)
			require.NoError(t, db.AutoMigrate(&model.Option{}))
			require.NoError(t, db.Where(&model.Option{Key: model.TemporaryMonitorRewriterOption}).Delete(&model.Option{}).Error)
			missing := selfTestAPI(t, GetTemporaryMonitorRewriter, 1, 0, nil)
			require.Equal(t, 200, missing.Code)
			assert.False(t, gjson.Get(missing.Body.String(), "data.has_saved_key").Bool())
			input := map[string]any{"name": "rewriter", "base_url": "https://example.org/v1", "model": "rewrite-model", "protocol": "chat", "effort": "low", "api_key": "dedicated-secret", "max_output_tokens": 4096}
			saved := selfTestAPI(t, UpdateTemporaryMonitorRewriter, 1, 0, input)
			require.Equal(t, 200, saved.Code, saved.Body.String())
			assert.True(t, gjson.Get(saved.Body.String(), "data.has_saved_key").Bool())
			assert.NotContains(t, saved.Body.String(), "dedicated-secret")
			var option model.Option
			require.NoError(t, db.Where(&model.Option{Key: model.TemporaryMonitorRewriterOption}).First(&option).Error)
			assert.NotContains(t, option.Value, "dedicated-secret")
			for range 2 {
				require.NoError(t, db.AutoMigrate(&model.Option{}))
			}
			input["api_key"], input["model"], input["protocol"] = "", "new-rewrite-model", "anthropic"
			updated := selfTestAPI(t, UpdateTemporaryMonitorRewriter, 2, 0, input)
			require.Equal(t, 200, updated.Code, updated.Body.String())
			profile, err := model.GetTemporaryMonitorRewriter()
			require.NoError(t, err)
			assert.Equal(t, 2, profile.UserID)
			key, err := service.DecryptSelfTestKey(profile.UserID, profile.BaseURL+":"+profile.Protocol, string(profile.Secret))
			require.NoError(t, err)
			assert.Equal(t, "dedicated-secret", key)
			oldClient := selfTestClient
			t.Cleanup(func() { selfTestClient = oldClient })
			selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
				assert.Equal(t, "https://example.org/v1/models", req.URL.String())
				assert.Equal(t, "dedicated-secret", req.Header.Get("x-api-key"))
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"rewrite-model"}]}`))}, nil
			})}
			models := selfTestAPI(t, FetchTemporaryMonitorRewriterModels, 2, 0, input)
			require.Equal(t, 200, models.Code, models.Body.String())
			assert.Equal(t, "rewrite-model", gjson.Get(models.Body.String(), "data.0").String())
			input["base_url"] = "https://example.com/v1"
			assert.Equal(t, 400, selfTestAPI(t, UpdateTemporaryMonitorRewriter, 2, 0, input).Code, "never reuse a key for a changed endpoint")
			assert.Equal(t, 400, selfTestAPI(t, FetchTemporaryMonitorRewriterModels, 2, 0, input).Code)
			input["base_url"], input["api_key"] = "https://127.0.0.1/v1", "new-key"
			assert.Equal(t, 400, selfTestAPI(t, UpdateTemporaryMonitorRewriter, 2, 0, input).Code)
		})
	}
}

func TestTemporaryMonitorRewriteFailureSkipsDrawing(t *testing.T) {
	for _, tc := range []struct {
		name, output string
		code         int
	}{
		{"upstream error", `{"error":"rewrite-private-key: upstream rejected request"}`, 502},
		{"unchanged subject", "draw 鹈鹕 instead", 200},
		{"empty output", "", 200},
		{"missing configuration", "", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := selfTestDB(t, "sqlite")
			temporaryRewriterFixture(t)
			if tc.code == 0 {
				require.NoError(t, db.Where(&model.Option{Key: model.TemporaryMonitorRewriterOption}).Delete(&model.Option{}).Error)
			}
			require.NoError(t, db.AutoMigrate(&model.TemporaryMonitor{}, &model.TemporaryMonitorAttempt{}))
			secret, err := service.EncryptSelfTestKey(1, "https://example.com/v1:chat", "rewrite-private-key")
			require.NoError(t, err)
			now := common.GetTimestamp()
			monitor := model.TemporaryMonitor{UserID: 1, Status: "running", CreatedAt: now, EndsAt: now + 86400, Secret: model.LongText(secret), BaseURL: "https://example.com/v1", Model: "test-model", Protocol: "chat", DrawingPrompt: "draw 鹈鹕"}
			require.NoError(t, model.CreateTemporaryMonitor(&monitor))
			attempt, err := model.ClaimTemporaryMonitorAttempt(monitor.ID, "drawing", "worker", now)
			require.NoError(t, err)
			require.NotNil(t, attempt)
			oldClient := selfTestClient
			t.Cleanup(func() { selfTestClient = oldClient })
			calls := 0
			selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
				calls++
				body := tc.output
				if tc.code == 200 {
					raw, marshalErr := common.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": tc.output}, "finish_reason": "stop"}}})
					require.NoError(t, marshalErr)
					body = string(raw)
				}
				return &http.Response{StatusCode: tc.code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			runTemporaryMonitorAttempt(context.Background(), monitor, *attempt, "worker")
			expectedCalls := 1
			if tc.code == 0 {
				expectedCalls = 0
			}
			assert.Equal(t, expectedCalls, calls)
			response := selfTestAPI(t, GetTemporaryMonitorAttempt, 1, attempt.ID, nil)
			require.Equal(t, 200, response.Code, response.Body.String())
			assert.Equal(t, "failed", gjson.Get(response.Body.String(), "data.status").String())
			if tc.code == 0 {
				assert.Contains(t, gjson.Get(response.Body.String(), "data.error").String(), "Configure the dedicated rewrite model")
				assert.False(t, gjson.Get(response.Body.String(), "data.preparation").Exists())
			} else {
				assert.Contains(t, gjson.Get(response.Body.String(), "data.error").String(), "Prompt rewrite failed")
				assert.True(t, gjson.Get(response.Body.String(), "data.preparation").Exists())
			}
			assert.NotContains(t, response.Body.String(), "rewrite-private-key")
			assert.Empty(t, gjson.Get(response.Body.String(), "data.prompt").String())
		})
	}
}

func TestTemporaryMonitorDispatcherStopsBothInflightProbes(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	temporaryRewriterFixture(t)
	require.NoError(t, db.AutoMigrate(&model.TemporaryMonitor{}, &model.TemporaryMonitorAttempt{}))
	secret, err := service.EncryptSelfTestKey(1, "https://example.com/v1:chat", "dispatcher-secret")
	require.NoError(t, err)
	now := common.GetTimestamp()
	monitor := model.TemporaryMonitor{UserID: 1, Name: "dispatcher", BaseURL: "https://example.com/v1", Model: "test-model", Protocol: "chat", TextEffort: "low", DrawingEffort: "high", Secret: model.LongText(secret), DrawingPrompt: "Draw SVG", Status: "running", CreatedAt: now, EndsAt: now + 86400}
	monitor.TextDisabled, monitor.DrawingDisabled = true, true
	require.NoError(t, model.CreateTemporaryMonitor(&monitor))
	for _, kind := range []string{"text", "drawing"} {
		_, queueErr := model.QueueTemporaryMonitorProbe(monitor.ID, kind, now)
		require.NoError(t, queueErr)
	}
	entered := make(chan string, 2)
	oldClient := selfTestClient
	t.Cleanup(func() { selfTestClient = oldClient })
	selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
		raw, readErr := io.ReadAll(req.Body)
		if readErr != nil {
			return nil, readErr
		}
		entered <- gjson.GetBytes(raw, "reasoning_effort").String()
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	task := &model.SystemTask{TaskID: "temporary-dispatch", Type: temporaryMonitorTaskType, Status: model.SystemTaskStatusRunning, LockedBy: "fixture"}
	require.NoError(t, db.Create(task).Error)
	require.NoError(t, db.Create(&model.SystemTaskLock{Type: task.Type, TaskID: task.TaskID, LockedBy: "fixture", LockedUntil: now + 60}).Error)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	finished := make(chan struct{})
	go func() { temporaryMonitorHandler{}.Run(ctx, task, "fixture"); close(finished) }()
	t.Cleanup(func() { cancel(); <-finished })
	efforts := []string{}
	for range 2 {
		select {
		case effort := <-entered:
			efforts = append(efforts, effort)
		case <-ctx.Done():
			t.Fatal("probes did not start")
		}
	}
	assert.ElementsMatch(t, []string{"low", "minimal"}, efforts)
	require.NoError(t, model.StopTemporaryMonitor(monitor.ID))
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("stopping monitor did not cancel inflight requests")
	}
	var attempts []model.TemporaryMonitorAttempt
	require.NoError(t, db.Where("monitor_id = ?", monitor.ID).Find(&attempts).Error)
	require.Len(t, attempts, 2)
	for _, attempt := range attempts {
		assert.Equal(t, "cancelled", attempt.Status)
		assert.Empty(t, attempt.Secret)
	}
}

func TestTemporaryMonitorAdminBoundary(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	require.NoError(t, db.AutoMigrate(&model.TemporaryMonitor{}, &model.TemporaryMonitorAttempt{}, &model.AuditLog{}))
	oldLog, oldRedis := model.LOG_DB, common.RedisEnabled
	model.LOG_DB, common.RedisEnabled = db, false
	t.Cleanup(func() { model.LOG_DB, common.RedisEnabled = oldLog, oldRedis })
	for _, tc := range []struct {
		name, token string
		role, code  int
	}{{"guest", "", 0, 401}, {"member", "member-monitor-token", common.RoleCommonUser, 403}, {"root", "root-monitor-token", common.RoleRootUser, 200}} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.token != "" {
				require.NoError(t, db.Create(&model.User{Username: tc.name, Password: "fixture", Role: tc.role, Status: common.UserStatusEnabled, Group: "default", AccessToken: &tc.token, AuthVersion: 1, AffCode: tc.name}).Error)
			}
			router := gin.New()
			routes := router.Group("/temporary-monitors", middleware.RootAuth(), middleware.DisableCache())
			routes.GET("", ListTemporaryMonitors)
			routes.POST("/:id/probes/:kind", UpdateTemporaryMonitorProbe)
			routes.POST("/:id/probes/:kind/run", RunTemporaryMonitorProbe)
			routes.POST("/:id/probes/:kind/prompt", UpdateTemporaryMonitorPrompt)
			routes.POST("/rewriter", UpdateTemporaryMonitorRewriter)
			routes.POST("/rewriter/models", FetchTemporaryMonitorRewriterModels)
			request := httptest.NewRequest(http.MethodGet, "/temporary-monitors", nil)
			if tc.token != "" {
				request.Header.Set("Authorization", "Bearer "+tc.token)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			assert.Equal(t, tc.code, response.Code, response.Body.String())
			if tc.role != common.RoleRootUser {
				for _, path := range []string{"/temporary-monitors/1/probes/text", "/temporary-monitors/1/probes/drawing/run", "/temporary-monitors/1/probes/text/prompt", "/temporary-monitors/rewriter", "/temporary-monitors/rewriter/models"} {
					request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"enabled":true,"interval_minutes":5}`))
					request.Header.Set("Content-Type", "application/json")
					if tc.token != "" {
						request.Header.Set("Authorization", "Bearer "+tc.token)
					}
					result := httptest.NewRecorder()
					router.ServeHTTP(result, request)
					assert.Equal(t, tc.code, result.Code)
				}
			}
		})
	}
}

func TestTemporaryMonitorAPIAndDiagnostics(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	require.NoError(t, db.AutoMigrate(&model.TemporaryMonitor{}, &model.TemporaryMonitorAttempt{}))
	input := map[string]any{"name": "upstream trial", "base_url": "https://example.com/v1", "model": "model", "protocol": "chat", "api_key": "monitor-api-secret", "text_effort": "low", "drawing_effort": "high"}
	input["drawing_probe"] = model.TemporaryProbeSettings{Enabled: false, IntervalMinutes: 15}
	response := selfTestAPI(t, StartTemporaryMonitor, 1, 0, input)
	require.Equal(t, 200, response.Code, response.Body.String())
	id := int(gjson.Get(response.Body.String(), "data.id").Int())
	assert.Equal(t, int64(86400), gjson.Get(response.Body.String(), "data.ends_at").Int()-gjson.Get(response.Body.String(), "data.created_at").Int())
	assert.NotContains(t, response.Body.String(), "monitor-api-secret")
	assert.True(t, gjson.Get(response.Body.String(), "data.drawing_disabled").Bool())
	assert.Equal(t, int64(15), gjson.Get(response.Body.String(), "data.drawing_interval_minutes").Int())
	assert.Equal(t, int64(3), gjson.Get(response.Body.String(), "data.text_interval_minutes").Int())
	var monitor model.TemporaryMonitor
	require.NoError(t, db.First(&monitor, id).Error)
	oldClient := selfTestClient
	t.Cleanup(func() { selfTestClient = oldClient })
	for i, tc := range []struct {
		body    string
		code    int
		verdict string
	}{{`{"choices":[{"message":{"content":"uncertain"}}]}`, 200, "mismatch"}, {`{"error":"upstream rejected monitor-api-secret"}`, 429, "error"}} {
		selfTestClient = &http.Client{Transport: selfTestTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: tc.code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
		})}
		attempt, err := model.ClaimTemporaryMonitorAttempt(id, "text", "worker", monitor.CreatedAt+int64(i)*180)
		require.NoError(t, err)
		require.NotNil(t, attempt)
		runTemporaryMonitorAttempt(context.Background(), monitor, *attempt, "worker")
		var result model.TemporaryMonitorAttempt
		require.NoError(t, db.First(&result, attempt.ID).Error)
		assert.Equal(t, tc.verdict, result.Verdict)
		assert.NotContains(t, string(result.Error), "monitor-api-secret")
		detail := selfTestAPI(t, GetTemporaryMonitorAttempt, 1, attempt.ID, nil)
		assert.NotContains(t, detail.Body.String(), "monitor-api-secret")
		assert.NotContains(t, detail.Body.String(), "v1:")
	}
	for _, handler := range []func(*gin.Context){ListTemporaryMonitors, GetTemporaryMonitor} {
		result := selfTestAPI(t, handler, 1, id, nil)
		assert.Equal(t, 200, result.Code, result.Body.String())
		assert.NotContains(t, result.Body.String(), "monitor-api-secret")
	}
	input["base_url"] = "https://127.0.0.1"
	assert.Equal(t, 400, selfTestAPI(t, StartTemporaryMonitor, 1, 0, input).Code)
	input["base_url"] = "https://example.com/v1"
	input["text_effort"] = "bogus"
	assert.Equal(t, 400, selfTestAPI(t, StartTemporaryMonitor, 1, 0, input).Code)
	// One more than each page size verifies bounded summaries and stable cursors.
	for i := range 6 {
		require.NoError(t, db.Create(&model.TemporaryMonitorAttempt{MonitorID: id, Kind: "drawing", Slot: int64(i), Verdict: "passed", SelfTestAttempt: model.SelfTestAttempt{Status: "succeeded", Output: "private full output", HTML: "<html>private artwork</html>"}}).Error)
	}
	page := selfTestAPI(t, func(c *gin.Context) { c.Request.URL.RawQuery = "kind=drawing"; GetTemporaryMonitor(c) }, 1, id, nil)
	require.Equal(t, 200, page.Code, page.Body.String())
	assert.Equal(t, int64(5), gjson.Get(page.Body.String(), "data.attempts.#").Int())
	assert.Equal(t, int64(6), gjson.Get(page.Body.String(), "data.stats.0.count").Int())
	assert.NotContains(t, page.Body.String(), "private full output")
	assert.NotContains(t, page.Body.String(), "private artwork")
	cursor := gjson.Get(page.Body.String(), "data.next_before").String()
	older := selfTestAPI(t, func(c *gin.Context) { c.Request.URL.RawQuery = "kind=drawing&before=" + cursor; GetTemporaryMonitor(c) }, 1, id, nil)
	require.Equal(t, 200, older.Code, older.Body.String())
	assert.Equal(t, int64(1), gjson.Get(older.Body.String(), "data.attempts.#").Int())
	assert.Zero(t, gjson.Get(older.Body.String(), "data.next_before").Int())
	update := selfTestAPI(t, func(c *gin.Context) {
		c.Params = append(c.Params, gin.Param{Key: "kind", Value: "drawing"})
		UpdateTemporaryMonitorProbe(c)
	}, 1, id, map[string]any{"enabled": false, "interval_minutes": 20})
	require.Equal(t, 200, update.Code, update.Body.String())
	var updated model.TemporaryMonitor
	require.NoError(t, db.First(&updated, id).Error)
	assert.Equal(t, 20, updated.DrawingIntervalMinutes)
	assert.True(t, updated.DrawingDisabled)
	assert.Equal(t, "high", updated.DrawingEffort)
	run := selfTestAPI(t, func(c *gin.Context) {
		c.Params = append(c.Params, gin.Param{Key: "kind", Value: "drawing"})
		RunTemporaryMonitorProbe(c)
	}, 1, id, nil)
	require.Equal(t, 200, run.Code, run.Body.String())
	assert.Equal(t, "queued", gjson.Get(run.Body.String(), "data.status").String())
	assert.NotContains(t, run.Body.String(), "monitor-api-secret")
	input["drawing_probe"] = model.TemporaryProbeSettings{Enabled: true, IntervalMinutes: 0}
	assert.Equal(t, 400, selfTestAPI(t, StartTemporaryMonitor, 1, 0, input).Code)
}
