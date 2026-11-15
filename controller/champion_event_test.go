package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestChampionRewardDecisionAPI(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	conn, err := db.DB()
	require.NoError(t, err)
	conn.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.ChampionAward{}))
	previousDB, previousType, previousRedis := model.DB, common.MainDatabaseType(), common.RedisEnabled
	model.DB = db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	t.Cleanup(func() {
		model.DB = previousDB
		common.SetMainDatabaseType(previousType)
		common.RedisEnabled = previousRedis
		require.NoError(t, conn.Close())
	})
	for _, tc := range []struct {
		name, body, before, after string
		userID                    int
		success                   bool
		quota                     int
	}{
		{"claim only session owner despite forged user ID", `{"decision":"claim","user_id":2}`, "claimable", "credited", 1, true, 500100},
		{"decline requires explicit confirmation", `{"decision":"decline"}`, "claimable", "claimable", 1, false, 100},
		{"confirmed decline preserves honor", `{"decision":"decline","confirm_decline":true}`, "claimable", "declined", 1, true, 100},
		{"invalid decision does not resolve reward", `{"decision":"other"}`, "claimable", "claimable", 1, false, 100},
		{"decision cannot include preference writes", `{"decision":"claim","seen":true}`, "claimable", "claimable", 1, false, 100},
		{"unknown session cannot claim another award", `{"decision":"claim","user_id":1}`, "claimable", "claimable", 0, false, 100},
		{"declined reward cannot be claimed", `{"decision":"claim"}`, "declined", "declined", 1, false, 100},
		{"credited reward is idempotent", `{"decision":"claim"}`, "credited", "credited", 1, true, 100},
		{"closing celebration does not resolve money", `{"seen":true}`, "claimable", "claimable", 1, true, 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, db.Where("id > 0").Delete(&model.ChampionAward{}).Error)
			require.NoError(t, db.Unscoped().Where("id > 0").Delete(&model.User{}).Error)
			for id := 1; id <= 2; id++ {
				require.NoError(t, db.Create(&model.User{Id: id, Username: string(rune('a' + id)), AffCode: string(rune('a' + id)), Quota: 100, Role: common.RoleCommonUser, Status: common.UserStatusEnabled}).Error)
				require.NoError(t, db.Create(&model.ChampionAward{EventID: 1, UserID: id, Status: tc.before, Position: id, Equipped: id, Quota: 500000}).Error)
			}
			router := gin.New()
			router.PUT("/reward", func(c *gin.Context) { c.Set("id", tc.userID) }, UpdateChampionSelf)
			request := httptest.NewRequest(http.MethodPut, "/reward", strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			var result struct{ Success bool }
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
			assert.Equal(t, tc.success, result.Success, response.Body.String())
			var own, other model.ChampionAward
			require.NoError(t, db.Where("user_id = 1").First(&own).Error)
			require.NoError(t, db.Where("user_id = 2").First(&other).Error)
			assert.Equal(t, tc.after, own.Status)
			assert.Equal(t, 1, own.Equipped)
			assert.Equal(t, tc.before, other.Status)
			var user, otherUser model.User
			require.NoError(t, db.First(&user, 1).Error)
			require.NoError(t, db.First(&otherUser, 2).Error)
			assert.Equal(t, tc.quota, user.Quota)
			assert.Equal(t, 100, otherUser.Quota)
		})
	}
}
