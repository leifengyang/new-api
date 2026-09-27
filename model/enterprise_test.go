package model

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
