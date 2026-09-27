package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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

func useEnterpriseControllerDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousType := common.MainDatabaseType()
	// 额度缓存的失效路径只看这个开关，不看 RDB 是否真的连着；不关掉会解引用空客户端。
	previousRedis := common.RedisEnabled
	common.RedisEnabled = false

	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "enterprise-controller.db")), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.Log{}))
	t.Cleanup(func() { _ = sqlDB.Close() })

	model.DB, model.LOG_DB = db, db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetMainDatabaseType(previousType)
		common.RedisEnabled = previousRedis
	})
	return db
}

// newEnterpriseRequest 造一个「已登录」的 gin 上下文：id 是控制台操作者。
// pathParams 用于 :id 之类的路径参数。
func newEnterpriseRequest(method, target, body string, operatorId int, pathParams gin.Params) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(method, target, strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Params = pathParams
	c.Set("id", operatorId)
	c.Set("role", common.RoleCommonUser)
	c.Set("username", fmt.Sprintf("user%d", operatorId))
	return c, recorder
}

func memberPathParam(id int) gin.Params {
	return gin.Params{{Key: "id", Value: fmt.Sprintf("%d", id)}}
}

func decodeEnterpriseResponse(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	payload := map[string]any{}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload), "响应体：%s", recorder.Body.String())
	return payload
}

// createEnterpriseTestUser 建一个普通账号。aff_code 必须唯一，否则第二条就被
// users 上的唯一索引挡下。
func createEnterpriseTestUser(t *testing.T, db *gorm.DB, id int, username string, role int, ownerId int) *model.User {
	t.Helper()
	user := &model.User{
		Id:                id,
		Username:          username,
		Password:          "$2a$10$placeholderplaceholderplaceholderplaceholderplaceholde",
		Role:              role,
		Status:            common.UserStatusEnabled,
		AffCode:           fmt.Sprintf("aff%d", id),
		EnterpriseOwnerId: ownerId,
	}
	require.NoError(t, db.Create(user).Error)
	return user
}

// newEnterpriseAccount 建一个已打标记的企业账号。
func newEnterpriseAccount(t *testing.T, db *gorm.DB, id int, quota int) *model.User {
	t.Helper()
	user := createEnterpriseTestUser(t, db, id, fmt.Sprintf("corp%d", id), common.RoleCommonUser, 0)
	require.NoError(t, db.Model(&model.User{}).Where("id = ?", id).Update("quota", quota).Error)
	_, err := model.SetUserEnterpriseFlag(id, true)
	require.NoError(t, err)
	return user
}

// 企业控制台的每个写入口都不能拿请求体里的归属当依据：请求结构体里根本没有这个
// 字段，多传也无处可落。
func TestCreateEnterpriseMemberIgnoresBodySuppliedOwnership(t *testing.T) {
	db := useEnterpriseControllerDB(t)
	newEnterpriseAccount(t, db, 1, 0)
	other := newEnterpriseAccount(t, db, 2, 0)

	c, recorder := newEnterpriseRequest(http.MethodPost, "/api/enterprise/members",
		`{"username":"newbie","password":"pw12345678","enterprise_owner_id":2,"role":100,"quota":999999}`,
		1, nil)
	CreateEnterpriseMember(c)

	payload := decodeEnterpriseResponse(t, recorder)
	require.True(t, payload["success"].(bool), "响应：%s", recorder.Body.String())

	var member model.User
	require.NoError(t, db.Where("username = ?", "newbie").First(&member).Error)
	assert.Equal(t, 1, member.EnterpriseOwnerId, "归属只能是操作者自己")
	assert.NotEqual(t, other.Id, member.EnterpriseOwnerId)
	assert.Equal(t, common.RoleCommonUser, member.Role, "角色不能被请求体提权")
	assert.Zero(t, member.Quota, "平台的新用户赠额不给代建账号")
}

func TestEnterpriseHandlersRejectForeignMembers(t *testing.T) {
	db := useEnterpriseControllerDB(t)
	newEnterpriseAccount(t, db, 1, 1000)
	newEnterpriseAccount(t, db, 2, 1000)
	createEnterpriseTestUser(t, db, 3, "foreign", common.RoleCommonUser, 2)
	require.NoError(t, db.Model(&model.User{}).Where("id = ?", 3).Update("quota", 250).Error)

	cases := []struct {
		name   string
		body   string
		handle func(*gin.Context)
	}{
		{"停用", `{"enabled":false}`, UpdateEnterpriseMemberStatus},
		{"改范围", `{"group_limits":["vip"],"model_limits":["gpt-4o"]}`, UpdateEnterpriseMemberLimits},
		{"划额度", `{"quota":10}`, TransferEnterpriseMemberQuota},
		{"重置密码", `{"password":"newpassword123"}`, ResetEnterpriseMemberPassword},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, recorder := newEnterpriseRequest(http.MethodPut, "/api/enterprise/members/3",
				tc.body, 1, memberPathParam(3))
			tc.handle(c)
			payload := decodeEnterpriseResponse(t, recorder)
			assert.False(t, payload["success"].(bool), "越权操作必须失败")
		})
	}

	// 越权失败不能留下任何副作用。
	var stored model.User
	require.NoError(t, db.First(&stored, 3).Error)
	assert.Equal(t, common.UserStatusEnabled, stored.Status)
	assert.Equal(t, 250, stored.Quota)
	assert.Empty(t, stored.EnterpriseGroupLimits)
	assert.Equal(t, 2, stored.EnterpriseOwnerId)
	var enterprise model.User
	require.NoError(t, db.First(&enterprise, 1).Error)
	assert.Equal(t, 1000, enterprise.Quota, "失败不能改动操作者自己的余额")
}

