package model

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// useEnterpriseDB 把 DB 指向一个独立库。用文件库而不是 :memory:：这些用例里有
// 事务、缓存同步，各自取连接，:memory: 下每个连接一个库会偶发 no such table。
func useEnterpriseDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB := DB
	previousLogDB := LOG_DB
	previousLimit := common.EnterpriseMemberLimit
	previousCache := common.RedisEnabled
	previousType := common.MainDatabaseType()

	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "enterprise.db")), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&User{}, &UserSession{}))
	// lockForUpdate 靠这个判定决定要不要发 FOR UPDATE，SQLite 上必须跳过。
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	// 注册在 t.TempDir() 之后：cleanup 后进先出，先关连接再删目录。
	t.Cleanup(func() { _ = sqlDB.Close() })

	DB = db
	LOG_DB = db
	// 额度缓存是内存实现，直接读全局 map。缓存同步失败只影响命中率，
	// 断言一律以库里的值为准。
	common.RedisEnabled = false

	t.Cleanup(func() {
		DB = previousDB
		LOG_DB = previousLogDB
		common.EnterpriseMemberLimit = previousLimit
		common.RedisEnabled = previousCache
		common.SetMainDatabaseType(previousType)
	})
	return db
}

func createEnterpriseUser(t *testing.T, id int, username string, role int, quota int) *User {
	t.Helper()
	user := &User{
		Id:          id,
		Username:    username,
		DisplayName: username,
		Password:    "$2a$10$placeholderplaceholderplaceholderplaceholderplaceholde",
		Role:        role,
		Status:      common.UserStatusEnabled,
		Quota:       quota,
		AffCode:     fmt.Sprintf("aff%d", id),
	}
	require.NoError(t, DB.Create(user).Error)
	return user
}

// markEnterprise 打标记并断言成功，返回企业账号。
func markEnterprise(t *testing.T, userId int) *User {
	t.Helper()
	released, err := SetUserEnterpriseFlag(userId, true)
	require.NoError(t, err)
	require.Zero(t, released)
	enterprise, err := GetEnterpriseAccount(userId)
	require.NoError(t, err)
	return enterprise
}

func requireQuotaValue(t *testing.T, userId, expected int) {
	t.Helper()
	var user User
	require.NoError(t, DB.Select("quota").First(&user, userId).Error)
	assert.Equal(t, expected, user.Quota, "用户 %d 的余额", userId)
}

func TestSetUserEnterpriseFlagOnlyAcceptsCommonUsers(t *testing.T) {
	useEnterpriseDB(t)
	admin := createEnterpriseUser(t, 1, "admin", common.RoleAdminUser, 0)
	root := createEnterpriseUser(t, 2, "root", common.RoleRootUser, 0)

	_, err := SetUserEnterpriseFlag(admin.Id, true)
	assert.ErrorIs(t, err, ErrEnterpriseTargetNotCommonUser)
	_, err = SetUserEnterpriseFlag(root.Id, true)
	assert.ErrorIs(t, err, ErrEnterpriseTargetNotCommonUser)
	_, err = SetUserEnterpriseFlag(9999, true)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
}

func TestSetUserEnterpriseFlagRejectsExistingMember(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 1000)
	member := createEnterpriseUser(t, 2, "member", common.RoleCommonUser, 0)
	member.EnterpriseOwnerId = enterprise.Id
	require.NoError(t, DB.Model(&User{}).Where("id = ?", member.Id).
		Update("enterprise_owner_id", enterprise.Id).Error)

	_, err := SetUserEnterpriseFlag(member.Id, true)
	assert.ErrorIs(t, err, ErrEnterpriseTargetIsMember)
}

func TestSetUserEnterpriseFlagIsIdempotent(t *testing.T) {
	useEnterpriseDB(t)
	account := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)

	released, err := SetUserEnterpriseFlag(account.Id, true)
	require.NoError(t, err)
	require.Zero(t, released)
	// 重复打标记不报错，也不重复计数。
	released, err = SetUserEnterpriseFlag(account.Id, true)
	require.NoError(t, err)
	require.Zero(t, released)
	// 取消一个本来就不是企业的账号同样是空操作。
	plain := createEnterpriseUser(t, 2, "plain", common.RoleCommonUser, 0)
	released, err = SetUserEnterpriseFlag(plain.Id, false)
	require.NoError(t, err)
	require.Zero(t, released)
}

