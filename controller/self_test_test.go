package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func selfTestDB(t *testing.T, dialect string) *gorm.DB {
	t.Helper()
	var driver gorm.Dialector
	switch dialect {
	case "mysql":
		dsn := os.Getenv("SELF_TEST_MYSQL_DSN")
		if dsn == "" {
			t.Skip("SELF_TEST_MYSQL_DSN not configured")
		}
		driver = mysql.Open(dsn)
	case "postgres":
		dsn := os.Getenv("SELF_TEST_POSTGRES_DSN")
		if dsn == "" {
			t.Skip("SELF_TEST_POSTGRES_DSN not configured")
		}
		driver = postgres.Open(dsn)
	default:
		driver = sqlite.Open(filepath.Join(t.TempDir(), "self-test.db") + "?_pragma=busy_timeout(30000)&_pragma=journal_mode(WAL)&_txlock=immediate")
	}
	db, err := gorm.Open(driver, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	oldType := common.MainDatabaseType()
	common.SetMainDatabaseType(common.DatabaseType(dialect))
	t.Cleanup(func() { common.SetMainDatabaseType(oldType) })
	old := model.DB
	model.DB = db
	t.Cleanup(func() { model.DB = old; require.NoError(t, sqlDB.Close()) })
	// Only disposable test databases may be supplied in these dedicated variables.
	require.NoError(t, db.Migrator().DropTable(&model.SelfTestAttempt{}, &model.SelfTestRound{}, &model.SelfTestProfile{}, &model.User{}, &model.SystemTask{}, &model.SystemTaskLock{}))
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.SystemTask{}, &model.SystemTaskLock{}))
	require.NoError(t, db.Create(&model.User{Id: 1, Username: "self-test-owner", Password: "fixture", Status: 1, AffCode: "owner"}).Error)
	require.NoError(t, db.Create(&model.User{Id: 2, Username: "other-owner", Password: "fixture", Status: 1, AffCode: "other"}).Error)
	t.Setenv("SELF_TEST_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{42}, 32)))
	for range 2 {
		require.NoError(t, db.AutoMigrate(&model.SelfTestProfile{}, &model.SelfTestRound{}, &model.SelfTestAttempt{}))
	}
	return db
}

func selfTestAPI(t *testing.T, handler gin.HandlerFunc, userID, id int, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := common.Marshal(body)
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("id", userID)
	c.Params = gin.Params{{Key: "id", Value: strconv.Itoa(id)}}
	c.Request = httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(encoded))
	handler(c)
	return recorder
}

func selfTestFixture(t *testing.T, count int, protocol ...string) (model.SelfTestRound, []model.SelfTestAttempt) {
	t.Helper()
	inputs := make([]selfTestGroupInput, count)
	for i := range count {
		inputs[i] = selfTestGroupInput{Name: fmt.Sprintf("group-%d", i), BaseURL: "https://example.com/v1", Model: "model-test", Protocol: "chat", Effort: "medium", APIKey: "sk-private-test", RememberKey: i == 0}
		if len(protocol) > 0 {
			inputs[i].Protocol, inputs[i].Effort = protocol[0], ""
		}
	}
	profiles, attempts, err := prepareSelfTestGroups(1, inputs, true)
	require.NoError(t, err)
	round := model.SelfTestRound{UserID: 1, Prompt: "draw", Concurrency: 3, TimeoutSeconds: 1200}
	require.NoError(t, model.CreateSelfTestRound(&round, attempts, profiles))
	require.NoError(t, model.DB.Where("round_id = ?", round.ID).Order("id").Find(&attempts).Error)
	return round, attempts
}

func TestSelfTestDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := selfTestDB(t, dialect)
			var version string
			query := "SELECT version()"
			if dialect == "sqlite" {
				query = "SELECT sqlite_version()"
			}
			require.NoError(t, db.Raw(query).Scan(&version).Error)
			t.Log(dialect, version)
			round, attempts := selfTestFixture(t, 2, "anthropic")
			assert.Equal(t, "anthropic", attempts[0].Protocol)
			for range 2 {
				var sqlLog bytes.Buffer
				migrationLogger := logger.New(log.New(&sqlLog, "", 0), logger.Config{LogLevel: logger.Info})
				require.NoError(t, db.Session(&gorm.Session{Logger: migrationLogger}).AutoMigrate(&model.SelfTestProfile{}, &model.SelfTestRound{}, &model.SelfTestAttempt{}))
				assert.NotRegexp(t, regexp.MustCompile(`(?i)\b(CREATE TABLE|ALTER TABLE|DROP TABLE|CREATE INDEX)\b`), sqlLog.String())
			}
			assert.True(t, db.Migrator().HasIndex(&model.SelfTestRound{}, "idx_self_test_rounds_active_key"))
			var owner model.User
			require.NoError(t, db.First(&owner, 1).Error)
			assert.Equal(t, "self-test-owner", owner.Username)
			duplicate := model.SelfTestRound{UserID: 1, ActiveKey: round.ActiveKey}
			assert.Error(t, db.Create(&duplicate).Error)
			profiles := selfTestAPI(t, GetSelfTestProfiles, 1, 0, nil)
			assert.NotContains(t, profiles.Body.String(), "sk-private-test")
			assert.NotContains(t, profiles.Body.String(), "v1:")
			assert.True(t, gjson.Get(profiles.Body.String(), "data.0.has_saved_key").Bool())
			for _, handler := range []gin.HandlerFunc{GetSelfTestRound, GetSelfTestAttempt, StopSelfTest, RetrySelfTest} {
				id := round.ID
				if fmt.Sprintf("%p", handler) == fmt.Sprintf("%p", GetSelfTestAttempt) || fmt.Sprintf("%p", handler) == fmt.Sprintf("%p", RetrySelfTest) {
					id = attempts[0].ID
				}
				assert.Equal(t, 404, selfTestAPI(t, handler, 2, id, map[string]any{}).Code)
			}
			require.NoError(t, db.Model(&attempts[0]).Updates(map[string]any{"status": "failed", "error": strings.Repeat("full diagnostic ", 6000)}).Error)
			require.NoError(t, model.RetrySelfTestAttempt(1, attempts[0].ID, attempts[0].Secret))
			assert.Error(t, model.RetrySelfTestAttempt(1, attempts[0].ID, attempts[0].Secret))
			assert.Equal(t, 200, selfTestAPI(t, StopSelfTest, 1, round.ID, map[string]int{}).Code)
			var stored []model.SelfTestAttempt
			require.NoError(t, db.Where("round_id = ?", round.ID).Order("id").Find(&stored).Error)
			require.Len(t, stored, 3)
			assert.Equal(t, "anthropic", stored[2].Protocol)
			require.NotNil(t, stored[2].MaxOutputTokens)
			assert.EqualValues(t, 32768, *stored[2].MaxOutputTokens)
			assert.Equal(t, strings.Repeat("full diagnostic ", 6000), string(stored[0].Error))
			for _, item := range stored {
				assert.Empty(t, item.Secret)
			}
			for range 20 {
				round, _ = selfTestFixture(t, 1)
				require.NoError(t, db.Model(&model.SelfTestAttempt{}).Where("round_id = ?", round.ID).Update("status", "succeeded").Error)
				require.NoError(t, model.FinishSelfTestRound(round.ID))
			}
			var count int64
			require.NoError(t, db.Model(&model.SelfTestRound{}).Where("user_id = ?", 1).Count(&count).Error)
			assert.EqualValues(t, 20, count)
			require.NoError(t, db.Model(&model.SelfTestAttempt{}).Count(&count).Error)
			assert.EqualValues(t, 20, count)
			assert.True(t, gjson.Get(selfTestAPI(t, GetSelfTestHistory, 2, 0, nil).Body.String(), "data").IsArray())
		})
	}
}