// 路径参数非法时绝不能退化成「操作者自己」。
func TestEnterpriseMemberIdFromPathRejectsBadIds(t *testing.T) {
	for _, raw := range []string{"", "abc", "0", "-3", "1.5", " "} {
		c, _ := newEnterpriseRequest(http.MethodGet, "/api/enterprise/members/x", "", 1,
			gin.Params{{Key: "id", Value: raw}})
		_, ok := enterpriseMemberIdFromPath(c)
		assert.False(t, ok, "路径参数 %q 必须被判非法", raw)
	}

	c, _ := newEnterpriseRequest(http.MethodGet, "/api/enterprise/members/7", "", 1, memberPathParam(7))
	id, ok := enterpriseMemberIdFromPath(c)
	require.True(t, ok)
	assert.Equal(t, 7, id)

	// 非法参数走完整 handler 时是参数错误，而不是对企业账号自身的操作。
	c, recorder := newEnterpriseRequest(http.MethodPut, "/api/enterprise/members/oops",
		`{"enabled":false}`, 1, gin.Params{{Key: "id", Value: "oops"}})
	UpdateEnterpriseMemberStatus(c)
	assert.False(t, decodeEnterpriseResponse(t, recorder)["success"].(bool))
}

func TestGetEnterpriseMembersOnlyListsOwnMembers(t *testing.T) {
	db := useEnterpriseControllerDB(t)
	newEnterpriseAccount(t, db, 1, 0)
	newEnterpriseAccount(t, db, 2, 0)
	for _, id := range []int{3, 4} {
		createEnterpriseTestUser(t, db, id, fmt.Sprintf("mine%d", id), common.RoleCommonUser, 1)
	}
	createEnterpriseTestUser(t, db, 5, "theirs", common.RoleCommonUser, 2)

	c, recorder := newEnterpriseRequest(http.MethodGet, "/api/enterprise/members", "", 1, nil)
	GetEnterpriseMembers(c)

	payload := decodeEnterpriseResponse(t, recorder)
	require.True(t, payload["success"].(bool), "响应：%s", recorder.Body.String())
	data := payload["data"].(map[string]any)
	assert.EqualValues(t, 2, data["total"], "只看得见自己的成员")
	items := data["items"].([]any)
	require.Len(t, items, 2)
	for _, item := range items {
		assert.NotEqual(t, "theirs", item.(map[string]any)["username"])
	}
	// 列表行不带密码哈希之类的字段。
	assert.NotContains(t, items[0].(map[string]any), "password")
}

// 企业只能收窄成员的分组范围，提交平台没开的分组要被服务端挡下。
func TestUpdateEnterpriseMemberLimitsRejectsUnknownGroups(t *testing.T) {
	db := useEnterpriseControllerDB(t)
	newEnterpriseAccount(t, db, 1, 0)
	createEnterpriseTestUser(t, db, 3, "member", common.RoleCommonUser, 1)

	c, recorder := newEnterpriseRequest(http.MethodPut, "/api/enterprise/members/3",
		`{"group_limits":["a-group-that-does-not-exist"],"model_limits":[]}`, 1, memberPathParam(3))
	UpdateEnterpriseMemberLimits(c)
	assert.False(t, decodeEnterpriseResponse(t, recorder)["success"].(bool))

	var stored model.User
	require.NoError(t, db.First(&stored, 3).Error)
	assert.Empty(t, stored.EnterpriseGroupLimits, "非法请求不能落库")

	// 撤销限制（null）是合法的，落地为空列。
	c, recorder = newEnterpriseRequest(http.MethodPut, "/api/enterprise/members/3",
		`{"group_limits":null,"model_limits":null}`, 1, memberPathParam(3))
	UpdateEnterpriseMemberLimits(c)
	require.True(t, decodeEnterpriseResponse(t, recorder)["success"].(bool), "响应：%s", recorder.Body.String())
	require.NoError(t, db.First(&stored, 3).Error)
	assert.Empty(t, stored.EnterpriseGroupLimits)
	assert.Empty(t, stored.EnterpriseModelLimits)
}