func TestUnmarkEnterpriseReleasesMembersAndRefundsWallets(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 5000)
	markEnterprise(t, enterprise.Id)

	memberA := createEnterpriseUser(t, 2, "a", common.RoleCommonUser, 0)
	memberB := createEnterpriseUser(t, 3, "b", common.RoleCommonUser, 0)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", memberA.Id).Updates(map[string]any{
		"enterprise_owner_id":     enterprise.Id,
		"quota":                   1200,
		"enterprise_group_limits": `["vip"]`,
		"enterprise_model_limits": `["gpt-4o"]`,
		"status":                  common.UserStatusDisabled,
	}).Error)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", memberB.Id).Updates(map[string]any{
		"enterprise_owner_id": enterprise.Id,
		"quota":               800,
	}).Error)

	released, err := SetUserEnterpriseFlag(enterprise.Id, false)
	require.NoError(t, err)
	assert.Equal(t, 2, released)

	// 余额合起来退回企业账号。
	requireQuotaValue(t, enterprise.Id, 5000+1200+800)
	for _, id := range []int{memberA.Id, memberB.Id} {
		requireQuotaValue(t, id, 0)
		var member User
		require.NoError(t, DB.First(&member, id).Error)
		assert.Zero(t, member.EnterpriseOwnerId, "成员 %d 的归属应当被清空", id)
		assert.Empty(t, member.EnterpriseGroupLimits)
		assert.Empty(t, member.EnterpriseModelLimits)
	}
	// 成员的启用状态不因为取消标记而改变：停用是平台/企业管理员做过的决定。
	var rereadA User
	require.NoError(t, DB.First(&rereadA, memberA.Id).Error)
	assert.Equal(t, common.UserStatusDisabled, rereadA.Status)

	var rereadEnterprise User
	require.NoError(t, DB.First(&rereadEnterprise, enterprise.Id).Error)
	assert.Equal(t, EnterpriseFlagNo, rereadEnterprise.IsEnterprise)
	// 已经不是企业账号，控制台入口应当随之关闭。
	_, err = GetEnterpriseAccount(enterprise.Id)
	assert.ErrorIs(t, err, ErrEnterpriseNotFound)
}

func TestCreateEnterpriseMemberStartsWithNoQuotaAndNoInviter(t *testing.T) {
	useEnterpriseDB(t)
	previousNewUserQuota := common.QuotaForNewUser
	common.QuotaForNewUser = 500
	t.Cleanup(func() { common.QuotaForNewUser = previousNewUserQuota })

	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 900)
	markEnterprise(t, enterprise.Id)

	member := &User{Username: "newbie", Password: "pw12345678", DisplayName: "Newbie"}
	require.NoError(t, CreateEnterpriseMember(enterprise.Id, member))
	require.NotZero(t, member.Id)

	var stored User
	require.NoError(t, DB.First(&stored, member.Id).Error)
	// 平台的新用户赠额不该被企业管理员的一次点击刷出来。
	assert.Zero(t, stored.Quota)
	assert.Zero(t, stored.InviterId)
	assert.Equal(t, enterprise.Id, stored.EnterpriseOwnerId)
	assert.Equal(t, common.RoleCommonUser, stored.Role)
	assert.Equal(t, common.UserStatusEnabled, stored.Status)
	assert.NotEmpty(t, stored.Password)
	assert.NotEqual(t, "pw12345678", stored.Password, "密码应当已哈希")
}

func TestCreateEnterpriseMemberRejectsDuplicateUsername(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)
	markEnterprise(t, enterprise.Id)
	createEnterpriseUser(t, 2, "taken", common.RoleCommonUser, 0)

	err := CreateEnterpriseMember(enterprise.Id, &User{Username: "taken", Password: "pw12345678"})
	assert.ErrorIs(t, err, ErrEnterpriseMemberExists)
}

func TestCreateEnterpriseMemberRejectsNonEnterprise(t *testing.T) {
	useEnterpriseDB(t)
	plain := createEnterpriseUser(t, 1, "plain", common.RoleCommonUser, 0)

	err := CreateEnterpriseMember(plain.Id, &User{Username: "newbie", Password: "pw12345678"})
	assert.ErrorIs(t, err, ErrEnterpriseNotFound)
}

func TestCreateEnterpriseMemberEnforcesMemberLimit(t *testing.T) {
	useEnterpriseDB(t)
	previousLimit := common.EnterpriseMemberLimit
	common.EnterpriseMemberLimit = 2
	t.Cleanup(func() { common.EnterpriseMemberLimit = previousLimit })

	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)
	markEnterprise(t, enterprise.Id)

	require.NoError(t, CreateEnterpriseMember(enterprise.Id, &User{Username: "m1", Password: "pw12345678"}))
	require.NoError(t, CreateEnterpriseMember(enterprise.Id, &User{Username: "m2", Password: "pw12345678"}))
	err := CreateEnterpriseMember(enterprise.Id, &User{Username: "m3", Password: "pw12345678"})
	assert.ErrorIs(t, err, ErrEnterpriseMemberLimitReached)

	count, err := CountEnterpriseMembers(enterprise.Id)
	require.NoError(t, err)
	assert.EqualValues(t, 2, count)
}