func TestSelfTestCredentialsAndEndpoints(t *testing.T) {
	t.Setenv("SELF_TEST_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32)))
	secret, err := service.EncryptSelfTestKey(1, "https://example.com/v1:chat", "secret-key")
	require.NoError(t, err)
	plain, err := service.DecryptSelfTestKey(1, "https://example.com/v1:chat", secret)
	require.NoError(t, err)
	assert.Equal(t, "secret-key", plain)
	_, err = service.DecryptSelfTestKey(2, "https://example.com/v1:chat", secret)
	assert.Error(t, err)
	_, err = service.DecryptSelfTestKey(1, "https://other.com/v1:chat", secret)
	assert.Error(t, err)
	_, err = service.DecryptSelfTestKey(1, "https://example.com/v1:chat", secret[:len(secret)-4]+"aaaa")
	assert.Error(t, err)
	for _, endpoint := range []string{"http://example.com", "https://127.0.0.1", "https://[::1]", "https://169.254.169.254", "https://example.com:8443", "https://user:pass@example.com", "https://example.com/?key=foo"} {
		_, err := service.NormalizeSelfTestURL(endpoint)
		assert.Error(t, err, endpoint)
	}
	endpoint, err := service.NormalizeSelfTestURL("https://example.com/")
	require.NoError(t, err)
	assert.Equal(t, "https://example.com/v1", endpoint)
	client := service.NewSelfTestHTTPClient()
	assert.ErrorIs(t, client.CheckRedirect(nil, nil), http.ErrUseLastResponse)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", "https://127.0.0.1/", nil)
	require.NoError(t, err)
	_, err = client.Do(req)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "private")
	t.Run("persistent-key-file", func(t *testing.T) {
		t.Setenv("SELF_TEST_ENCRYPTION_KEY", "")
		t.Setenv("CRYPTO_SECRET", "")
		t.Setenv("SELF_TEST_KEY_FILE", filepath.Join(t.TempDir(), "encryption.key"))
		sealed, err := service.EncryptSelfTestKey(1, "endpoint", "persistent-secret")
		require.NoError(t, err)
		opened, err := service.DecryptSelfTestKey(1, "endpoint", sealed)
		require.NoError(t, err)
		assert.Equal(t, "persistent-secret", opened)
		keyFile, err := os.ReadFile(os.Getenv("SELF_TEST_KEY_FILE"))
		require.NoError(t, err)
		assert.Len(t, keyFile, 32)
	})
}

func TestSelfTestAPIDefaultsAndSavedKeyScope(t *testing.T) {
	selfTestDB(t, "sqlite")
	input := selfTestInput{Prompt: "draw", Groups: []selfTestGroupInput{{Name: "group", BaseURL: "https://example.com/v1", Model: "model", Protocol: "chat", APIKey: "private-key", RememberKey: true}}}
	response := selfTestAPI(t, StartSelfTest, 1, 0, input)
	require.Equal(t, 200, response.Code, response.Body.String())
	assert.EqualValues(t, 1200, gjson.Get(response.Body.String(), "data.timeout_seconds").Int())
	assert.EqualValues(t, 3, gjson.Get(response.Body.String(), "data.concurrency").Int())
	assert.Equal(t, 400, selfTestAPI(t, StartSelfTest, 1, 0, input).Code)
	var profile model.SelfTestProfile
	require.NoError(t, model.DB.Where("user_id = ?", 1).First(&profile).Error)
	group := input.Groups[0]
	group.ID = profile.ID
	group.APIKey = ""
	group.BaseURL = "https://other.example/v1"
	_, _, err := prepareSelfTestGroups(1, []selfTestGroupInput{group}, true)
	assert.Error(t, err)
	group.BaseURL = profile.BaseURL
	group.Protocol = "anthropic"
	group.Effort = ""
	_, _, err = prepareSelfTestGroups(1, []selfTestGroupInput{group}, true)
	assert.Error(t, err, "saved credentials must not cross protocol boundaries")
	group.Protocol = "chat"
	_, _, err = prepareSelfTestGroups(2, []selfTestGroupInput{group}, true)
	assert.Error(t, err)
	_, attempts, err := prepareSelfTestGroups(1, []selfTestGroupInput{group}, true)
	require.NoError(t, err)
	assert.NotEmpty(t, attempts[0].Secret)
	assert.NotContains(t, response.Body.String(), "private-key")
}

type selfTestTransport func(*http.Request) (*http.Response, error)

