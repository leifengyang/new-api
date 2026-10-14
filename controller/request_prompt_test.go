package controller

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestRequestPromptExtraction(t *testing.T) {
	for _, tc := range []struct{ name, body, text, attachments, status string }{
		{"chat latest user", `{"messages":[{"role":"system","content":"private system"},{"role":"user","content":"old question"},{"role":"assistant","content":"old reply"},{"role":"user","content":"last question"},{"role":"tool","content":"tool reply"}]}`, "last question", "", "captured"},
		{"anthropic blocks", `{"system":"hidden","messages":[{"role":"user","content":[{"type":"text","text":"hello"},{"type":"tool_result","content":"hidden result"},{"type":"image","source":{"type":"base64","data":"secret"}},{"type":"document","source":{"url":"https://secret"}},{"type":"text","text":"world"}]}]}`, "hello\nworld", "image,file", "captured"},
		{"responses string", `{"input":"question","instructions":"hidden","previous_response_id":"old"}`, "question", "", "captured"},
		{"responses messages", `{"input":[{"role":"user","content":"old"},{"role":"assistant","content":[{"type":"output_text","text":"hidden"}]},{"role":"user","content":[{"type":"input_text","text":"latest"},{"type":"input_image","image_url":"https://secret"}]},{"type":"function_call_output","output":"hidden"}]}`, "latest", "image", "captured"},
		{"gemini", `{"systemInstruction":{"parts":[{"text":"hidden"}]},"contents":[{"role":"user","parts":[{"text":"old"}]},{"role":"model","parts":[{"text":"hidden"}]},{"role":"user","parts":[{"text":"last"},{"inlineData":{"mimeType":"audio/wav","data":"secret"}},{"fileData":{"mimeType":"image/png","fileUri":"https://secret"}},{"functionResponse":{"response":{"text":"hidden"}}}]}]}`, "last", "audio,image", "captured"},
		{"only attachment", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,secret"}}]}]}`, "", "image", "captured"},
		{"no user never falls back to assistant", `{"messages":[{"role":"assistant","content":"hidden"}],"prompt":"also hidden"}`, "", "", "no_user_message"},
		{"latest tools never leaks earlier user", `{"messages":[{"role":"user","content":"old"},{"role":"user","content":[{"type":"tool_result","content":"hidden"}]}]}`, "", "", "no_user_message"},
		{"malformed JSON", `{"messages":`, "", "", "invalid_body"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prompt := service.ExtractRequestPrompt([]byte(tc.body))
			assert.Equal(t, tc.text, prompt.Text)
			assert.Equal(t, tc.attachments, prompt.Attachments)
			assert.Equal(t, tc.status, prompt.Status)
		})
	}
	input := "开头" + strings.Repeat("中🙂", 30000) + "结尾"
	text, truncated := service.BoundRequestPrompt(input)
	assert.True(t, truncated)
	assert.LessOrEqual(t, len(text), service.MaxRequestPromptBytes)
	assert.True(t, utf8.ValidString(text))
	assert.True(t, strings.HasPrefix(text, "开头"))
	assert.True(t, strings.HasSuffix(text, "结尾"))
	text, truncated = service.BoundRequestPrompt(strings.Repeat("a", service.MaxRequestPromptBytes))
	assert.False(t, truncated)
	assert.Len(t, text, service.MaxRequestPromptBytes)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	require.NoError(t, writer.WriteField("prompt", "multipart question"))
	file, err := writer.CreateFormFile("image", "secret-name.png")
	require.NoError(t, err)
	_, err = file.Write([]byte("secret payload"))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	prompt := service.ExtractMultipartRequestPrompt(&body, writer.FormDataContentType())
	assert.Equal(t, "multipart question", prompt.Text)
	assert.Equal(t, "file", prompt.Attachments)
}

func TestRequestPromptDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := selfTestDB(t, dialect)
			previousLogDB := model.LOG_DB
			model.LOG_DB = db
			t.Cleanup(func() { model.LOG_DB = previousLogDB })
			require.NoError(t, db.Migrator().DropTable(&model.RequestPrompt{}, &model.Log{}))
			require.NoError(t, db.AutoMigrate(&model.Log{}, &model.Option{}))
			now := time.Now().Unix()
			legacyLog := model.Log{RequestId: "legacy-prompt-log", Type: model.LogTypeConsume, CreatedAt: now, Quota: 42}
			require.NoError(t, db.Create(&legacyLog).Error)
			require.NoError(t, db.AutoMigrate(&model.RequestPrompt{}))
			text := strings.Repeat("中文🙂", 13000) // > MySQL TEXT's 64 KB boundary
			require.NoError(t, model.SaveRequestPrompt(&model.RequestPrompt{RequestID: "latest", CreatedAt: now, Text: text, Status: "captured"}))
			// Idempotent migration and insertion must preserve original contents.
			for range 2 {
				require.NoError(t, db.AutoMigrate(&model.RequestPrompt{}))
			}
			require.NoError(t, model.SaveRequestPrompt(&model.RequestPrompt{RequestID: "latest", CreatedAt: now, Text: "replacement"}))
			prompt, err := model.GetRequestPrompt("latest", now)
			require.NoError(t, err)
			assert.Equal(t, text, prompt.Text)
			cutoff := now - int64(model.RequestPromptRetention/time.Second)
			require.NoError(t, model.SaveRequestPrompt(&model.RequestPrompt{RequestID: "expired", CreatedAt: cutoff, Text: "old"}))
			_, err = model.GetRequestPrompt("expired", now)
			assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			for range 2 {
				require.NoError(t, model.PruneRequestPrompts(now))
			}
			var count int64
			require.NoError(t, db.Model(&model.RequestPrompt{}).Where("request_id = ?", "expired").Count(&count).Error)
			assert.Zero(t, count)
			var after model.Log
			require.NoError(t, db.First(&after, legacyLog.Id).Error)
			assert.Equal(t, legacyLog.Quota, after.Quota)
			// A rejection already recorded by the relay must not gain a second row.
			require.NoError(t, model.RecordUnloggedPromptRejection(&model.Log{RequestId: legacyLog.RequestId, Type: model.LogTypeError}))
			require.NoError(t, db.Model(&model.Log{}).Where("request_id = ?", legacyLog.RequestId).Count(&count).Error)
			assert.EqualValues(t, 1, count)
			_, err = model.GetRequestPrompt(legacyLog.RequestId, now)
			assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
		})
	}
}