// 成员通过企业邀请链接自助注册时，上限判定发生在建号事务里（insertWithTx →
// guardEnterpriseMemberCapacityTx），这条路径与 CreateEnterpriseMember 不同。
func TestInsertWithTxEnforcesMemberLimitForInvitedRegistration(t *testing.T) {
	useEnterpriseDB(t)
	previousLimit := common.EnterpriseMemberLimit
	common.EnterpriseMemberLimit = 1
	t.Cleanup(func() { common.EnterpriseMemberLimit = previousLimit })

	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)
	markEnterprise(t, enterprise.Id)
	require.NoError(t, CreateEnterpriseMember(enterprise.Id, &User{Username: "m1", Password: "pw12345678"}))

	invited := &User{
		Username:          "m2",
		Password:          "pw12345678",
		Role:              common.RoleCommonUser,
		Status:            common.UserStatusEnabled,
		EnterpriseOwnerId: enterprise.Id,
	}
	err := DB.Transaction(func(tx *gorm.DB) error { return invited.InsertWithTx(tx, 0) })
	assert.ErrorIs(t, err, ErrEnterpriseMemberLimitReached)
}

func TestTransferEnterpriseQuotaToMember(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 1000)
	markEnterprise(t, enterprise.Id)
	member := createEnterpriseUser(t, 2, "member", common.RoleCommonUser, 100)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", member.Id).
		Update("enterprise_owner_id", enterprise.Id).Error)

	transferred, err := TransferEnterpriseQuotaToMember(enterprise.Id, member.Id, 400)
	require.NoError(t, err)
	assert.Equal(t, 400, transferred)
	requireQuotaValue(t, enterprise.Id, 600)
	requireQuotaValue(t, member.Id, 500)
}

func TestTransferEnterpriseQuotaRejectsBadRequests(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 100)
	markEnterprise(t, enterprise.Id)
	member := createEnterpriseUser(t, 2, "member", common.RoleCommonUser, 0)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", member.Id).
		Update("enterprise_owner_id", enterprise.Id).Error)

	_, err := TransferEnterpriseQuotaToMember(enterprise.Id, member.Id, 0)
	assert.ErrorIs(t, err, ErrEnterpriseQuotaNotPositive)
	_, err = TransferEnterpriseQuotaToMember(enterprise.Id, member.Id, -5)
	assert.ErrorIs(t, err, ErrEnterpriseQuotaNotPositive)
	_, err = TransferEnterpriseQuotaToMember(enterprise.Id, member.Id, 101)
	assert.ErrorIs(t, err, ErrInsufficientEnterpriseQuota)
	// 失败不能改动任何一方余额。
	requireQuotaValue(t, enterprise.Id, 100)
	requireQuotaValue(t, member.Id, 0)

	// 企业账号自己不是自己的成员。
	_, err = TransferEnterpriseQuotaToMember(enterprise.Id, enterprise.Id, 10)
	assert.ErrorIs(t, err, ErrEnterpriseNotAMember)

	// 别家企业的成员不归这家管。
	outsider := createEnterpriseUser(t, 3, "outsider", common.RoleCommonUser, 0)
	_, err = TransferEnterpriseQuotaToMember(enterprise.Id, outsider.Id, 10)
	assert.ErrorIs(t, err, ErrEnterpriseNotAMember)

	require.NoError(t, DB.Model(&User{}).Where("id = ?", member.Id).
		Update("status", common.UserStatusDisabled).Error)
	_, err = TransferEnterpriseQuotaToMember(enterprise.Id, member.Id, 10)
	assert.ErrorIs(t, err, ErrEnterpriseMemberNotEnabled)
}

// 成员余额可能是负数（平台管理员手工调整过）。停用时退回的必须是带符号的真实
// 余额，只退正数会让欠的那部分凭空消失。
func TestDisableMemberRefundsSignedBalance(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 1000)
	markEnterprise(t, enterprise.Id)
	debtor := createEnterpriseUser(t, 2, "debtor", common.RoleCommonUser, -300)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", debtor.Id).
		Update("enterprise_owner_id", enterprise.Id).Error)

	returned, err := SetEnterpriseMemberStatus(enterprise.Id, debtor.Id, false)
	require.NoError(t, err)
	assert.Equal(t, -300, returned)
	requireQuotaValue(t, enterprise.Id, 700)
	requireQuotaValue(t, debtor.Id, 0)

	var stored User
	require.NoError(t, DB.First(&stored, debtor.Id).Error)
	assert.Equal(t, common.UserStatusDisabled, stored.Status)
	// 停用会递增 auth_version，让成员已经登录的会话失效。
	assert.Positive(t, stored.AuthVersion)
}