func TestResetEnterpriseMemberPasswordValidatesLength(t *testing.T) {
	db := useEnterpriseControllerDB(t)
	newEnterpriseAccount(t, db, 1, 0)
	member := createEnterpriseTestUser(t, db, 3, "member", common.RoleCommonUser, 1)

	c, recorder := newEnterpriseRequest(http.MethodPut, "/api/enterprise/members/3",
		`{"password":"short"}`, 1, memberPathParam(3))
	ResetEnterpriseMemberPassword(c)
	assert.False(t, decodeEnterpriseResponse(t, recorder)["success"].(bool))

	var stored model.User
	require.NoError(t, db.First(&stored, 3).Error)
	assert.Equal(t, member.Password, stored.Password, "校验不过不能改密码")
}

func TestUpdateUserEnterpriseRejectsNonCommonUsers(t *testing.T) {
	db := useEnterpriseControllerDB(t)
	createEnterpriseTestUser(t, db, 1, "admin", common.RoleAdminUser, 0)

	c, recorder := newEnterpriseRequest(http.MethodPut, "/api/admin/enterprise",
		`{"id":1,"is_enterprise":true}`, 1, nil)
	UpdateUserEnterprise(c)
	assert.False(t, decodeEnterpriseResponse(t, recorder)["success"].(bool))

	var stored model.User
	require.NoError(t, db.First(&stored, 1).Error)
	assert.Zero(t, stored.IsEnterprise)

	// 普通用户可以，并且返回被移出的成员数。
	createEnterpriseTestUser(t, db, 2, "plain", common.RoleCommonUser, 0)
	c, recorder = newEnterpriseRequest(http.MethodPut, "/api/admin/enterprise",
		`{"id":2,"is_enterprise":true}`, 1, nil)
	UpdateUserEnterprise(c)
	require.True(t, decodeEnterpriseResponse(t, recorder)["success"].(bool), "响应：%s", recorder.Body.String())
	// 换一个变量读：stored 里还带着上一次查出来的主键，GORM 会把它一并当条件。
	var marked model.User
	require.NoError(t, db.First(&marked, 2).Error)
	assert.Equal(t, model.EnterpriseFlagYes, marked.IsEnterprise)
}

func TestGetEnterpriseProfileExposesInviteCode(t *testing.T) {
	db := useEnterpriseControllerDB(t)
	enterprise := newEnterpriseAccount(t, db, 1, 300)

	c, recorder := newEnterpriseRequest(http.MethodGet, "/api/enterprise/profile", "", 1, nil)
	GetEnterpriseProfile(c)

	payload := decodeEnterpriseResponse(t, recorder)
	require.True(t, payload["success"].(bool), "响应：%s", recorder.Body.String())
	data := payload["data"].(map[string]any)
	assert.EqualValues(t, 300, data["quota"])
	assert.Equal(t, enterprise.AffCode, data["invite_code"], "企业推广码同时就是成员邀请码")
	assert.EqualValues(t, common.EnterpriseMemberLimit, data["member_limit"])

	// 没打标记的账号打不开控制台首页。
	newEnterpriseAccount(t, db, 2, 0)
	_, err := model.SetUserEnterpriseFlag(2, false)
	require.NoError(t, err)
	c, recorder = newEnterpriseRequest(http.MethodGet, "/api/enterprise/profile", "", 2, nil)
	GetEnterpriseProfile(c)
	assert.False(t, decodeEnterpriseResponse(t, recorder)["success"].(bool))
}

func TestSummariseLimitsAndJsonLimitsOrNull(t *testing.T) {
	assert.Equal(t, "all", summariseLimits(nil))
	assert.Equal(t, "none", summariseLimits([]string{}))
	assert.Equal(t, "vip,default", summariseLimits([]string{"vip", "default"}))
	// 超长白名单压成一行，避免审计参数无界膨胀。
	long := make([]string, 0, 12)
	for i := range 12 {
		long = append(long, fmt.Sprintf("g%d", i))
	}
	assert.Equal(t, "g0,g1,g2,g3,g4,g5,g6,g7,g8,g9...", summariseLimits(long))

	// 空列 → null（不受限），与「限制到空集」区分开。
	assert.Nil(t, jsonLimitsOrNull(""))
	assert.Nil(t, jsonLimitsOrNull("   "))
	assert.Nil(t, jsonLimitsOrNull("not json"))
	// 坏数据按「不受限」返回是安全的：读侧的 parseEnterpriseLimits 会 fail closed，
	// 这里只负责给前端回显。
	assert.Equal(t, []string{"vip"}, jsonLimitsOrNull(`["vip"]`))
	assert.Equal(t, []string{}, jsonLimitsOrNull(`[]`))
}