func TestRequestPromptRootBoundaryAndSettings(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	previousLogDB := model.LOG_DB
	model.LOG_DB = db
	t.Cleanup(func() { model.LOG_DB = previousLogDB })
	require.NoError(t, db.AutoMigrate(&model.RequestPrompt{}, &model.UserSession{}, &model.AuditLog{}, &model.Option{}))
	previousRedis, previousSecret := common.RedisEnabled, common.SessionSecret
	common.RedisEnabled, common.SessionSecret = false, "prompt-test-secret"
	common.OptionMapRWMutex.Lock()
	previousOptions := common.OptionMap
	common.OptionMap = map[string]string{}
	common.OptionMapRWMutex.Unlock()
	t.Cleanup(func() {
		common.RedisEnabled, common.SessionSecret = previousRedis, previousSecret
		common.OptionMapRWMutex.Lock()
		common.OptionMap = previousOptions
		common.OptionMapRWMutex.Unlock()
	})
	require.NoError(t, model.SaveRequestPrompt(&model.RequestPrompt{RequestID: "private-question", CreatedAt: time.Now().Unix(), Text: "root-only question", Status: "captured"}))
	promptReads := 0
	require.NoError(t, db.Callback().Query().Before("gorm:query").Register("count_prompt_reads", func(tx *gorm.DB) {
		if tx.Statement.Table == "request_prompts" {
			promptReads++
		}
	}))
	t.Cleanup(func() { db.Callback().Query().Remove("count_prompt_reads") })
	router := gin.New()
	router.GET("/prompt", middleware.RootAuth(), middleware.DisableCache(), GetLogRequestPrompt)
	router.GET("/capture", middleware.RootAuth(), middleware.DisableCache(), GetRequestPromptCapture)
	router.PUT("/capture", middleware.RootAuth(), middleware.DisableCache(), UpdateRequestPromptCapture)
	for _, tc := range []struct {
		name       string
		role, code int
	}{{"anonymous", 0, 401}, {"member", 1, 403}, {"admin", 10, 403}, {"root", 100, 200}} {
		t.Run(tc.name, func(t *testing.T) {
			token := ""
			if tc.role != 0 {
				user := model.User{Username: tc.name, Password: "fixture", Role: tc.role, Status: common.UserStatusEnabled, AuthVersion: 1, AffCode: tc.name}
				require.NoError(t, db.Create(&user).Error)
				bundle, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "prompt-test")
				require.NoError(t, err)
				token = bundle.AccessToken
			}
			for _, endpoint := range []struct{ method, path, body string }{{"GET", "/prompt?request_id=private-question", ""}, {"GET", "/capture", ""}, {"PUT", "/capture", `{"enabled":false}`}} {
				request := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(endpoint.body))
				if token != "" {
					request.Header.Set("Authorization", "Bearer "+token)
				}
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				code := tc.code
				if tc.role == 100 && strings.HasPrefix(endpoint.path, "/prompt") {
					code = 410
					assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
				}
				assert.Equal(t, code, response.Code, response.Body.String())
				assert.NotContains(t, response.Body.String(), "root-only question")
			}
		})
	}
	assert.Zero(t, promptReads, "HTTP endpoints must not query saved prompt content")
	assert.False(t, model.RequestPromptCaptureEnabled())
	var option model.Option
	require.NoError(t, db.Where("key = ?", model.RequestPromptCaptureKey).First(&option).Error)
	assert.Equal(t, "false", option.Value)
	assert.Error(t, model.UpdateOptionsBulk(map[string]string{model.RequestPromptCaptureKey: "invalid"}))
	// Turning off capture does not erase unexpired records.
	_, err := model.GetRequestPrompt("private-question", time.Now().Unix())
	require.NoError(t, err)
}

