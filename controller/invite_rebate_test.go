package controller

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func useInviteRebateControllerDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB := model.DB
	previousType := common.MainDatabaseType()

	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "invite-rebate-controller.db")), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.InviteRebate{}))
	t.Cleanup(func() { _ = sqlDB.Close() })

	model.DB = db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		model.DB = previousDB
		common.SetMainDatabaseType(previousType)
	})
	return db
}

// newInviteRebateTestContext 造一个带查询串的 gin 上下文，供解析函数测试。
func newInviteRebateTestContext(rawQuery string) *gin.Context {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/api/invite_rebate/"+rawQuery, nil)
	return c
}

func TestMaskDownlineNameKeepsOnlyEdges(t *testing.T) {
	cases := map[string]string{
		"":           "***",
		"a":          "a***",
		"ab":         "a***",
		"abc":        "a***c",
		"zhangsan":   "z***n",
		"学员甲":        "学***甲",
		"alice@test": "a***t",
	}
	for input, expected := range cases {
		assert.Equal(t, expected, maskDownlineName(input), "input %q", input)
	}
}

func TestBuildInviteRebateItemMasksDownlineOnlyWhenRequested(t *testing.T) {
	rebate := &model.InviteRebate{
		Id:              7,
		InviterId:       1,
		InviteeId:       2,
		Source:          model.InviteRebateSourceEpay,
		SourceRef:       "trade-1",
		BaseQuota:       100000,
		RateBasisPoints: 1000,
		RebateQuota:     10000,
		ReversedQuota:   4000,
		Status:          model.InviteRebateStatusCredited,
		CreatedAt:       1790248939,
	}
	usernames := map[int]string{1: "teacher", 2: "zhangsan"}

	adminView := buildInviteRebateItem(rebate, usernames, false)
	assert.Equal(t, "teacher", adminView.InviterName)
	assert.Equal(t, "zhangsan", adminView.InviteeName)
	// 未收回的额度是返现额度减去已撤销部分，撤销界面据此显示还能扣多少。
	assert.Equal(t, 6000, adminView.Outstanding)

	selfView := buildInviteRebateItem(rebate, usernames, true)
	assert.Equal(t, "teacher", selfView.InviterName)
	assert.Equal(t, "z***n", selfView.InviteeName)
	// 脱敏只改展示名，金额与来源照旧，学员能核对每一笔。
	assert.Equal(t, 100000, selfView.BaseQuota)
	assert.Equal(t, 10000, selfView.RebateQuota)
	assert.Equal(t, model.InviteRebateSourceEpay, selfView.Source)
}

func TestBuildInviteRebateItemsResolvesUsernamesInOneQuery(t *testing.T) {
	db := useInviteRebateControllerDB(t)
	for id := 1; id <= 2; id++ {
		require.NoError(t, db.Create(&model.User{
			Id:       id,
			Username: fmt.Sprintf("user%d", id),
			Role:     common.RoleCommonUser,
			Status:   common.UserStatusEnabled,
			AffCode:  fmt.Sprintf("aff%d", id),
		}).Error)
	}

	rebates := []*model.InviteRebate{
		{Id: 1, InviterId: 1, InviteeId: 2, Status: model.InviteRebateStatusCredited},
		{Id: 2, InviterId: 1, InviteeId: 2, Status: model.InviteRebateStatusCredited},
	}
	items, err := buildInviteRebateItems(rebates, true)
	require.NoError(t, err)
	require.Len(t, items, 2)
	assert.Equal(t, "user1", items[0].InviterName)
	assert.Equal(t, "u***2", items[0].InviteeName)
	// 顺序必须与入参一致，否则分页列表会和查询结果错位。
	assert.Equal(t, 1, items[0].Id)
	assert.Equal(t, 2, items[1].Id)
}

func TestParseInviteRebateFilterRejectsMalformedNumbers(t *testing.T) {
	c := newInviteRebateTestContext("?inviter_id=abc")
	_, err := parseInviteRebateFilter(c)
	assert.Error(t, err)

	c = newInviteRebateTestContext("?inviter_id=3&invitee_id=4&start_time=100&end_time=200&source=epay&status=credited")
	filter, err := parseInviteRebateFilter(c)
	require.NoError(t, err)
	assert.Equal(t, 3, filter.InviterId)
	assert.Equal(t, 4, filter.InviteeId)
	assert.EqualValues(t, 100, filter.StartTime)
	assert.EqualValues(t, 200, filter.EndTime)
	assert.Equal(t, model.InviteRebateSourceEpay, filter.Source)
	assert.Equal(t, model.InviteRebateStatusCredited, filter.Status)
}