func TestSetEnterpriseMemberStatusIsIdempotentAndScoped(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)
	markEnterprise(t, enterprise.Id)
	member := createEnterpriseUser(t, 2, "member", common.RoleCommonUser, 50)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", member.Id).
		Update("enterprise_owner_id", enterprise.Id).Error)

	_, err := SetEnterpriseMemberStatus(enterprise.Id, member.Id, true)
	assert.ErrorIs(t, err, ErrEnterpriseMemberStatusUnchanged)

	_, err = SetEnterpriseMemberStatus(enterprise.Id, 0, false)
	assert.ErrorIs(t, err, ErrEnterpriseNotAMember)
	_, err = SetEnterpriseMemberStatus(enterprise.Id, enterprise.Id, false)
	assert.ErrorIs(t, err, ErrEnterpriseNotAMember)
	outsider := createEnterpriseUser(t, 3, "outsider", common.RoleCommonUser, 0)
	_, err = SetEnterpriseMemberStatus(enterprise.Id, outsider.Id, false)
	assert.ErrorIs(t, err, ErrEnterpriseNotAMember)
	// 越权失败不能顺手改掉别家用户的余额。
	requireQuotaValue(t, outsider.Id, 0)
	requireQuotaValue(t, member.Id, 50)
}

func TestNormalizeEnterpriseGroupLimits(t *testing.T) {
	allowed := map[string]string{"default": "默认", "vip": "VIP"}

	limits, err := NormalizeEnterpriseGroupLimits(nil, allowed)
	require.NoError(t, err)
	assert.Nil(t, limits, "nil 表示撤销限制")

	limits, err = NormalizeEnterpriseGroupLimits([]string{"vip", " vip ", "default"}, allowed)
	require.NoError(t, err)
	assert.Equal(t, []string{"vip", "default"}, limits)

	// 平台没开的分组进不来——企业只能做减法。
	_, err = NormalizeEnterpriseGroupLimits([]string{"svip"}, allowed)
	assert.ErrorIs(t, err, ErrInvalidEnterpriseLimits)
	_, err = NormalizeEnterpriseGroupLimits([]string{"vip", ""}, allowed)
	assert.ErrorIs(t, err, ErrInvalidEnterpriseLimits)
	// 收窄到空集不是「撤销限制」，而是「什么都不放行」，不能静默当成前者。
	_, err = NormalizeEnterpriseGroupLimits([]string{}, allowed)
	assert.ErrorIs(t, err, ErrInvalidEnterpriseLimits)
	// nil 与空切片必须是两种结果，不能在这一层被归一。
	_, err = NormalizeEnterpriseGroupLimits(make([]string, 0), allowed)
	assert.ErrorIs(t, err, ErrInvalidEnterpriseLimits)
}

func TestUpdateEnterpriseMemberLimitsKeepsNilAndEmptyApart(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)
	markEnterprise(t, enterprise.Id)
	member := createEnterpriseUser(t, 2, "member", common.RoleCommonUser, 0)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", member.Id).
		Update("enterprise_owner_id", enterprise.Id).Error)

	require.NoError(t, UpdateEnterpriseMemberLimits(enterprise.Id, member.Id, []string{"vip"}, []string{"gpt-4o"}))
	stored, err := GetEnterpriseMember(enterprise.Id, member.Id)
	require.NoError(t, err)
	assert.Equal(t, []string{"vip"}, stored.ToBaseUser().GetEnterpriseGroupLimits())
	assert.Equal(t, []string{"gpt-4o"}, stored.ToBaseUser().GetEnterpriseModelLimits())

	// 空切片 = 什么都不放行，读回来仍然是一个空集合而不是「不受限」。
	require.NoError(t, UpdateEnterpriseMemberLimits(enterprise.Id, member.Id, []string{}, []string{}))
	stored, err = GetEnterpriseMember(enterprise.Id, member.Id)
	require.NoError(t, err)
	assert.Equal(t, []string{}, stored.ToBaseUser().GetEnterpriseGroupLimits())
	assert.Equal(t, []string{}, stored.ToBaseUser().GetEnterpriseModelLimits())

	// nil = 撤销限制。
	require.NoError(t, UpdateEnterpriseMemberLimits(enterprise.Id, member.Id, nil, nil))
	stored, err = GetEnterpriseMember(enterprise.Id, member.Id)
	require.NoError(t, err)
	assert.Nil(t, stored.ToBaseUser().GetEnterpriseGroupLimits())
	assert.Nil(t, stored.ToBaseUser().GetEnterpriseModelLimits())
}

func TestUpdateEnterpriseMemberLimitsRejectsForeignMember(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)
	markEnterprise(t, enterprise.Id)
	other := createEnterpriseUser(t, 2, "other", common.RoleCommonUser, 0)
	markEnterprise(t, other.Id)
	member := createEnterpriseUser(t, 3, "member", common.RoleCommonUser, 0)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", member.Id).
		Update("enterprise_owner_id", other.Id).Error)

	err := UpdateEnterpriseMemberLimits(enterprise.Id, member.Id, []string{"vip"}, nil)
	assert.ErrorIs(t, err, ErrEnterpriseNotAMember)
	stored, err := GetEnterpriseMember(other.Id, member.Id)
	require.NoError(t, err)
	assert.Empty(t, stored.EnterpriseGroupLimits, "越权写入不能落到别家成员身上")
}

