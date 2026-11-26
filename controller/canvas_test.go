package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type canvasTestClient struct {
	router      *gin.Engine
	accessToken string
	userID      int
}

func (client canvasTestClient) request(method, path, contentType string, body []byte, extraHeaders ...http.Header) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if client.accessToken != "" {
		request.Header.Set("Authorization", "Bearer "+client.accessToken)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	for _, headers := range extraHeaders {
		maps.Copy(request.Header, headers)
	}
	response := httptest.NewRecorder()
	client.router.ServeHTTP(response, request)
	return response
}

func newCanvasTestClient(t *testing.T, db *gorm.DB, name string, router *gin.Engine) canvasTestClient {
	t.Helper()
	user := model.User{Username: name, AffCode: name, Password: "unused", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1}
	require.NoError(t, db.Create(&user).Error)
	now := common.GetTimestamp()
	session := model.UserSession{
		SID: "canvas-test-" + name, UserID: user.Id, Version: 1, UserAuthVersion: 1,
		Status: model.UserSessionStatusActive, RefreshHash: "test-refresh-hash", LoginMethod: "password",
		CreatedAt: now, LastActiveAt: now, ExpiresAt: now + 3600,
	}
	require.NoError(t, db.Create(&session).Error)
	accessToken, _, err := service.IssueAccessToken(service.AuthIdentity{UserID: user.Id, SessionID: session.SID, UserAuthVersion: 1, SessionVersion: 1})
	require.NoError(t, err)
	return canvasTestClient{router: router, accessToken: accessToken, userID: user.Id}
}

func TestCanvasDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			t.Setenv("CANVAS_STORAGE_LIMIT_MB", "512")
			var driver gorm.Dialector
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(filepath.ToSlash(filepath.Join(t.TempDir(), "canvas.db")) + "?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)")
			case "mysql":
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN is not configured")
				}
				driver = mysql.Open(dsn)
			case "postgres":
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN is not configured")
				}
				driver = postgres.New(postgres.Config{DSN: dsn, PreferSimpleProtocol: true})
			}
			db, err := gorm.Open(driver, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(8)
			// External databases must be dedicated to this fixture.
			for _, table := range []string{"users", "tokens", "canvas_accounts", "canvas_objects", "user_sessions", "user_access_tokens", "audit_logs"} {
				require.False(t, db.Migrator().HasTable(table), "refusing to modify existing table %s", table)
			}
			previousDB, previousLogDB := model.DB, model.LOG_DB
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousRedis, previousSecret := common.RedisEnabled, common.SessionSecret
			previousAuto, previousUsable := setting.AutoGroups2JsonString(), setting.UserUsableGroups2JSONString()
			previousRatios := ratio_setting.GroupRatio2JSONString()
			previousTokenLimit := operation_setting.GetMaxUserTokens()
			model.DB, model.LOG_DB = db, db
			common.SetDatabaseTypes(common.DatabaseType(dialect), common.DatabaseType(dialect))
			common.RedisEnabled, common.SessionSecret = false, "canvas-test-session-secret"
			operation_setting.GetTokenSetting().MaxUserTokens = 1000
			require.NoError(t, setting.UpdateAutoGroupsByJsonString(`["default"]`))
			require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default","auto":"Auto"}`))
			require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1}`))
			t.Cleanup(func() {
				require.NoError(t, db.Migrator().DropTable(&model.CanvasAccount{}, &model.CanvasObject{}, &model.UserSession{}, &model.UserAccessToken{}, &model.AuditLog{}, &model.Token{}, &model.User{}))
				model.DB, model.LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.RedisEnabled, common.SessionSecret = previousRedis, previousSecret
				operation_setting.GetTokenSetting().MaxUserTokens = previousTokenLimit
				require.NoError(t, setting.UpdateAutoGroupsByJsonString(previousAuto))
				require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(previousUsable))
				require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(previousRatios))
				require.NoError(t, sqlDB.Close())
			})
			var version string
			versionQuery := "SELECT version()"
			if dialect == "sqlite" {
				versionQuery = "SELECT sqlite_version()"
			}
			require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
			t.Logf("database version: %s", version)
			// Upgrade a database with existing accounts and keys; only new tables
			// are introduced, and both migrations must preserve the old records.
			require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.UserSession{}, &model.UserAccessToken{}, &model.AuditLog{}))
			legacy := model.User{Username: "legacy-canvas", Password: "preserved-password", Group: "default", Status: common.UserStatusEnabled, AuthVersion: 1}
			require.NoError(t, db.Create(&legacy).Error)
			oldToken := model.Token{UserId: legacy.Id, Key: "legacy-preserved-api-key", Name: "Existing", Group: "default", ExpiredTime: -1, UnlimitedQuota: true}
			require.NoError(t, db.Create(&oldToken).Error)
			for range 2 {
				require.NoError(t, db.AutoMigrate(&model.CanvasAccount{}, &model.CanvasObject{}))
			}
			var preservedUser model.User
			var preservedToken model.Token
			require.NoError(t, db.First(&preservedUser, legacy.Id).Error)
			require.NoError(t, db.First(&preservedToken, oldToken.Id).Error)
			assert.Equal(t, legacy.Password, preservedUser.Password)
			assert.Equal(t, oldToken.Key, preservedToken.Key)
			assert.True(t, db.Migrator().HasIndex(&model.Token{}, "idx_tokens_key"))
			gin.SetMode(gin.TestMode)
			router := gin.New()
			canvas := router.Group("/api/canvas", middleware.DisableCache(), middleware.UserAuth(), CanvasSessionAuth)
			canvas.POST("/bootstrap", BootstrapCanvas)
			canvas.POST("/reset-token", ResetCanvasToken)
			canvas.GET("/storage/:collection", CanvasStorage)
			canvas.DELETE("/storage/:collection", CanvasStorage)
			canvas.GET("/storage/:collection/*key", CanvasStorage)
			canvas.PUT("/storage/:collection/*key", CanvasStorage)
			canvas.DELETE("/storage/:collection/*key", CanvasStorage)
			client := newCanvasTestClient(t, db, "canvas-owner", router)
			other := newCanvasTestClient(t, db, "canvas-other", router)
			verifyCanvasBootstrap(t, db, client, other)
			t.Run("enterprise_groups", func(t *testing.T) {
				member := newCanvasTestClient(t, db, "enterprise-canvas", router)
				const endpoint = "/api/canvas/bootstrap"
				require.NoError(t, db.Model(&model.User{}).Where("id = ?", member.userID).Update("enterprise_group_limits", `[]`).Error)
				response := member.request(http.MethodPost, endpoint, "", nil)
				assert.Equal(t, http.StatusForbidden, response.Code)
				assert.Contains(t, response.Body.String(), "CANVAS_AUTO_UNAVAILABLE")
				var count int64
				require.NoError(t, db.Model(&model.Token{}).Where("user_id = ?", member.userID).Count(&count).Error)
				assert.Zero(t, count, "an empty enterprise allowlist must not provision a key")
				require.NoError(t, db.Model(&model.User{}).Where("id = ?", member.userID).Update("enterprise_group_limits", `["default"]`).Error)
				response = member.request(http.MethodPost, endpoint, "", nil)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				var token model.Token
				require.NoError(t, db.Where("user_id = ?", member.userID).First(&token).Error)
				require.NoError(t, db.Model(&token).Update("auto_groups", `["forbidden"]`).Error)
				assert.Equal(t, http.StatusForbidden, member.request(http.MethodPost, endpoint, "", nil).Code)
				require.NoError(t, db.Model(&token).Update("auto_groups", `["default"]`).Error)
				assert.Equal(t, http.StatusOK, member.request(http.MethodPost, endpoint, "", nil).Code)
				require.NoError(t, db.Model(&model.User{}).Where("id = ?", member.userID).Update("enterprise_group_limits", `[]`).Error)
				assert.Equal(t, http.StatusForbidden, member.request(http.MethodPost, endpoint, "", nil).Code)
				require.NoError(t, db.Where("user_id = ?", member.userID).First(&token).Error)
				assert.Equal(t, `["default"]`, token.AutoGroups, "permission changes must not rewrite the user's credential")
			})
			verifyCanvasStorage(t, db, client, other)
			t.Run("storage_quota", func(t *testing.T) {
				quotaOwner := newCanvasTestClient(t, db, "quota-owner", router)
				quotaOther := newCanvasTestClient(t, db, "quota-other", router)
				verifyCanvasStorageQuota(t, quotaOwner, quotaOther)
			})
			t.Run("conditional_chats", func(t *testing.T) {
				conditionalOwner := newCanvasTestClient(t, db, "conditional-owner", router)
				conditionalOther := newCanvasTestClient(t, db, "conditional-other", router)
				verifyCanvasConditionalChats(t, conditionalOwner, conditionalOther)
			})
			verifyCanvasSessionBoundary(t, db, client)
			// Repeated startup after real writes preserves both the binding and
			// binary data, rather than only succeeding against empty tables.
			for range 2 {
				require.NoError(t, db.AutoMigrate(&model.CanvasAccount{}, &model.CanvasObject{}))
			}
			object, err := model.GetCanvasObject(context.Background(), other.userID, "projects", "shared-key")
			require.NoError(t, err)
			assert.JSONEq(t, `{"owner":"other"}`, string(object.Data))
		})
	}
}

func verifyCanvasBootstrap(t *testing.T, db *gorm.DB, client, other canvasTestClient) {
	t.Helper()
	const endpoint = "/api/canvas/bootstrap"
	// Two requests start together against the same previously unseen account.
	responses := make([]*httptest.ResponseRecorder, 2)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for i := range responses {
		workers.Go(func() { <-start; responses[i] = client.request(http.MethodPost, endpoint, "", nil) })
	}
	close(start)
	workers.Wait()
	var result struct {
		Success bool `json:"success"`
		Data    struct {
			UserID  int    `json:"user_id"`
			TokenID int    `json:"token_id"`
			APIKey  string `json:"api_key"`
			BaseURL string `json:"base_url"`
		} `json:"data"`
	}
	for _, response := range responses {
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
		assert.True(t, result.Success)
		assert.Equal(t, client.userID, result.Data.UserID)
		assert.Equal(t, "/v1", result.Data.BaseURL)
		assert.True(t, strings.HasPrefix(result.Data.APIKey, "sk-"))
		assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
	}
	assert.JSONEq(t, responses[0].Body.String(), responses[1].Body.String())
	var count int64
	require.NoError(t, db.Model(&model.Token{}).Where("user_id = ?", client.userID).Count(&count).Error)
	assert.EqualValues(t, 1, count)
	var token model.Token
	require.NoError(t, db.First(&token, result.Data.TokenID).Error)
	assert.True(t, token.UnlimitedQuota)
	assert.EqualValues(t, -1, token.ExpiredTime)
	assert.Equal(t, "auto", token.Group)
	assert.Empty(t, token.AutoGroups)
	third := client.request(http.MethodPost, endpoint, "", nil)
	require.Equal(t, http.StatusOK, third.Code, third.Body.String())
	assert.JSONEq(t, responses[0].Body.String(), third.Body.String())
	var audits []model.AuditLog
	require.NoError(t, db.Where("user_id = ? AND action = ?", client.userID, "canvas.token_access").Find(&audits).Error)
	require.Len(t, audits, 3)
	encoded, err := common.Marshal(audits)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), token.Key)
	assert.NotContains(t, string(encoded), client.accessToken)

	for _, test := range []struct {
		name, code string
		updates    map[string]any
	}{
		{"disabled", "CANVAS_TOKEN_DISABLED", map[string]any{"status": common.TokenStatusDisabled}},
		{"expired", "CANVAS_TOKEN_EXPIRED", map[string]any{"expired_time": common.GetTimestamp() - 1}},
		{"exhausted", "CANVAS_TOKEN_EXHAUSTED", map[string]any{"unlimited_quota": false, "remain_quota": 0}},
		{"group", "CANVAS_TOKEN_GROUP", map[string]any{"group": "default"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			require.NoError(t, db.Model(&model.Token{}).Where("id = ?", token.Id).Updates(test.updates).Error)
			response := client.request(http.MethodPost, endpoint, "", nil)
			assert.Equal(t, http.StatusConflict, response.Code)
			assert.Contains(t, response.Body.String(), test.code)
			reset := client.request(http.MethodPost, "/api/canvas/reset-token", "", nil)
			assert.Equal(t, http.StatusConflict, reset.Code)
			assert.Contains(t, reset.Body.String(), "CANVAS_TOKEN_NOT_DELETED")
			require.NoError(t, db.Model(&model.Token{}).Where("id = ?", token.Id).Updates(map[string]any{"status": common.TokenStatusEnabled, "expired_time": -1, "unlimited_quota": true, "group": "auto"}).Error)
		})
	}
	operation_setting.GetTokenSetting().MaxUserTokens = 0
	limited := other.request(http.MethodPost, endpoint, "", nil)
	assert.Equal(t, http.StatusConflict, limited.Code)
	assert.Contains(t, limited.Body.String(), "CANVAS_TOKEN_LIMIT")
	operation_setting.GetTokenSetting().MaxUserTokens = 1000
	require.NoError(t, db.Model(&model.CanvasAccount{}).Where("user_id = ?", other.userID).Count(&count).Error)
	assert.Zero(t, count, "failed initialization must roll back the reserved account")
	require.NoError(t, setting.UpdateAutoGroupsByJsonString(`[]`))
	unavailable := other.request(http.MethodPost, endpoint, "", nil)
	assert.Equal(t, http.StatusForbidden, unavailable.Code)
	assert.Contains(t, unavailable.Body.String(), "CANVAS_AUTO_UNAVAILABLE")
	require.NoError(t, setting.UpdateAutoGroupsByJsonString(`["default"]`))
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default"}`))
	assert.Equal(t, http.StatusForbidden, client.request(http.MethodPost, endpoint, "", nil).Code)
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default","auto":"Auto"}`))
	require.NoError(t, db.Delete(&token).Error)
	deleted := client.request(http.MethodPost, endpoint, "", nil)
	assert.Equal(t, http.StatusConflict, deleted.Code)
	assert.Contains(t, deleted.Body.String(), "CANVAS_TOKEN_DELETED")
	require.NoError(t, db.Unscoped().Model(&model.Token{}).Where("user_id = ?", client.userID).Count(&count).Error)
	assert.EqualValues(t, 1, count, "deleted credential must not be recreated")
	resetResponses := make([]*httptest.ResponseRecorder, 2)
	resetStart := make(chan struct{})
	for i := range resetResponses {
		workers.Go(func() {
			<-resetStart
			resetResponses[i] = client.request(http.MethodPost, "/api/canvas/reset-token", "", nil)
		})
	}
	close(resetStart)
	workers.Wait()
	assert.ElementsMatch(t, []int{http.StatusOK, http.StatusConflict}, []int{resetResponses[0].Code, resetResponses[1].Code})
	require.NoError(t, db.Unscoped().Model(&model.Token{}).Where("user_id = ?", client.userID).Count(&count).Error)
	assert.EqualValues(t, 2, count, "concurrent explicit replacements create only one new credential")
	response := client.request(http.MethodPost, endpoint, "", nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.NotContains(t, response.Body.String(), token.Key)
}

