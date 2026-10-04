package controller

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func logoPNG(t *testing.T, width int) []byte {
	t.Helper()
	var data bytes.Buffer
	require.NoError(t, png.Encode(&data, image.NewRGBA(image.Rect(0, 0, width, 1))))
	return data.Bytes()
}

func TestLogoImageValidation(t *testing.T) {
	valid := logoPNG(t, 1)
	for _, tc := range []struct {
		name, value string
		valid       bool
	}{
		{"empty", "", true}, {"URL", "https://example.com/logo.svg", true},
		{"png", "data:image/png;base64," + base64.StdEncoding.EncodeToString(valid), true},
		{"wrong MIME", "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(valid), false},
		{"SVG", "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte("<svg/>")), false},
		{"bad base64", "data:image/png;base64,!!!", false},
		{"empty data", "data:image/png;base64,", false},
		{"oversized", "data:image/png;base64," + base64.StdEncoding.EncodeToString(make([]byte, maxLogoImageBytes+1)), false},
		{"corrupt", "data:image/png;base64," + base64.StdEncoding.EncodeToString(valid[:len(valid)/2]), false},
		{"dimensions", "data:image/png;base64," + base64.StdEncoding.EncodeToString(logoPNG(t, 4097)), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.valid {
				assert.NoError(t, validateLogoImage(tc.value))
			} else {
				assert.Error(t, validateLogoImage(tc.value))
			}
		})
	}
}

func TestLogoUploadDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver gorm.Dialector
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(filepath.Join(t.TempDir(), "logo.db"))
			case "mysql":
				dsn := os.Getenv("TEST_LOGO_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_LOGO_MYSQL_DSN not configured")
				}
				driver = mysql.Open(dsn)
			case "postgres":
				dsn := os.Getenv("TEST_LOGO_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_LOGO_POSTGRES_DSN not configured")
				}
				driver = postgres.Open(dsn)
			}
			db, err := gorm.Open(driver, &gorm.Config{})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			previousDB, previousLogo, previousOptions := model.DB, common.Logo, common.OptionMap
			previousLogDB, previousRedis := model.LOG_DB, common.RedisEnabled
			previousMainType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
			model.LOG_DB, common.RedisEnabled = db, false
			common.SetMainDatabaseType(common.DatabaseType(dialect))
			common.SetLogDatabaseType(common.DatabaseType(dialect))
			model.DB = db
			common.OptionMap = make(map[string]string)
			t.Cleanup(func() {
				model.DB = previousDB
				model.LOG_DB, common.RedisEnabled = previousLogDB, previousRedis
				common.SetMainDatabaseType(previousMainType)
				common.SetLogDatabaseType(previousLogType)
				_ = db.Migrator().DropTable(&model.User{}, &model.AuditLog{})
				common.Logo = previousLogo
				common.OptionMap = previousOptions
				_ = db.Migrator().DropTable(&model.Option{})
				_ = sqlDB.Close()
			})
			require.NoError(t, db.AutoMigrate(&model.Option{}, &model.User{}, &model.AuditLog{}))
			operator := model.User{Username: "logo-test-root", Password: "unused", Role: common.RoleRootUser}
			require.NoError(t, db.Create(&operator).Error)
			versionQuery := "SELECT VERSION()"
			if dialect == "sqlite" {
				versionQuery = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
			t.Logf("Database version: %s", version)
			require.NoError(t, db.Create(&model.Option{Key: "Logo", Value: "https://example.com/previous.png"}).Error)
			require.NoError(t, db.Create(&model.Option{Key: "SystemName", Value: "New API"}).Error)
			// A valid PNG with padding exercises the complete accepted size, beyond MySQL TEXT.
			pngData := logoPNG(t, 1)
			pngData = append(pngData, make([]byte, maxLogoImageBytes-len(pngData))...)
			value := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngData)
			require.NoError(t, validateLogoImage(value))
			router := gin.New()
			router.PUT("/api/option/", func(c *gin.Context) { c.Set("id", operator.Id); c.Set("role", common.RoleRootUser); c.Next() }, UpdateOption)
			for _, next := range []string{value, "https://example.com/replaced.png", ""} {
				payload, err := common.Marshal(map[string]string{"key": "Logo", "value": next})
				require.NoError(t, err)
				request := httptest.NewRequest(http.MethodPut, "/api/option/", bytes.NewReader(payload))
				request.Header.Set("Content-Type", "application/json")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				require.Equal(t, http.StatusOK, response.Code)
				var result struct{ Success bool }
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
				require.True(t, result.Success)
				var saved model.Option
				require.NoError(t, db.Where(&model.Option{Key: "Logo"}).First(&saved).Error)
				assert.Equal(t, next, saved.Value)
				assert.Equal(t, next, common.Logo)
			}
			var name model.Option
			require.NoError(t, db.Where(&model.Option{Key: "SystemName"}).First(&name).Error)
			assert.Equal(t, "New API", name.Value)
			// A rejected image never replaces the current saved logo.
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/option/", strings.NewReader(`{"key":"Logo","value":"data:image/png;base64,invalid"}`)))
			var rejected struct{ Success bool }
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &rejected))
			assert.False(t, rejected.Success)
			assert.Empty(t, common.Logo)
			// Storage errors must not report a successful upload or publish an unsaved logo.
			require.NoError(t, db.Migrator().DropTable(&model.Option{}))
			response = httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/option/", strings.NewReader(`{"key":"Logo","value":"https://example.com/failed.png"}`)))
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &rejected))
			assert.False(t, rejected.Success)
			assert.Empty(t, common.Logo)
		})
	}
}