func TestResetEnterpriseMemberPasswordRevokesSessions(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)
	markEnterprise(t, enterprise.Id)
	member := createEnterpriseUser(t, 2, "member", common.RoleCommonUser, 0)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", member.Id).
		Update("enterprise_owner_id", enterprise.Id).Error)

	var before User
	require.NoError(t, DB.First(&before, member.Id).Error)

	require.NoError(t, ResetEnterpriseMemberPassword(enterprise.Id, member.Id, "newpassword123"))
	var after User
	require.NoError(t, DB.First(&after, member.Id).Error)
	assert.NotEqual(t, before.Password, after.Password)
	assert.Greater(t, after.AuthVersion, before.AuthVersion, "改密必须吊销已有会话")

	// 别家成员改不了。
	outsider := createEnterpriseUser(t, 3, "outsider", common.RoleCommonUser, 0)
	err := ResetEnterpriseMemberPassword(enterprise.Id, outsider.Id, "newpassword123")
	assert.ErrorIs(t, err, ErrEnterpriseNotAMember)
}

func TestListEnterpriseMembersIsScopedAndFiltered(t *testing.T) {
	useEnterpriseDB(t)
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)
	markEnterprise(t, enterprise.Id)

	mine := []int{2, 3}
	for i, id := range mine {
		createEnterpriseUser(t, id, fmt.Sprintf("mine%d", i), common.RoleCommonUser, 0)
		require.NoError(t, DB.Model(&User{}).Where("id = ?", id).
			Update("enterprise_owner_id", enterprise.Id).Error)
	}
	createEnterpriseUser(t, 9, "outsider", common.RoleCommonUser, 0)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", 9).
		Update("status", common.UserStatusDisabled).Error)

	members, total, err := ListEnterpriseMembers(enterprise.Id, EnterpriseMemberFilter{}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 2, total, "只看得见自己的成员")
	require.Len(t, members, 2)
	assert.Equal(t, "mine0", members[0].Username, "按 id 升序")

	members, total, err = ListEnterpriseMembers(enterprise.Id, EnterpriseMemberFilter{Keyword: "mine1"}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, members, 1)
	assert.Equal(t, "mine1", members[0].Username)

	members, total, err = ListEnterpriseMembers(enterprise.Id, EnterpriseMemberFilter{Status: common.UserStatusDisabled}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 0, total)
	assert.Empty(t, members)
}

func TestResolveRegistrationAdmission(t *testing.T) {
	useEnterpriseDB(t)
	previousInviteOnly := common.InviteOnlyRegistrationEnabled
	t.Cleanup(func() { common.InviteOnlyRegistrationEnabled = previousInviteOnly })

	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)
	markEnterprise(t, enterprise.Id)
	plain := createEnterpriseUser(t, 2, "plain", common.RoleCommonUser, 0)
	admin := createEnterpriseUser(t, 3, "admin", common.RoleAdminUser, 0)

	// 没有邀请码：开放注册时准入为空，仅邀请时直接拒绝。
	common.InviteOnlyRegistrationEnabled = false
	admission, err := ResolveRegistrationAdmission("")
	require.NoError(t, err)
	assert.Equal(t, RegistrationAdmission{}, admission)
	common.InviteOnlyRegistrationEnabled = true
	_, err = ResolveRegistrationAdmission("")
	assert.ErrorIs(t, err, ErrInvitationRequired)
	_, err = ResolveRegistrationAdmission("no-such-code")
	assert.ErrorIs(t, err, ErrInvitationRequired)

	// 普通用户 / 管理员的邀请码：照旧建立邀请关系。
	common.InviteOnlyRegistrationEnabled = false
	admission, err = ResolveRegistrationAdmission(plain.AffCode)
	require.NoError(t, err)
	assert.Equal(t, RegistrationAdmission{InviterId: plain.Id}, admission)
	admission, err = ResolveRegistrationAdmission(admin.AffCode)
	require.NoError(t, err)
	assert.Equal(t, RegistrationAdmission{InviterId: admin.Id}, admission)

	// 企业账号的推广码就是成员邀请码：落到企业名下，且不建立邀请返现关系。
	admission, err = ResolveRegistrationAdmission(enterprise.AffCode)
	require.NoError(t, err)
	assert.Equal(t, RegistrationAdmission{EnterpriseOwnerId: enterprise.Id}, admission)
	assert.Zero(t, admission.InviterId, "企业管理员发展成员不该给自己带来返现")

	// 取消标记后它就是一个普通账号，推广码恢复成普通邀请码的语义。
	_, err = SetUserEnterpriseFlag(enterprise.Id, false)
	require.NoError(t, err)
	admission, err = ResolveRegistrationAdmission(enterprise.AffCode)
	require.NoError(t, err)
	assert.Equal(t, RegistrationAdmission{InviterId: enterprise.Id}, admission)
}