func verifyCanvasStorage(t *testing.T, db *gorm.DB, client, other canvasTestClient) {
	t.Helper()
	const prefix = "/api/canvas/storage/"
	first := []byte(`{"owner":"first","nodes":[{"id":"a","x":0}],"future":false}`)
	second := []byte(`{"owner":"other"}`)
	require.Equal(t, http.StatusOK, client.request(http.MethodPut, prefix+"projects/shared-key", "application/json", first).Code)
	require.Equal(t, http.StatusOK, other.request(http.MethodPut, prefix+"projects/shared-key", "application/json", second).Code)
	assert.JSONEq(t, string(first), client.request(http.MethodGet, prefix+"projects/shared-key", "", nil).Body.String())
	assert.JSONEq(t, string(second), other.request(http.MethodGet, prefix+"projects/shared-key", "", nil).Body.String())
	assert.Equal(t, http.StatusNotFound, other.request(http.MethodGet, prefix+"works/missing", "", nil).Code)
	key := "图像 Folder/A%?\\b"
	path := prefix + "images/" + url.PathEscape(key)
	binary := bytes.Repeat([]byte{0, 255, 1, 128}, 32769)
	response := client.request(http.MethodPut, path, "image/png", binary)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	response = client.request(http.MethodGet, path, "", nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, binary, response.Body.Bytes())
	assert.Equal(t, "image/png", response.Header().Get("Content-Type"))
	assert.Equal(t, "nosniff", response.Header().Get("X-Content-Type-Options"))
	assert.Equal(t, "attachment", response.Header().Get("Content-Disposition"))
	assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
	assert.Equal(t, http.StatusNotFound, other.request(http.MethodGet, path, "", nil).Code)
	assert.JSONEq(t, `{"success":true,"message":"","data":{"keys":["`+strings.ReplaceAll(strings.ReplaceAll(key, "\\", "\\\\"), "\"", "\\\"")+`"]}}`, client.request(http.MethodGet, prefix+"images", "", nil).Body.String())
	for _, name := range []string{"Key", "key"} {
		require.Equal(t, http.StatusOK, client.request(http.MethodPut, prefix+"state/"+name, "application/json", []byte(`0`)).Code)
	}
	var listed struct {
		Data struct {
			Keys []string `json:"keys"`
		} `json:"data"`
	}
	response = client.request(http.MethodGet, prefix+"state", "", nil)
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &listed))
	assert.ElementsMatch(t, []string{"Key", "key"}, listed.Data.Keys)
	require.Equal(t, http.StatusOK, client.request(http.MethodPut, prefix+"state/Key", "application/json", []byte(`false`)).Code)
	assert.Equal(t, "false", client.request(http.MethodGet, prefix+"state/Key", "", nil).Body.String())
	require.Equal(t, http.StatusOK, client.request(http.MethodDelete, prefix+"projects/shared-key", "", nil).Code)
	assert.Equal(t, http.StatusNotFound, client.request(http.MethodGet, prefix+"projects/shared-key", "", nil).Code)
	assert.JSONEq(t, string(second), other.request(http.MethodGet, prefix+"projects/shared-key", "", nil).Body.String())
	require.Equal(t, http.StatusOK, client.request(http.MethodDelete, prefix+"projects?user_id="+fmt.Sprint(other.userID), "", nil).Code)
	assert.JSONEq(t, string(second), other.request(http.MethodGet, prefix+"projects/shared-key", "", nil).Body.String())
	require.Equal(t, http.StatusOK, client.request(http.MethodDelete, prefix+"images", "", nil).Code)
	assert.Equal(t, http.StatusNotFound, client.request(http.MethodGet, path, "", nil).Code)
	assert.Equal(t, http.StatusBadRequest, client.request(http.MethodPut, prefix+"projects/bad", "application/json", []byte(`{`)).Code)
	assert.Equal(t, http.StatusBadRequest, client.request(http.MethodPut, prefix+"unknown/key", "application/json", []byte(`null`)).Code)
	assert.Equal(t, http.StatusBadRequest, client.request(http.MethodPut, prefix+"projects/"+strings.Repeat("a", 513), "application/json", []byte(`null`)).Code)
	assert.Equal(t, http.StatusBadRequest, client.request(http.MethodPut, prefix+"projects/key", "invalid", []byte(`null`)).Code)
	assert.Equal(t, http.StatusBadRequest, client.request(http.MethodPut, prefix+"projects/%00", "application/json", []byte(`null`)).Code)
	oversize := make([]byte, model.MaxCanvasObjectBytes+1)
	assert.Equal(t, http.StatusRequestEntityTooLarge, client.request(http.MethodPut, prefix+"media/large", "application/octet-stream", oversize).Code)
	request := httptest.NewRequest(http.MethodPut, prefix+"media/chunked", bytes.NewReader(oversize))
	request.ContentLength = -1
	request.Header.Set("Authorization", "Bearer "+client.accessToken)
	response = httptest.NewRecorder()
	client.router.ServeHTTP(response, request)
	assert.Equal(t, http.StatusRequestEntityTooLarge, response.Code)
	maximum := oversize[:model.MaxCanvasObjectBytes]
	response = client.request(http.MethodPut, prefix+"media/maximum", "application/octet-stream", maximum)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	response = client.request(http.MethodGet, prefix+"media/maximum", "", nil)
	require.Equal(t, http.StatusOK, response.Code)
	assert.Equal(t, sha256.Sum256(maximum), sha256.Sum256(response.Body.Bytes()))
	objects := make([]model.CanvasObject, model.MaxCanvasCollectionKeys-1)
	for i := range objects {
		key := fmt.Sprintf("key-%d", i)
		objects[i] = model.CanvasObject{UserID: client.userID, Collection: "works", RecordKey: key, ObjectHash: fmt.Sprintf("%x", sha256.Sum256([]byte("works\x00"+key))), Data: []byte(`null`), ContentType: "application/json", UpdatedAt: common.GetTimestamp()}
	}
	require.NoError(t, db.CreateInBatches(objects, 500).Error)
	// Both writers see the final free slot; only one new key may commit.
	capacityResponses := make([]*httptest.ResponseRecorder, 2)
	capacityStart := make(chan struct{})
	var capacityWorkers sync.WaitGroup
	for i := range capacityResponses {
		capacityWorkers.Go(func() {
			<-capacityStart
			capacityResponses[i] = client.request(http.MethodPut, prefix+fmt.Sprintf("works/final-slot-%d", i), "application/json", []byte(`null`))
		})
	}
	close(capacityStart)
	capacityWorkers.Wait()
	assert.ElementsMatch(t, []int{http.StatusOK, http.StatusConflict}, []int{capacityResponses[0].Code, capacityResponses[1].Code})
	response = client.request(http.MethodPut, prefix+"works/one-too-many", "application/json", []byte(`null`))
	assert.Equal(t, http.StatusConflict, response.Code)
	assert.Contains(t, response.Body.String(), "CANVAS_COLLECTION_TOO_LARGE")
	response = client.request(http.MethodPut, prefix+"works/key-0", "application/json", []byte(`false`))
	assert.Equal(t, http.StatusOK, response.Code, "existing objects remain editable at the limit")
	legacyExtra := model.CanvasObject{UserID: client.userID, Collection: "works", RecordKey: "legacy-extra", ObjectHash: fmt.Sprintf("%x", sha256.Sum256([]byte("works\x00legacy-extra"))), Data: []byte(`null`), ContentType: "application/json", UpdatedAt: common.GetTimestamp()}
	require.NoError(t, db.Create(&legacyExtra).Error)
	response = client.request(http.MethodGet, prefix+"works", "", nil)
	assert.Equal(t, http.StatusConflict, response.Code)
	assert.Contains(t, response.Body.String(), "CANVAS_COLLECTION_TOO_LARGE")
	assert.NotContains(t, response.Body.String(), "key-9999")
}