func TestRequestPromptCapturePreservesBodyOnSuccessAndFailure(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	require.NoError(t, db.AutoMigrate(&model.RequestPrompt{}, &model.Log{}))
	previousLogDB := model.LOG_DB
	model.LOG_DB = db
	t.Cleanup(func() { model.LOG_DB = previousLogDB })
	common.OptionMapRWMutex.Lock()
	previous := common.OptionMap
	common.OptionMap = map[string]string{}
	common.OptionMapRWMutex.Unlock()
	t.Cleanup(func() { common.OptionMapRWMutex.Lock(); common.OptionMap = previous; common.OptionMapRWMutex.Unlock() })
	for _, tc := range []struct {
		id           string
		code         int
		enabled      bool
		text, status string
	}{
		{"success", 200, true, "original", "captured"},
		{"upstream-error", 403, true, "original", "captured"},
		{"disabled", 200, false, "", "disabled"},
		{"storage-error", 200, true, "", ""},
	} {
		t.Run(tc.id, func(t *testing.T) {
			if tc.id == "storage-error" {
				require.NoError(t, db.Callback().Create().Before("gorm:create").Register("prompt_storage_failure", func(tx *gorm.DB) {
					if tx.Statement.Table == "request_prompts" {
						tx.AddError(errors.New("simulated storage failure"))
					}
				}))
				defer db.Callback().Create().Remove("prompt_storage_failure")
			}
			common.OptionMapRWMutex.Lock()
			common.OptionMap[model.RequestPromptCaptureKey] = "false"
			if tc.enabled {
				common.OptionMap[model.RequestPromptCaptureKey] = "true"
			}
			common.OptionMapRWMutex.Unlock()
			body := `{"messages":[{"role":"user","content":"original"}]}`
			router := gin.New()
			router.POST("/chat", middleware.BodyStorageCleanup(), func(c *gin.Context) { c.Set("id", 1); c.Set(common.RequestIdKey, tc.id) }, middleware.CaptureRequestPrompt(), func(c *gin.Context) {
				actual, err := io.ReadAll(c.Request.Body)
				require.NoError(t, err)
				assert.Equal(t, body, string(actual))
				c.Request.Body = io.NopCloser(strings.NewReader(`{"messages":[{"role":"user","content":"rewritten"}]}`))
				c.String(tc.code, "model reply must not be saved")
			})
			request := httptest.NewRequest("POST", "/chat", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			require.NoError(t, service.FlushRequestPrompts(ctx))
			assert.Equal(t, tc.code, response.Code)
			if tc.id == "storage-error" {
				assert.Equal(t, "model reply must not be saved", response.Body.String())
				var count int64
				require.NoError(t, db.Model(&model.RequestPrompt{}).Where("request_id = ?", tc.id).Count(&count).Error)
				assert.Zero(t, count)
				return
			}
			var saved *model.RequestPrompt
			require.Eventually(t, func() bool {
				var err error
				saved, err = model.GetRequestPrompt(tc.id, time.Now().Unix())
				return err == nil
			}, 3*time.Second, 10*time.Millisecond)
			assert.Equal(t, tc.text, saved.Text)
			assert.Equal(t, tc.status, saved.Status)
			if tc.code >= 400 {
				var log model.Log
				require.Eventually(t, func() bool { return db.Where("request_id = ?", tc.id).First(&log).Error == nil }, time.Second, 10*time.Millisecond)
				assert.Equal(t, model.LogTypeError, log.Type)
				assert.Zero(t, log.Quota)
				assert.NotContains(t, log.Content, "model reply")
			}
		})
	}
}

func TestRequestPromptWithSeparateClickHouseLogs(t *testing.T) {
	dsn := os.Getenv("REQUEST_PROMPT_CLICKHOUSE_DSN")
	if dsn == "" {
		t.Skip("REQUEST_PROMPT_CLICKHOUSE_DSN not configured")
	}
	db := selfTestDB(t, "sqlite")
	require.NoError(t, db.AutoMigrate(&model.RequestPrompt{}))
	previousLogDB, previousType, previousMaster := model.LOG_DB, common.LogDatabaseType(), common.IsMasterNode
	common.IsMasterNode = true
	t.Setenv("LOG_SQL_DSN", dsn)
	require.NoError(t, model.InitLogDB())
	logDB, err := model.LOG_DB.DB()
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, logDB.Close())
		model.LOG_DB, common.IsMasterNode = previousLogDB, previousMaster
		common.SetLogDatabaseType(previousType)
	})
	id := common.NewRequestId()
	now := time.Now().Unix()
	require.NoError(t, model.SaveRequestPrompt(&model.RequestPrompt{RequestID: id, CreatedAt: now, Text: "private user question", Status: "captured"}))
	entry := &model.Log{RequestId: id, CreatedAt: now, UserId: 1, Type: model.LogTypeError, Content: "request rejected"}
	for range 2 {
		require.NoError(t, model.RecordUnloggedPromptRejection(entry))
	}
	var logs []model.Log
	require.NoError(t, model.LOG_DB.Where("request_id = ?", id).Find(&logs).Error)
	require.Len(t, logs, 1)
	encoded, err := common.Marshal(logs)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "private user question")
	prompt, err := model.GetRequestPrompt(logs[0].RequestId, now)
	require.NoError(t, err)
	assert.Equal(t, "private user question", prompt.Text)
	// Retention affects only primary prompt storage, not the external log row.
	require.NoError(t, model.PruneRequestPrompts(now+int64(model.RequestPromptRetention/time.Second)))
	var count int64
	require.NoError(t, model.LOG_DB.Model(&model.Log{}).Where("request_id = ?", id).Count(&count).Error)
	assert.EqualValues(t, 1, count)
}