// 企业用量只能看到自己的账号：别家企业名下的用户、以及不属于任何企业的用户
// 都不能混进来；成员集合为空时必须查不到东西，而不是退化成全平台。
func TestEnterpriseUsageStaysWithinOwnAccounts(t *testing.T) {
	db := useEnterpriseDB(t)
	require.NoError(t, db.AutoMigrate(&QuotaData{}))

	markEnterprise(t, createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0).Id)
	createEnterpriseUser(t, 2, "member-a", common.RoleCommonUser, 0)
	createEnterpriseUser(t, 3, "member-b", common.RoleCommonUser, 0)
	createEnterpriseUser(t, 5, "foreign", common.RoleCommonUser, 0)
	require.NoError(t, DB.Model(&User{}).Where("id IN ?", []int{2, 3}).Update("enterprise_owner_id", 1).Error)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", 5).Update("enterprise_owner_id", 4).Error)

	hour := int64(1700000000) - int64(1700000000)%3600
	require.NoError(t, DB.Create(&[]QuotaData{
		{UserID: 1, Username: "corp", ModelName: "gpt-4o", CreatedAt: hour, Count: 1, Quota: 100, TokenUsed: 10},
		{UserID: 2, Username: "member-a", ModelName: "gpt-4o", CreatedAt: hour, Count: 2, Quota: 200, TokenUsed: 20},
		{UserID: 3, Username: "member-b", ModelName: "claude", CreatedAt: hour + 3600, Count: 3, Quota: 300, TokenUsed: 30},
		{UserID: 5, Username: "foreign", ModelName: "gpt-4o", CreatedAt: hour, Count: 9, Quota: 900, TokenUsed: 90},
	}).Error)

	memberIds, err := ListEnterpriseMemberIds(1)
	require.NoError(t, err)
	assert.ElementsMatch(t, []int{2, 3}, memberIds)

	// 含企业账号自己：它自己的请求也是这家企业的花费。
	byMember, err := GetEnterpriseQuotaDataByMember(append(memberIds, 1), hour, hour+3600)
	require.NoError(t, err)
	quotaByUser := make(map[int]int, len(byMember))
	for _, row := range byMember {
		quotaByUser[row.UserID] = row.Quota
	}
	assert.Equal(t, map[int]int{1: 100, 2: 200, 3: 300}, quotaByUser)

	// 只看成员（不含企业账号自己）时口径不同，且别人的 900 永远不出现。
	byModel, err := GetEnterpriseQuotaDataByModel(memberIds, hour, hour+3600)
	require.NoError(t, err)
	memberTotal := 0
	for _, row := range byModel {
		memberTotal += row.Quota
	}
	assert.Equal(t, 500, memberTotal)

	empty, err := GetEnterpriseQuotaDataByModel(nil, hour, hour+3600)
	require.NoError(t, err)
	assert.Empty(t, empty, "成员集合为空不能变成查全平台")

	// 趋势按 quota_data 自带的小时桶汇总。
	trend, err := GetEnterpriseQuotaDataTrend(append(memberIds, 1), hour, hour+3600)
	require.NoError(t, err)
	require.Len(t, trend, 2)
	assert.Equal(t, hour, trend[0].CreatedAt)
	assert.Equal(t, 300, trend[0].Quota, "企业自己 100 + member-a 200 落在同一个小时桶")
	assert.Equal(t, 300, trend[1].Quota)
}