func (fn selfTestTransport) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func TestSelfTestProtocolsAndTerminalState(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	oldClient := selfTestClient
	t.Cleanup(func() { selfTestClient = oldClient })
	for _, tc := range []struct {
		name, protocol, body     string
		status                   int
		expected                 string
		input, output, reasoning int
	}{
		{"chat", "chat", "data: {\"choices\":[{\"delta\":{\"content\":\"<html><svg/></html>\"}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":4,\"completion_tokens_details\":{\"reasoning_tokens\":2}}}\n\ndata: [DONE]\n\n", 200, "succeeded", 12, 4, 2},
		{"responses", "responses", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"<html><svg/></html>\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":18,\"output_tokens\":6,\"output_tokens_details\":{\"reasoning_tokens\":3}}}}\n\n", 200, "succeeded", 18, 6, 3},
		{"chat-length", "chat", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}\n\ndata: {\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":4}}\n\ndata: [DONE]\n\n", 200, "incomplete", 12, 4, 0},
		{"http-error", "chat", "diagnostic sk-private-test tail", 429, "failed", 0, 0, 0},
		{"stream-error", "responses", "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"sk-private-test diagnostic tail\"}}}\n\n", 200, "failed", 0, 0, 0},
		{"truncated", "chat", "data: {\"choices\":[{\"delta\":{\"content\":\"<html><svg/></html>\"}}]}\n\n", 200, "failed", 0, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			round, attempts := selfTestFixture(t, 1)
			attempt := attempts[0]
			attempt.Protocol = tc.protocol
			secret, err := service.EncryptSelfTestKey(1, attempt.BaseURL+":"+tc.protocol, "sk-private-test")
			require.NoError(t, err)
			attempt.Secret = model.LongText(secret)
			require.NoError(t, db.Model(&attempt).Updates(map[string]any{"status": "running", "runner": "test-runner"}).Error)
			selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
				assert.Equal(t, "Bearer sk-private-test", req.Header.Get("Authorization"))
				body, err := io.ReadAll(req.Body)
				require.NoError(t, err)
				assert.Equal(t, "model-test", gjson.GetBytes(body, "model").String())
				if tc.protocol == "responses" {
					assert.Equal(t, "/v1/responses", req.URL.Path)
					assert.EqualValues(t, 32768, gjson.GetBytes(body, "max_output_tokens").Int())
					assert.Equal(t, "draw", gjson.GetBytes(body, "input").String())
				} else {
					assert.Equal(t, "draw", gjson.GetBytes(body, "messages.0.content").String())
					assert.EqualValues(t, 32768, gjson.GetBytes(body, "max_completion_tokens").Int())
				}
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			runSelfTestAttempt(context.Background(), round, attempt, "test-runner")
			var result model.SelfTestAttempt
			require.NoError(t, db.First(&result, attempt.ID).Error)
			assert.Equal(t, tc.expected, result.Status)
			assert.Empty(t, result.Secret)
			assert.NotContains(t, string(result.Error), "sk-private-test")
			if tc.expected == "succeeded" {
				assert.Equal(t, tc.input, result.InputTokens)
				assert.Equal(t, tc.output, result.OutputTokens)
				assert.Equal(t, tc.reasoning, result.ReasoningTokens)
				assert.NotEmpty(t, result.HTML)
				assert.False(t, result.TokensEstimated)
			} else {
				assert.NotEmpty(t, result.Error)
			}
			if tc.expected == "incomplete" {
				assert.Equal(t, "partial", string(result.Output))
				assert.Equal(t, tc.input, result.InputTokens)
				assert.Equal(t, tc.output, result.OutputTokens)
				assert.False(t, result.TokensEstimated)
			}
		})
	}
	t.Run("cancel-wins-over-completion", func(t *testing.T) {
		round, attempts := selfTestFixture(t, 1)
		attempt := attempts[0]
		require.NoError(t, db.Model(&attempt).Updates(map[string]any{"status": "running", "runner": "test-runner"}).Error)
		selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
			assert.Equal(t, 200, selfTestAPI(t, StopSelfTest, 1, round.ID, map[string]int{"attempt_id": attempt.ID}).Code)
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"<html><svg/></html>"}}]}`))}, nil
		})}
		runSelfTestAttempt(context.Background(), round, attempt, "test-runner")
		var result model.SelfTestAttempt
		require.NoError(t, db.First(&result, attempt.ID).Error)
		assert.Equal(t, "cancelled", result.Status)
	})
}

func TestSelfTestAnthropicMessages(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	oldClient := selfTestClient
	t.Cleanup(func() { selfTestClient = oldClient })
	stream := "data: " + `{"type":"message_start","message":{"usage":{"input_tokens":12,"cache_creation_input_tokens":30,"cache_read_input_tokens":60,"output_tokens":1}}}` + "\n\n" +
		"data: " + `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Hello "}}` + "\n\n" +
		"data: " + `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}` + "\n\n" +
		"data: " + `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20,"output_tokens_details":{"thinking_tokens":3}}}` + "\n\n" +
		"data: " + `{"type":"message_delta","usage":{"output_tokens":22}}` + "\n\n"
	for _, tc := range []struct {
		name, body, contentType, status, output, errorText string
		inputTokens, outputTokens, thinkingTokens          int
	}{
		{"stream", stream + "data: {\"type\":\"message_stop\"}\n\n", "text/event-stream", "succeeded", "Hello world", "", 102, 22, 3},
		{"json", "{\n\"type\":\"message\",\"content\":[{\"type\":\"text\",\"text\":\"<html><body>Hello</body></html>\"}],\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":60,\"output_tokens\":22}}", "application/json", "succeeded", "<html><body>Hello</body></html>", "", 72, 22, 0},
		{"truncated", stream, "text/event-stream", "failed", "Hello world", "before completion", 102, 22, 3},
		{"stream-error", stream + "data: {\"type\":\"error\",\"error\":{\"message\":\"sk-private-test full diagnostic tail\"}}\n\n", "text/event-stream", "failed", "Hello world", "[REDACTED] full diagnostic tail", 102, 22, 3},
		{"output-limit", strings.Replace(stream, "end_turn", "max_tokens", 1) + "data: {\"type\":\"message_stop\"}\n\n", "text/event-stream", "incomplete", "Hello world", "max_tokens:", 102, 22, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			round, attempts := selfTestFixture(t, 1, "anthropic")
			attempt := attempts[0]
			require.NoError(t, db.Model(&attempt).Updates(map[string]any{"status": "running", "runner": "anthropic-test"}).Error)
			selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
				assert.Equal(t, "/v1/messages", req.URL.Path)
				assert.Equal(t, "sk-private-test", req.Header.Get("x-api-key"))
				assert.Equal(t, "2023-06-01", req.Header.Get("anthropic-version"))
				assert.Empty(t, req.Header.Get("Authorization"))
				body, err := io.ReadAll(req.Body)
				require.NoError(t, err)
				assert.Equal(t, "draw", gjson.GetBytes(body, "messages.0.content").String())
				assert.EqualValues(t, 32768, gjson.GetBytes(body, "max_tokens").Int())
				assert.True(t, gjson.GetBytes(body, "stream").Bool())
				assert.False(t, gjson.GetBytes(body, "reasoning_effort").Exists())
				assert.False(t, gjson.GetBytes(body, "stream_options").Exists())
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{tc.contentType}}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			runSelfTestAttempt(context.Background(), round, attempt, "anthropic-test")
			var result model.SelfTestAttempt
			require.NoError(t, db.First(&result, attempt.ID).Error)
			assert.Equal(t, tc.status, result.Status)
			assert.Equal(t, tc.output, string(result.Output))
			assert.Equal(t, tc.inputTokens, result.InputTokens)
			assert.Equal(t, tc.outputTokens, result.OutputTokens)
			assert.Equal(t, tc.thinkingTokens, result.ReasoningTokens)
			assert.False(t, result.TokensEstimated)
			assert.Empty(t, result.Secret)
			assert.NotContains(t, string(result.Error), "sk-private-test")
			if tc.errorText != "" {
				assert.Contains(t, string(result.Error), tc.errorText)
			} else {
				assert.Empty(t, result.Error)
			}
			if tc.name == "json" {
				assert.Equal(t, tc.output, string(result.HTML))
			}
		})
	}
	t.Run("model-discovery", func(t *testing.T) {
		selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
			assert.Equal(t, "/v1/models", req.URL.Path)
			assert.Equal(t, "discovery-key", req.Header.Get("x-api-key"))
			assert.Equal(t, "2023-06-01", req.Header.Get("anthropic-version"))
			assert.Empty(t, req.Header.Get("Authorization"))
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"claude-sonnet-4-5"}]}`))}, nil
		})}
		group := selfTestGroupInput{Name: "claude", BaseURL: "https://example.com/v1", Protocol: "anthropic", APIKey: "discovery-key"}
		response := selfTestAPI(t, FetchSelfTestModels, 1, 0, group)
		require.Equal(t, 200, response.Code, response.Body.String())
		assert.Equal(t, "claude-sonnet-4-5", gjson.Get(response.Body.String(), "data.0").String())
		group.Effort = "high"
		assert.Equal(t, 400, selfTestAPI(t, FetchSelfTestModels, 1, 0, group).Code)
	})
}

func TestSelfTestAnthropicLiveUsage(t *testing.T) {
	var attempt model.SelfTestAttempt
	raw := []byte("data: " + `{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90}}}` + "\n\n" +
		"data: " + `{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Let me think"}}` + "\n\n" +
		"data: " + `{"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}` + "\n\n")
	applyAnthropicSelfTestProgress(&attempt, raw, "prompt")
	assert.Equal(t, "Answer", string(attempt.Output))
	assert.Equal(t, 100, attempt.InputTokens)
	assert.Greater(t, attempt.ReasoningTokens, 0)
	assert.True(t, attempt.TokensEstimated)
	raw = append(raw, []byte("data: "+`{"type":"message_delta","usage":{"output_tokens":30,"output_tokens_details":{"thinking_tokens":7}}}`+"\n\n")...)
	applyAnthropicSelfTestProgress(&attempt, raw, "prompt")
	assert.Equal(t, 100, attempt.InputTokens)
	assert.Equal(t, 30, attempt.OutputTokens)
	assert.Equal(t, 7, attempt.ReasoningTokens)
	assert.False(t, attempt.TokensEstimated)
}

