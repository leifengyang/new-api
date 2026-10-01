package controller

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/console_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestAnnouncementAudienceAndPublication(t *testing.T) {
	previous := *console_setting.GetConsoleSetting()
	previousDB, previousRedis, previousSecret := model.DB, common.RedisEnabled, common.SessionSecret
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}))
	model.DB, common.RedisEnabled, common.SessionSecret = db, false, "announcement-test-secret"
	t.Cleanup(func() {
		*console_setting.GetConsoleSetting() = previous
		model.DB, common.RedisEnabled, common.SessionSecret = previousDB, previousRedis, previousSecret
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
	})
	user := model.User{Username: "reader", Password: "unused", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1}
	require.NoError(t, db.Create(&user).Error)
	bundle, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "announcement-test")
	require.NoError(t, err)
	settings := console_setting.GetConsoleSetting()
	settings.AnnouncementsEnabled = true
	settings.AnnouncementsBanner = `{"imageUrl":"https://example.com/banner.png","linkUrl":"https://example.com/group","published":true,"revision":"banner-v1"}`
	settings.Announcements = `[
 {"id":1,"content":"legacy","publishDate":"2020-01-01T00:00:00Z"},
 {"id":2,"content":"public","publishDate":"2020-01-02T00:00:00Z","popupTarget":"home","published":true,"revision":"v1"},
 {"id":3,"content":"private","publishDate":"2020-01-03T00:00:00Z","popupTarget":"authenticated","published":true,"revision":"v1"},
 {"id":4,"content":"draft","publishDate":"2020-01-04T00:00:00Z","popupTarget":"home","published":false},
 {"id":5,"content":"future","publishDate":"2999-01-01T00:00:00Z","popupTarget":"home","published":true,"revision":"v1"}
 ]`
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/announcements", middleware.TryUserAuth(), GetAnnouncements)
	router.GET("/api/status", GetStatus)
	for _, tc := range []struct {
		name, path, token string
		expected          []string
	}{
		{"guest", "/api/announcements", "", []string{"public", "legacy"}},
		{"signed in", "/api/announcements", bundle.AccessToken, []string{"private", "public", "legacy"}},
		{"public status even with credentials", "/api/status", bundle.AccessToken, []string{"public", "legacy"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, tc.path, nil)
			if tc.token != "" {
				request.Header.Set("Authorization", "Bearer "+tc.token)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, http.StatusOK, response.Code)
			var body struct {
				Success bool
				Data    any
				Banner  *console_setting.AnnouncementBanner
			}
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
			require.True(t, body.Success)
			data := body.Data
			if tc.path == "/api/status" {
				data = body.Data.(map[string]any)["announcements"]
			} else {
				require.NotNil(t, body.Banner)
				assert.Equal(t, "https://example.com/banner.png", body.Banner.ImageURL)
				assert.Equal(t, "private, no-store", response.Header().Get("Cache-Control"))
			}
			names := []string{}
			for _, item := range data.([]any) {
				names = append(names, item.(map[string]any)["content"].(string))
			}
			assert.Equal(t, tc.expected, names)
		})
	}
	require.NoError(t, db.Model(&model.UserSession{}).Where("sid = ?", bundle.Session.SID).Update("expires_at", time.Now().Add(-time.Hour).Unix()).Error)
	for _, token := range []string{"invalid", bundle.AccessToken} {
		request := httptest.NewRequest(http.MethodGet, "/api/announcements", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if token == bundle.AccessToken {
			assert.NotEqual(t, http.StatusOK, response.Code)
		}
		assert.NotContains(t, response.Body.String(), `"private"`)
	}
	settings.AnnouncementsEnabled = false
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/announcements", nil))
	assert.JSONEq(t, `{"success":true,"data":[],"banner":null}`, response.Body.String())
	settings.AnnouncementsEnabled = true
	settings.AnnouncementsBanner = `{"imageUrl":"https://example.com/draft.png","published":false}`
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/announcements", nil))
	assert.NotContains(t, response.Body.String(), "draft.png")
}

func TestAnnouncementPublicationValidation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		fields map[string]any
		valid  bool
	}{
		{"draft", map[string]any{"popupTarget": "home", "published": false}, true},
		{"confirmed", map[string]any{"popupTarget": "authenticated", "published": true, "revision": "v1"}, true},
		{"missing confirmation", map[string]any{"popupTarget": "home"}, false},
		{"missing revision", map[string]any{"popupTarget": "home", "published": true}, false},
		{"unknown target", map[string]any{"popupTarget": "everyone", "published": false}, false},
		{"invalid state", map[string]any{"published": "true"}, false},
		{"title", map[string]any{"title": "Service update"}, true},
		{"empty title", map[string]any{"title": " "}, false},
		{"long title", map[string]any{"title": strings.Repeat("a", 101)}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.fields["content"], tc.fields["publishDate"] = "announcement", "2020-01-01T00:00:00Z"
			encoded, err := common.Marshal([]map[string]any{tc.fields})
			require.NoError(t, err)
			err = console_setting.ValidateConsoleSettings(string(encoded), "Announcements")
			if tc.valid {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestAnnouncementBannerValidation(t *testing.T) {
	png := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII="
	for _, tc := range []struct {
		name   string
		banner console_setting.AnnouncementBanner
		valid  bool
	}{
		{"remote draft", console_setting.AnnouncementBanner{ImageURL: "https://example.com/image.png"}, true},
		{"upload", console_setting.AnnouncementBanner{ImageURL: png, Published: true, Revision: "v1"}, true},
		{"unconfirmed", console_setting.AnnouncementBanner{ImageURL: png, Published: true}, false},
		{"missing image", console_setting.AnnouncementBanner{Published: true, Revision: "v1"}, false},
		{"unsafe image", console_setting.AnnouncementBanner{ImageURL: "javascript:alert(1)"}, false},
		{"unsafe link", console_setting.AnnouncementBanner{ImageURL: png, LinkURL: png}, false},
		{"fake image", console_setting.AnnouncementBanner{ImageURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("<script>alert(1)</script>"))}, false},
		{"oversized upload", console_setting.AnnouncementBanner{ImageURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 1024*1024+1)))}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			encoded, err := common.Marshal(tc.banner)
			require.NoError(t, err)
			err = console_setting.ValidateConsoleSettings(string(encoded), "AnnouncementsBanner")
			if tc.valid {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
		})
	}
}