func verifyCanvasStorageQuota(t *testing.T, client, other canvasTestClient) {
	t.Helper()
	t.Setenv("CANVAS_STORAGE_LIMIT_MB", "1")
	const prefix = "/api/canvas/storage/"
	const halfMiB = 512 * 1024
	payload := bytes.Repeat([]byte{0, 255, 1, 128}, halfMiB)
	for _, path := range []string{"images/a", "state/b"} {
		response := client.request(http.MethodPut, prefix+path, "application/octet-stream", payload[:halfMiB])
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	}
	// All collections share a budget, while another account has its own budget.
	response := client.request(http.MethodPut, prefix+"media/c", "application/octet-stream", payload[:1])
	assert.Equal(t, http.StatusConflict, response.Code)
	assert.Contains(t, response.Body.String(), "CANVAS_STORAGE_QUOTA_EXCEEDED")
	response = other.request(http.MethodPut, prefix+"media/other", "application/octet-stream", payload[:2*halfMiB])
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	// Replacing an object counts only its growth, and rejection preserves it.
	response = client.request(http.MethodPut, prefix+"images/a", "application/octet-stream", payload[:halfMiB])
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	response = client.request(http.MethodPut, prefix+"images/a", "application/octet-stream", payload[:halfMiB+1])
	assert.Equal(t, http.StatusConflict, response.Code)
	assert.Equal(t, payload[:halfMiB], client.request(http.MethodGet, prefix+"images/a", "", nil).Body.Bytes())
	response = client.request(http.MethodPut, prefix+"images/a", "application/octet-stream", payload[:halfMiB/2])
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	response = client.request(http.MethodPut, prefix+"media/c", "application/octet-stream", payload[:halfMiB/2])
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	// Individual and collection deletion both release their actual payload bytes.
	require.Equal(t, http.StatusOK, client.request(http.MethodDelete, prefix+"state/b", "", nil).Code)
	response = client.request(http.MethodPut, prefix+"media/d", "application/octet-stream", payload[:halfMiB])
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, http.StatusOK, client.request(http.MethodDelete, prefix+"media", "", nil).Code)
	response = client.request(http.MethodPut, prefix+"state/b", "application/octet-stream", payload[:3*halfMiB/2])
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	// Lowering the limit never prevents reducing an account that is already over it.
	t.Setenv("CANVAS_STORAGE_LIMIT_MB", "2")
	response = client.request(http.MethodPut, prefix+"state/b", "application/octet-stream", payload[:3*halfMiB])
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	t.Setenv("CANVAS_STORAGE_LIMIT_MB", "1")
	response = client.request(http.MethodPut, prefix+"state/b", "application/octet-stream", payload[:5*halfMiB/2])
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	response = client.request(http.MethodPut, prefix+"state/b", "application/octet-stream", payload[:5*halfMiB/2+1])
	assert.Equal(t, http.StatusConflict, response.Code)
	response = client.request(http.MethodPut, prefix+"media/new", "application/octet-stream", payload[:1])
	assert.Equal(t, http.StatusConflict, response.Code)
	require.Equal(t, http.StatusOK, client.request(http.MethodDelete, prefix+"state/b", "", nil).Code)
	response = client.request(http.MethodPut, prefix+"images/a", "application/octet-stream", payload[:halfMiB])
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	// Competing writers in different collections cannot both consume the last space.
	paths := []string{"state/final", "media/final"}
	responses := make([]*httptest.ResponseRecorder, len(paths))
	start := make(chan struct{})
	var workers sync.WaitGroup
	for i := range paths {
		workers.Go(func() {
			<-start
			responses[i] = client.request(http.MethodPut, prefix+paths[i], "application/octet-stream", payload[:halfMiB])
		})
	}
	close(start)
	workers.Wait()
	assert.ElementsMatch(t, []int{http.StatusOK, http.StatusConflict}, []int{responses[0].Code, responses[1].Code})
	for i, response := range responses {
		stored := client.request(http.MethodGet, prefix+paths[i], "", nil)
		if response.Code == http.StatusOK {
			assert.Equal(t, payload[:halfMiB], stored.Body.Bytes())
		} else {
			assert.Contains(t, response.Body.String(), "CANVAS_STORAGE_QUOTA_EXCEEDED")
			assert.Equal(t, http.StatusNotFound, stored.Code)
		}
	}
	// Removing the overwritten object cannot make its old size get subtracted
	// twice. The replacement plus the other half-MiB object never fits.
	deleteStart := make(chan struct{})
	var deleted, replaced *httptest.ResponseRecorder
	workers.Go(func() {
		<-deleteStart
		deleted = client.request(http.MethodDelete, prefix+"images/a", "", nil)
	})
	workers.Go(func() {
		<-deleteStart
		replaced = client.request(http.MethodPut, prefix+"images/a", "application/octet-stream", payload[:2*halfMiB])
	})
	close(deleteStart)
	workers.Wait()
	assert.Equal(t, http.StatusOK, deleted.Code)
	assert.Equal(t, http.StatusConflict, replaced.Code)
	assert.Contains(t, replaced.Body.String(), "CANVAS_STORAGE_QUOTA_EXCEEDED")
	assert.Equal(t, http.StatusNotFound, client.request(http.MethodGet, prefix+"images/a", "", nil).Code)
}