func TestSelfTestOptionalHTMLPreview(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	oldClient := selfTestClient
	t.Cleanup(func() { selfTestClient = oldClient })
	for _, tc := range []struct {
		name, protocol, output, html string
		stream                       bool
	}{
		{"plain-chat", "chat", "Answer: 42\nFinal line", "", true},
		{"markdown-responses", "responses", "# Answer\n\n**42**\nFinal line", "", true},
		{"json-chat", "chat", `{"answer":42}`, "", false},
		{"html-without-svg", "responses", "```html\n<!DOCTYPE html><html><body>42</body></html>\n```", "<!DOCTYPE html><html><body>42</body></html>", false},
		{"incomplete-html", "chat", "<html><body>partial", "", true},
		{"empty", "chat", " \n\t", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			round, attempts := selfTestFixture(t, 1)
			attempt := attempts[0]
			attempt.Protocol = tc.protocol
			secret, err := service.EncryptSelfTestKey(1, attempt.BaseURL+":"+tc.protocol, "sk-private-test")
			require.NoError(t, err)
			attempt.Secret = model.LongText(secret)
			require.NoError(t, db.Model(&attempt).Updates(map[string]any{"status": "running", "runner": "test-runner"}).Error)
			text, err := common.Marshal(tc.output)
			require.NoError(t, err)
			body := fmt.Sprintf(`{"choices":[{"message":{"content":%s}}]}`, text)
			if tc.protocol == "responses" {
				body = fmt.Sprintf(`{"output":[{"content":[{"type":"output_text","text":%s}]}]}`, text)
			}
			contentType := "application/json"
			if tc.stream {
				contentType = "text/event-stream"
				body = fmt.Sprintf("data: {\"choices\":[{\"delta\":{\"content\":%s}}]}\n\ndata: [DONE]\n\n", text)
				if tc.protocol == "responses" {
					body = fmt.Sprintf("data: {\"type\":\"response.output_text.delta\",\"delta\":%s}\n\ndata: {\"type\":\"response.completed\"}\n\n", text)
				}
			}
			selfTestClient = &http.Client{Transport: selfTestTransport(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{contentType}}, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			runSelfTestAttempt(context.Background(), round, attempt, "test-runner")
			var result model.SelfTestAttempt
			require.NoError(t, db.First(&result, attempt.ID).Error)
			assert.Equal(t, tc.output, string(result.Output))
			assert.Equal(t, tc.html, string(result.HTML))
			if strings.TrimSpace(tc.output) == "" {
				assert.Equal(t, "failed", result.Status)
				assert.Contains(t, string(result.Error), "no output")
			} else {
				assert.Equal(t, "succeeded", result.Status)
				assert.Empty(t, result.Error)
			}
		})
	}
}