// 企业成员日志：范围限死在自己的成员内，渠道与 IP 在返回前就已脱敏。
func TestEnterpriseMemberLogsAreScopedAndMasked(t *testing.T) {
	db := useEnterpriseDB(t)
	require.NoError(t, db.AutoMigrate(&Log{}))

	markEnterprise(t, createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0).Id)
	createEnterpriseUser(t, 2, "member-a", common.RoleCommonUser, 0)
	createEnterpriseUser(t, 3, "member-b", common.RoleCommonUser, 0)
	createEnterpriseUser(t, 5, "foreign", common.RoleCommonUser, 0)
	require.NoError(t, DB.Model(&User{}).Where("id IN ?", []int{2, 3}).Update("enterprise_owner_id", 1).Error)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", 5).Update("enterprise_owner_id", 4).Error)

	require.NoError(t, DB.Create(&[]Log{
		{UserId: 2, Username: "member-a", Type: LogTypeConsume, ModelName: "gpt-4o", Quota: 100,
			CreatedAt: 1700000000, Ip: "203.0.113.7", ChannelId: 9,
			Other: `{"admin_info":{"is_multi_key":true},"is_stream":true}`},
		{UserId: 3, Username: "member-b", Type: LogTypeConsume, ModelName: "claude", Quota: 50,
			CreatedAt: 1700000001, Ip: "2001:db8::1", ChannelId: 7},
		{UserId: 5, Username: "foreign", Type: LogTypeConsume, ModelName: "gpt-4o", Quota: 999,
			CreatedAt: 1700000002, Ip: "198.51.100.9"},
	}).Error)

	logs, total, err := GetEnterpriseMemberLogs([]int{2, 3}, LogTypeUnknown, 0, 0, "", "", 0, 10)
	require.NoError(t, err)
	require.Equal(t, int64(2), total)
	require.Len(t, logs, 2)

	FormatEnterpriseMemberLogs(logs)
	ipByUser := make(map[int]string, len(logs))
	for _, log := range logs {
		assert.NotEqual(t, 5, log.UserId, "别家企业的成员不能出现")
		ipByUser[log.UserId] = log.Ip
		assert.Zero(t, log.ChannelId, "渠道编号不下发")
		assert.Empty(t, log.ChannelName)
		assert.NotContains(t, log.Other, "admin_info", "平台侧诊断不随日志下发")
	}
	assert.Equal(t, "203.0.*.*", ipByUser[2])
	assert.Equal(t, "2001:0db8:*:*:*:*:*:*", ipByUser[3])

	// 企业名下没有成员时一条都不给。
	emptyLogs, emptyTotal, err := GetEnterpriseMemberLogs([]int{}, LogTypeUnknown, 0, 0, "", "", 0, 10)
	require.NoError(t, err)
	assert.Zero(t, emptyTotal)
	assert.Empty(t, emptyLogs)

	// 额度合计只认消费日志，也只算自己的成员。
	quota, err := SumEnterpriseMemberQuota([]int{2, 3}, 0, 0, "", "")
	require.NoError(t, err)
	assert.Equal(t, int64(150), quota)
}

func TestMaskLogIpAddress(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", ""},
		{"203.0.113.7", "203.0.*.*"},
		{"::ffff:203.0.113.7", "203.0.*.*"},
		{"2001:db8::1", "2001:0db8:*:*:*:*:*:*"},
		{"not-an-ip", "***"},
	}
	for _, tc := range cases {
		assert.Equal(t, tc.want, maskLogIpAddress(tc.in), "输入 %q", tc.in)
	}
}