func verifyCanvasConditionalChats(t *testing.T, client, other canvasTestClient) {
	t.Helper()
	t.Setenv("CANVAS_STORAGE_LIMIT_MB", "1")
	const endpoint = "/api/canvas/storage/chats/chat-1"
	first := []byte(`{"id":"chat-1","messages":[]}`)
	second := []byte(`{"id":"chat-1","messages":["first"]}`)
	absent := http.Header{"If-None-Match": {"*"}}
	firstMatch := http.Header{"If-Match": {fmt.Sprintf(`"%x"`, sha256.Sum256(first))}}
	response := client.request(http.MethodPut, endpoint, "application/json", first, absent)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	response = client.request(http.MethodPut, endpoint, "application/json", second, absent)
	assert.Equal(t, http.StatusPreconditionFailed, response.Code)
	assert.Contains(t, response.Body.String(), "CANVAS_STORAGE_CONFLICT")
	assert.Equal(t, first, client.request(http.MethodGet, endpoint, "", nil).Body.Bytes())
	stale := http.Header{"If-Match": {`"` + strings.Repeat("0", 64) + `"`}}
	response = client.request(http.MethodPut, endpoint, "application/json", second, stale)
	assert.Equal(t, http.StatusPreconditionFailed, response.Code)
	response = client.request(http.MethodPut, "/api/canvas/storage/chats/missing", "application/json", second, firstMatch)
	assert.Equal(t, http.StatusPreconditionFailed, response.Code)
	assert.Equal(t, http.StatusNotFound, client.request(http.MethodGet, "/api/canvas/storage/chats/missing", "", nil).Code)
	// Identical keys in another account cannot satisfy this account's condition.
	response = other.request(http.MethodPut, endpoint, "application/json", second, firstMatch)
	assert.Equal(t, http.StatusPreconditionFailed, response.Code)
	response = other.request(http.MethodPut, endpoint, "application/json", second, absent)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, first, client.request(http.MethodGet, endpoint, "", nil).Body.Bytes())
	response = client.request(http.MethodPut, endpoint, "application/json", second, firstMatch)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, second, client.request(http.MethodGet, endpoint, "", nil).Body.Bytes())
	response = client.request(http.MethodPut, endpoint, "application/json", first, firstMatch)
	assert.Equal(t, http.StatusPreconditionFailed, response.Code)

	for _, invalid := range []http.Header{
		{"If-Match": firstMatch["If-Match"], "If-None-Match": {"*"}},
		{"If-Match": {fmt.Sprintf("%x", sha256.Sum256(first))}},
		{"If-Match": {strings.ToUpper(firstMatch.Get("If-Match"))}},
		{"If-Match": {"W/" + firstMatch.Get("If-Match")}},
		{"If-Match": {firstMatch.Get("If-Match"), firstMatch.Get("If-Match")}},
		{"If-Match": {""}},
		{"If-None-Match": {firstMatch.Get("If-Match")}},
	} {
		response = client.request(http.MethodPut, endpoint, "application/json", first, invalid)
		assert.Equal(t, http.StatusBadRequest, response.Code)
		assert.Contains(t, response.Body.String(), "CANVAS_STORAGE_CONDITION_INVALID")
	}
	assert.Equal(t, http.StatusBadRequest, client.request(http.MethodPut, "/api/canvas/storage/projects/chat-1", "application/json", first, absent).Code)
	assert.Equal(t, http.StatusBadRequest, client.request(http.MethodGet, endpoint, "", nil, firstMatch).Code)
	assert.Equal(t, second, client.request(http.MethodGet, endpoint, "", nil).Body.Bytes())
	// Only one caller may replace the same snapshot even when both start together.
	secondMatch := http.Header{"If-Match": {fmt.Sprintf(`"%x"`, sha256.Sum256(second))}}
	candidates := [][]byte{[]byte(`{"id":"chat-1","messages":["winner-a"]}`), []byte(`{"id":"chat-1","messages":["winner-b"]}`)}
	responses := make([]*httptest.ResponseRecorder, len(candidates))
	start := make(chan struct{})
	var workers sync.WaitGroup
	for i := range candidates {
		workers.Go(func() {
			<-start
			responses[i] = client.request(http.MethodPut, endpoint, "application/json", candidates[i], secondMatch)
		})
	}
	close(start)
	workers.Wait()
	assert.ElementsMatch(t, []int{http.StatusOK, http.StatusPreconditionFailed}, []int{responses[0].Code, responses[1].Code})
	var winner []byte
	for i, response := range responses {
		if response.Code == http.StatusOK {
			winner = candidates[i]
		}
	}
	require.NotNil(t, winner)
	assert.Equal(t, winner, client.request(http.MethodGet, endpoint, "", nil).Body.Bytes())
	// A stale, oversized-for-quota write conflicts before quota evaluation and
	// leaves enough capacity to fill the account to its exact limit afterward.
	large := make([]byte, 2*1024*1024)
	response = client.request(http.MethodPut, endpoint, "application/octet-stream", large, secondMatch)
	assert.Equal(t, http.StatusPreconditionFailed, response.Code)
	assert.Contains(t, response.Body.String(), "CANVAS_STORAGE_CONFLICT")
	response = client.request(http.MethodPut, "/api/canvas/storage/media/quota-fill", "application/octet-stream", large[:1024*1024-len(winner)])
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	winnerMatch := http.Header{"If-Match": {fmt.Sprintf(`"%x"`, sha256.Sum256(winner))}}
	response = client.request(http.MethodPut, endpoint, "application/octet-stream", large, winnerMatch)
	assert.Equal(t, http.StatusConflict, response.Code)
	assert.Contains(t, response.Body.String(), "CANVAS_STORAGE_QUOTA_EXCEEDED")
	assert.Equal(t, winner, client.request(http.MethodGet, endpoint, "", nil).Body.Bytes())
	response = client.request(http.MethodPut, endpoint, "application/json", winner, winnerMatch)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
}