func TestSelfTestQueueConcurrencyAndTimeout(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	oldClient := selfTestClient
	t.Cleanup(func() { selfTestClient = oldClient })
	round, attempts := selfTestFixture(t, 4)
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
		entered <- struct{}{}
		select {
		case <-release:
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"<html><svg/></html>"}}]}`))}, nil
	})}
	task := &model.SystemTask{TaskID: "queue-test", Type: selfTestTaskType, Status: model.SystemTaskStatusRunning, LockedBy: "fixture"}
	require.NoError(t, db.Create(task).Error)
	require.NoError(t, db.Create(&model.SystemTaskLock{Type: selfTestTaskType, TaskID: task.TaskID, LockedBy: "fixture", LockedUntil: time.Now().Unix() + 60}).Error)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	finished := make(chan struct{})
	go func() { selfTestHandler{}.Run(ctx, task, "fixture"); close(finished) }()
	t.Cleanup(func() { cancel(); <-finished })
	for range 3 {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("workers did not start")
		}
	}
	var states []model.SelfTestAttempt
	require.NoError(t, db.Where("round_id = ?", round.ID).Order("id").Find(&states).Error)
	assert.Equal(t, "queued", states[3].Status)
	assert.Equal(t, 200, selfTestAPI(t, StopSelfTest, 1, round.ID, map[string]int{"attempt_id": attempts[3].ID}).Code)
	close(release)
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("dispatcher did not finish")
	}
	require.NoError(t, db.Where("round_id = ?", round.ID).Order("id").Find(&states).Error)
	for _, state := range states[:3] {
		assert.Equal(t, "succeeded", state.Status)
	}
	assert.Equal(t, "cancelled", states[3].Status)
	assert.Empty(t, entered, "cancelled queued group must not contact upstream")

	round, attempts = selfTestFixture(t, 1)
	round.TimeoutSeconds = 0 // An expired deadline is deterministic; no timing benchmark.
	require.NoError(t, db.Model(&attempts[0]).Updates(map[string]any{"status": "running", "runner": "timeout"}).Error)
	selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	runSelfTestAttempt(context.Background(), round, attempts[0], "timeout")
	var timedOut model.SelfTestAttempt
	require.NoError(t, db.First(&timedOut, attempts[0].ID).Error)
	assert.Equal(t, "failed", timedOut.Status)
	assert.Contains(t, string(timedOut.Error), "deadline exceeded")
}

func TestSelfTestLiveProgress(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	oldClient := selfTestClient
	t.Cleanup(func() { selfTestClient = oldClient })
	round, attempts := selfTestFixture(t, 1)
	attempt := attempts[0]
	require.NoError(t, db.Model(&attempt).Updates(map[string]any{"status": "running", "runner": "live"}).Error)
	reader, writer := io.Pipe()
	selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: reader}, nil
	})}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	finished := make(chan struct{})
	go func() { runSelfTestAttempt(ctx, round, attempt, "live"); close(finished) }()
	t.Cleanup(func() { cancel(); writer.Close(); reader.Close(); <-finished })
	_, err := io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"<html><svg/>sk-private-test\",\"reasoning_content\":\"Drawing a bird\"}}]}\n\n")
	require.NoError(t, err)
	var progress model.SelfTestAttempt
	require.Eventually(t, func() bool { return db.First(&progress, attempt.ID).Error == nil && progress.OutputTokens > 0 }, 3*time.Second, 20*time.Millisecond)
	assert.Equal(t, "running", progress.Status)
	assert.True(t, progress.TokensEstimated)
	assert.Positive(t, progress.FirstTokenMs)
	assert.Positive(t, progress.ReasoningTokens)
	assert.NotContains(t, string(progress.Output), "sk-private-test")
	_, err = io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"</html>\"}}],\"usage\":{\"prompt_tokens\":70,\"completion_tokens\":30,\"completion_tokens_details\":{\"reasoning_tokens\":10}}}\n\ndata: [DONE]\n\n")
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("stream did not finish")
	}
	require.NoError(t, db.First(&progress, attempt.ID).Error)
	assert.Equal(t, "succeeded", progress.Status)
	assert.Equal(t, 70, progress.InputTokens)
	assert.Equal(t, 30, progress.OutputTokens)
	assert.Equal(t, 10, progress.ReasoningTokens)
	assert.False(t, progress.TokensEstimated)
}

func TestSelfTestIncompleteResponses(t *testing.T) {
	db := selfTestDB(t, "sqlite")
	oldClient := selfTestClient
	t.Cleanup(func() { selfTestClient = oldClient })
	response := `{"object":"response","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"hidden"}]},{"type":"message","content":[{"type":"output_text","text":"<html>partial output"}]}],"usage":{"prompt_tokens":532,"completion_tokens":8192,"input_tokens":532,"output_tokens":8192}}`
	for _, tc := range []struct{ name, body, contentType string }{
		{"terminal-only", "data: {\"type\":\"response.incomplete\",\"response\":" + response + "}\n\n", "text/event-stream"},
		{"delta-and-snapshot", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"<html>partial\"}\n\ndata: {\"type\":\"response.incomplete\",\"response\":" + response + "}\n\n", "text/event-stream"},
		{"json", response, "application/json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			round, attempts := selfTestFixture(t, 1, "responses")
			attempt := attempts[0]
			require.NoError(t, db.Model(&attempt).Updates(map[string]any{"status": "running", "runner": "limit-test"}).Error)
			selfTestClient = &http.Client{Transport: selfTestTransport(func(req *http.Request) (*http.Response, error) {
				body, err := io.ReadAll(req.Body)
				require.NoError(t, err)
				assert.EqualValues(t, 32768, gjson.GetBytes(body, "max_output_tokens").Int())
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{tc.contentType}}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			runSelfTestAttempt(context.Background(), round, attempt, "limit-test")
			var result model.SelfTestAttempt
			require.NoError(t, db.First(&result, attempt.ID).Error)
			assert.Equal(t, "incomplete", result.Status)
			assert.Equal(t, "<html>partial output", string(result.Output))
			assert.Empty(t, result.HTML)
			assert.Equal(t, 532, result.InputTokens)
			assert.Equal(t, 8192, result.OutputTokens)
			assert.False(t, result.TokensEstimated)
			assert.Contains(t, string(result.Error), "max_output_tokens")
			assert.Empty(t, result.Secret)
			require.NoError(t, model.RetrySelfTestAttempt(1, result.ID, attempt.Secret))
			var retry model.SelfTestAttempt
			require.NoError(t, db.Where("round_id = ?", round.ID).Order("id desc").First(&retry).Error)
			assert.Equal(t, result.MaxOutputTokens, retry.MaxOutputTokens)
			require.NoError(t, db.Model(&retry).Update("status", "cancelled").Error)
			require.NoError(t, model.FinishSelfTestRound(round.ID))
		})
	}
}

func TestSelfTestOutputLimitValidation(t *testing.T) {
	selfTestDB(t, "sqlite")
	for _, limit := range []uint{0, 1073741824, ^uint(0)} {
		group := selfTestGroupInput{Name: "limit", BaseURL: "https://example.com", Model: "model", Protocol: "responses", APIKey: "fixture", MaxOutputTokens: &limit}
		_, _, err := prepareSelfTestGroups(1, []selfTestGroupInput{group}, true)
		assert.Error(t, err)
	}
	limit := uint(65536)
	for _, protocol := range []string{"chat", "responses", "anthropic"} {
		group := selfTestGroupInput{Name: "limit", BaseURL: "https://example.com", Model: "model", Protocol: protocol, APIKey: "fixture", MaxOutputTokens: &limit}
		profiles, attempts, err := prepareSelfTestGroups(1, []selfTestGroupInput{group}, true)
		require.NoError(t, err)
		assert.Equal(t, &limit, profiles[0].MaxOutputTokens)
		assert.Equal(t, &limit, attempts[0].MaxOutputTokens)
	}
}