// 企业用量与日志新增的聚合都是 IN + GROUP BY + sum + COALESCE，方言差异（保留字、
// 布尔、空聚合的返回类型）必须落到真实实例上验证。DSN 由本机容器提供，缺了就跳过。
func TestEnterpriseUsageDatabaseMatrix(t *testing.T) {
	dialects := []struct {
		kind   string
		env    string
		dbType common.DatabaseType
		open   func(string) gorm.Dialector
	}{
		{"mysql", "TEST_MYSQL_DSN", common.DatabaseTypeMySQL, func(dsn string) gorm.Dialector { return mysql.Open(dsn) }},
		{"postgres", "TEST_POSTGRES_DSN", common.DatabaseTypePostgreSQL, func(dsn string) gorm.Dialector { return postgres.Open(dsn) }},
	}
	for _, dialect := range dialects {
		t.Run(dialect.kind, func(t *testing.T) {
			dsn := os.Getenv(dialect.env)
			if dsn == "" {
				t.Skipf("%s 未配置", dialect.env)
			}
			db, err := gorm.Open(dialect.open(dsn), &gorm.Config{})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			t.Cleanup(func() { _ = sqlDB.Close() })

			var version string
			require.NoError(t, db.Raw("SELECT version()").Scan(&version).Error)
			t.Logf("%s 版本：%s", dialect.kind, version)

			// 验证库是几个用例共用的，先清干净，重复跑才有一样的结果。
			require.NoError(t, db.Migrator().DropTable(&Log{}, &QuotaData{}, &User{}, &UserSession{}))
			require.NoError(t, db.AutoMigrate(&User{}, &Log{}, &QuotaData{}))

			previousDB, previousLogDB := DB, LOG_DB
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousCache := common.RedisEnabled
			DB, LOG_DB = db, db
			common.SetDatabaseTypes(dialect.dbType, dialect.dbType)
			common.RedisEnabled = false
			// 反引号还是双引号由 initCol() 在真实启动时定下，这里换方言也得跟着换，
			// 否则 PostgreSQL 会收到 MySQL 风格的反引号。
			initCol()
			t.Cleanup(func() {
				DB, LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.RedisEnabled = previousCache
				initCol()
			})

			markEnterprise(t, createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0).Id)
			createEnterpriseUser(t, 2, "member-a", common.RoleCommonUser, 0)
			createEnterpriseUser(t, 3, "member-b", common.RoleCommonUser, 0)
			createEnterpriseUser(t, 5, "foreign", common.RoleCommonUser, 0)
			require.NoError(t, DB.Model(&User{}).Where("id IN ?", []int{2, 3}).Update("enterprise_owner_id", 1).Error)
			require.NoError(t, DB.Model(&User{}).Where("id = ?", 5).Update("enterprise_owner_id", 4).Error)

			hour := int64(1700000000) - int64(1700000000)%3600
			require.NoError(t, DB.Create(&[]QuotaData{
				{UserID: 1, Username: "corp", ModelName: "gpt-4o", CreatedAt: hour, Count: 1, Quota: 100, TokenUsed: 10},
				{UserID: 2, Username: "member-a", ModelName: "gpt-4o", CreatedAt: hour, Count: 2, Quota: 200, TokenUsed: 20},
				{UserID: 3, Username: "member-b", ModelName: "claude", CreatedAt: hour + 3600, Count: 3, Quota: 300, TokenUsed: 30},
				{UserID: 5, Username: "foreign", ModelName: "gpt-4o", CreatedAt: hour, Count: 9, Quota: 900, TokenUsed: 90},
			}).Error)

			memberIds, err := ListEnterpriseMemberIds(1)
			require.NoError(t, err)
			assert.ElementsMatch(t, []int{2, 3}, memberIds)

			byMember, err := GetEnterpriseQuotaDataByMember(append(memberIds, 1), hour, hour+3600)
			require.NoError(t, err)
			quotaByUser := make(map[int]int, len(byMember))
			for _, row := range byMember {
				quotaByUser[row.UserID] = row.Quota
			}
			assert.Equal(t, map[int]int{1: 100, 2: 200, 3: 300}, quotaByUser)

			byModel, err := GetEnterpriseQuotaDataByModel(memberIds, hour, hour+3600)
			require.NoError(t, err)
			require.Len(t, byModel, 2)
			assert.Equal(t, "claude", byModel[0].ModelName, "按额度倒序")
			assert.Equal(t, 300, byModel[0].Quota)
			assert.Equal(t, 200, byModel[1].Quota)

			trend, err := GetEnterpriseQuotaDataTrend(append(memberIds, 1), hour, hour+3600)
			require.NoError(t, err)
			require.Len(t, trend, 2)
			assert.Equal(t, hour, trend[0].CreatedAt)
			assert.Equal(t, 300, trend[0].Quota)

			empty, err := GetEnterpriseQuotaDataByModel([]int{}, hour, hour+3600)
			require.NoError(t, err)
			assert.Empty(t, empty, "成员集合为空不能退化成全平台")

			require.NoError(t, DB.Create(&[]Log{
				{UserId: 2, Username: "member-a", Type: LogTypeConsume, ModelName: "gpt-4o", Quota: 100,
					CreatedAt: 1700000000, Ip: "203.0.113.7", ChannelId: 9, Group: "default",
					Other: `{"admin_info":{"is_multi_key":true},"is_stream":true}`},
				{UserId: 3, Username: "member-b", Type: LogTypeConsume, ModelName: "claude", Quota: 50,
					CreatedAt: 1700000001, Ip: "2001:db8::1", ChannelId: 7, Group: "vip"},
				{UserId: 5, Username: "foreign", Type: LogTypeConsume, ModelName: "gpt-4o", Quota: 999,
					CreatedAt: 1700000002, Ip: "198.51.100.9", Group: "default"},
			}).Error)

			logs, total, err := GetEnterpriseMemberLogs(memberIds, LogTypeUnknown, 0, 0, "", "", 0, 10)
			require.NoError(t, err)
			assert.Equal(t, int64(2), total)
			require.Len(t, logs, 2)
			FormatEnterpriseMemberLogs(logs)
			for _, log := range logs {
				assert.NotEqual(t, 5, log.UserId, "别家企业的成员不能出现")
				assert.Zero(t, log.ChannelId)
				assert.Empty(t, log.ChannelName)
				assert.NotContains(t, log.Other, "admin_info")
			}

			// 模型名过滤与分组过滤在各方言下的等值比较。
			filtered, filteredTotal, err := GetEnterpriseMemberLogs(memberIds, LogTypeConsume, 0, 0, "gpt-4o", "", 0, 10)
			require.NoError(t, err)
			assert.Equal(t, int64(1), filteredTotal)
			require.Len(t, filtered, 1)
			grouped, groupedTotal, err := GetEnterpriseMemberLogs(memberIds, LogTypeUnknown, 0, 0, "", "vip", 0, 10)
			require.NoError(t, err)
			assert.Equal(t, int64(1), groupedTotal)
			require.Len(t, grouped, 1)

			quota, err := SumEnterpriseMemberQuota(memberIds, 0, 0, "", "")
			require.NoError(t, err)
			assert.Equal(t, int64(150), quota)
			// 空聚合：COALESCE 让没有命中的筛选也返回 0，而不是 NULL 扫描失败。
			quota, err = SumEnterpriseMemberQuota(memberIds, 0, 0, "no-such-model", "")
			require.NoError(t, err)
			assert.Zero(t, quota)
		})
	}
}