func verifyCanvasSessionBoundary(t *testing.T, db *gorm.DB, client canvasTestClient) {
	t.Helper()
	const endpoint = "/api/canvas/bootstrap"
	unauthenticated := client
	unauthenticated.accessToken = ""
	assert.Equal(t, http.StatusUnauthorized, unauthenticated.request(http.MethodPost, endpoint, "", nil).Code)
	assert.Equal(t, http.StatusUnauthorized, unauthenticated.request(http.MethodGet, "/api/canvas/storage/projects", "", nil).Code)
	pat := "12345678901234567890123456789012"
	require.NoError(t, db.Model(&model.User{}).Where("id = ?", client.userID).Update("access_token", pat).Error)
	unauthenticated.accessToken = pat
	response := unauthenticated.request(http.MethodPost, endpoint, "", nil)
	assert.Equal(t, http.StatusUnauthorized, response.Code)
	assert.Contains(t, response.Body.String(), "ACCESS_TOKEN_LEGACY_RETIRED")
	assert.Equal(t, http.StatusUnauthorized, unauthenticated.request(http.MethodGet, "/api/canvas/storage/projects", "", nil).Code)
	personalKey := model.AccessTokenPrefix + strings.Repeat("a", 43)
	personalToken := model.UserAccessToken{UserId: client.userID, Name: "Canvas boundary", TokenHash: model.AccessTokenFingerprint(personalKey), TokenHint: model.AccessTokenHint(personalKey), Scopes: `[]`, ExpiresAt: common.GetTimestamp() + 3600}
	require.NoError(t, db.Create(&personalToken).Error)
	unauthenticated.accessToken = personalKey
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, endpoint},
		{http.MethodPost, "/api/canvas/reset-token"},
		{http.MethodGet, "/api/canvas/storage/projects"},
		{http.MethodDelete, "/api/canvas/storage/projects"},
		{http.MethodGet, "/api/canvas/storage/projects/private"},
		{http.MethodPut, "/api/canvas/storage/projects/private"},
		{http.MethodDelete, "/api/canvas/storage/projects/private"},
	} {
		response := unauthenticated.request(route.method, route.path, "", nil)
		assert.Equal(t, http.StatusForbidden, response.Code, route.method+" "+route.path)
		assert.Contains(t, response.Body.String(), "AUTH_SESSION_REQUIRED")
	}
	var apiToken model.Token
	require.NoError(t, db.Where("user_id = ?", client.userID).First(&apiToken).Error)
	unauthenticated.accessToken = "sk-" + apiToken.Key
	assert.Equal(t, http.StatusUnauthorized, unauthenticated.request(http.MethodPost, endpoint, "", nil).Code)
	assert.Equal(t, http.StatusUnauthorized, unauthenticated.request(http.MethodGet, "/api/canvas/storage/projects", "", nil).Code)
	require.NoError(t, db.Model(&model.UserSession{}).Where("user_id = ?", client.userID).Update("expires_at", time.Now().Unix()-1).Error)
	assert.Equal(t, http.StatusUnauthorized, client.request(http.MethodGet, "/api/canvas/storage/projects", "", nil).Code)
	require.NoError(t, db.Model(&model.UserSession{}).Where("user_id = ?", client.userID).Updates(map[string]any{"expires_at": time.Now().Unix() + 3600, "status": model.UserSessionStatusRevoked}).Error)
	assert.Equal(t, http.StatusUnauthorized, client.request(http.MethodGet, "/api/canvas/storage/projects", "", nil).Code)
	require.NoError(t, db.Model(&model.UserSession{}).Where("user_id = ?", client.userID).Update("status", model.UserSessionStatusActive).Error)
	require.NoError(t, db.Model(&model.User{}).Where("id = ?", client.userID).Update("status", common.UserStatusDisabled).Error)
	assert.Equal(t, http.StatusUnauthorized, client.request(http.MethodGet, "/api/canvas/storage/projects", "", nil).Code)
}
