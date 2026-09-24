package model

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// useInviteRebateDB 把 DB / LOG_DB 指向一个独立的内存库，并保存、恢复返现配置，
// 避免用例之间通过全局状态互相污染。
func useInviteRebateDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB := DB
	previousLogDB := LOG_DB
	previousType := common.MainDatabaseType()

	// 用文件库而不是 :memory:：sqlite 的每个连接都有独立的内存库，而返现逻辑
	// 里的事务、日志写入会各自取连接，:memory: 下会偶发「no such table」。
	// 单连接则避免文件库上的写锁竞争。
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "invite-rebate.db")), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&User{}, &InviteRebate{}, &Log{}, &TopUp{}))
	// 注册在 t.TempDir() 之后：cleanup 是后进先出，先关连接再删目录。
	t.Cleanup(func() { _ = sqlDB.Close() })

	DB = db
	LOG_DB = db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)

	setting := operation_setting.GetInviteRebateSetting()
	previousSetting := *setting

	t.Cleanup(func() {
		DB = previousDB
		LOG_DB = previousLogDB
		common.SetMainDatabaseType(previousType)
		*setting = previousSetting
	})
	return db
}

func setInviteRebateSetting(t *testing.T, enabled bool, rateBasisPoints int) {
	t.Helper()
	setting := operation_setting.GetInviteRebateSetting()
	setting.Enabled = enabled
	setting.RateBasisPoints = rateBasisPoints
}

func createInviteRebateUser(t *testing.T, db *gorm.DB, id int, role int, memberLevel int, inviterId int) *User {
	t.Helper()
	user := &User{
		Id:          id,
		Username:    fmt.Sprintf("user%d", id),
		DisplayName: fmt.Sprintf("user%d", id),
		Password:    "$2a$10$placeholderplaceholderplaceholderplaceholderplaceholde",
		Role:        role,
		Status:      common.UserStatusEnabled,
		MemberLevel: memberLevel,
		InviterId:   inviterId,
		AffCode:     fmt.Sprintf("aff%d", id),
		Email:       fmt.Sprintf("user%d@example.com", id),
	}
	require.NoError(t, db.Create(user).Error)
	return user
}

func creditRebateInTx(t *testing.T, inviteeId int, baseQuota int, source string, sourceRef string) *inviteRebateCredit {
	t.Helper()
	var credit *inviteRebateCredit
	require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
		credit = creditInviteRebateTx(tx, inviteeId, baseQuota, source, sourceRef)
		return nil
	}))
	return credit
}

func requireQuota(t *testing.T, db *gorm.DB, userId int, expected int) {
	t.Helper()
	var user User
	require.NoError(t, db.Select("quota").First(&user, userId).Error)
	assert.Equal(t, expected, user.Quota)
}

func TestCreditInviteRebateAppliesConfiguredRate(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	credit := creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1")
	require.NotNil(t, credit)
	assert.Equal(t, 1, credit.InviterId)
	assert.Equal(t, 10000, credit.Quota)

	requireQuota(t, db, 1, 10000)

	var rebate InviteRebate
	require.NoError(t, db.First(&rebate).Error)
	assert.Equal(t, InviteRebateStatusCredited, rebate.Status)
	assert.Equal(t, 100000, rebate.BaseQuota)
	assert.Equal(t, 1000, rebate.RateBasisPoints)
	assert.Equal(t, 10000, rebate.RebateQuota)
	assert.Equal(t, 2, rebate.InviteeId)
}

// 返现属于钱包域：结果必须能超过 int32（单请求额度上限），否则一笔大额充值
// 的返现会被悄悄压到 21 亿以下，账目对不上。
func TestCreditInviteRebateIsNotBoundedBySingleRequestQuota(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	baseQuota := 40_000_000_000
	expected := 4_000_000_000
	require.Greater(t, expected, common.MaxQuota)

	credit := creditRebateInTx(t, 2, baseQuota, InviteRebateSourceEpay, "trade-large")
	require.NotNil(t, credit)
	assert.Equal(t, expected, credit.Quota)
	requireQuota(t, db, 1, expected)
}

// 基数接近钱包上限时，base × 万分比 在 int64 下会溢出（9e15 × 10000），
// 必须靠 decimal 计算。
func TestCreditInviteRebateHandlesWalletSizedBase(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	baseQuota := 9_000_000_000_000_000
	require.LessOrEqual(t, baseQuota, common.MaxWalletQuota)

	credit := creditRebateInTx(t, 2, baseQuota, InviteRebateSourceStripe, "trade-huge")
	require.NotNil(t, credit)
	assert.Equal(t, 900_000_000_000_000, credit.Quota)
	requireQuota(t, db, 1, 900_000_000_000_000)
}

// 取整规则固定为四舍五入（远离零），避免出现「按 10% 算却少返 1」的对账争议。
func TestCreditInviteRebateRoundsHalfAwayFromZero(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	cases := []struct {
		base     int
		expected int
	}{
		{base: 5, expected: 1},  // 0.5 → 1
		{base: 4, expected: 0},  // 0.4 → 0，不足一个额度单位就不返
		{base: 15, expected: 2}, // 1.5 → 2
		{base: 14, expected: 1}, // 1.4 → 1
	}
	for i, tc := range cases {
		credit := creditRebateInTx(t, 2, tc.base, InviteRebateSourceEpay, fmt.Sprintf("trade-round-%d", i))
		if tc.expected == 0 {
			assert.Nil(t, credit, "base %d", tc.base)
			continue
		}
		require.NotNil(t, credit, "base %d", tc.base)
		assert.Equal(t, tc.expected, credit.Quota, "base %d", tc.base)
	}
}

func TestCreditInviteRebateSkipsIneligibleInviters(t *testing.T) {
	cases := []struct {
		name         string
		inviterRole  int
		inviterLevel int
	}{
		{name: "外部用户不拿返现", inviterRole: common.RoleCommonUser, inviterLevel: MemberLevelNormal},
		{name: "管理员不拿返现", inviterRole: common.RoleAdminUser, inviterLevel: MemberLevelInternal},
		{name: "根用户不拿返现", inviterRole: common.RoleRootUser, inviterLevel: MemberLevelInternal},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := useInviteRebateDB(t)
			setInviteRebateSetting(t, true, 1000)
			createInviteRebateUser(t, db, 1, tc.inviterRole, tc.inviterLevel, 0)
			createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

			credit := creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1")
			assert.Nil(t, credit)
			requireQuota(t, db, 1, 0)

			var count int64
			require.NoError(t, db.Model(&InviteRebate{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}

func TestCreditInviteRebateSkipsWhenDisabledOrRateZero(t *testing.T) {
	cases := []struct {
		name    string
		enabled bool
		rate    int
	}{
		{name: "开关关闭", enabled: false, rate: 1000},
		{name: "比例为 0", enabled: true, rate: 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := useInviteRebateDB(t)
			setInviteRebateSetting(t, tc.enabled, tc.rate)
			createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
			createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

			assert.Nil(t, creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1"))
			requireQuota(t, db, 1, 0)
		})
	}
}

func TestCreditInviteRebateRequiresAUpline(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 0)

	assert.Nil(t, creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1"))
}

func TestCreditInviteRebateIsIdempotentPerSourceRef(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	first := creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1")
	require.NotNil(t, first)
	requireQuota(t, db, 1, 10000)

	// 同一笔来源重放：不能重复加钱。(Source, SourceRef) 唯一索引是最后一道防线。
	second := creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1")
	assert.Nil(t, second)
	requireQuota(t, db, 1, 10000)

	var count int64
	require.NoError(t, db.Model(&InviteRebate{}).Count(&count).Error)
	assert.EqualValues(t, 1, count)

	// 不同来源的同一单号仍然各算一笔（不同 provider 的订单号不共享命名空间）。
	third := creditRebateInTx(t, 2, 100000, InviteRebateSourceStripe, "trade-1")
	require.NotNil(t, third)
	requireQuota(t, db, 1, 20000)
}

func TestCreditInviteRebateRecordsSkippedRowWhenInviterWalletFull(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	inviter := createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)
	require.NoError(t, db.Model(&User{}).Where("id = ?", 1).
		Update("quota", common.MaxWalletQuota).
		Error)

	credit := creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1")
	assert.Nil(t, credit)
	requireQuota(t, db, 1, common.MaxWalletQuota)

	var rebate InviteRebate
	require.NoError(t, db.First(&rebate).Error)
	assert.Equal(t, InviteRebateStatusSkipped, rebate.Status)
	assert.Equal(t, InviteRebateSkipWalletLimit, rebate.SkipReason)
	assert.Zero(t, rebate.RebateQuota)
	// 基数与比例仍然留档，管理员能看到这笔本该返多少。
	assert.Equal(t, 100000, rebate.BaseQuota)
	assert.Equal(t, 1000, rebate.RateBasisPoints)
	assert.NotZero(t, inviter.Id)
}

func TestCreditTopUpQuotaGrantsRebateThroughTheFunnel(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	topUp := &TopUp{
		UserId:          2,
		Amount:          2,
		Money:           2,
		TradeNo:         "manual-trade-1",
		PaymentMethod:   PaymentProviderEpay,
		PaymentProvider: PaymentProviderEpay,
		CreateTime:      common.GetTimestamp(),
		Status:          common.TopUpStatusPending,
	}
	require.NoError(t, topUp.Insert())

	require.NoError(t, ManualCompleteTopUp("manual-trade-1", "127.0.0.1"))

	paidQuota := common.QuotaFromFloat(2 * common.QuotaPerUnit)
	requireQuota(t, db, 2, paidQuota)
	requireQuota(t, db, 1, paidQuota/10)

	var rebate InviteRebate
	require.NoError(t, db.First(&rebate).Error)
	assert.Equal(t, InviteRebateSourceManual, rebate.Source)
	assert.Equal(t, "manual-trade-1", rebate.SourceRef)
	assert.Equal(t, paidQuota, rebate.BaseQuota)
}

func TestReverseInviteRebateClawsBackOnlyWhatIsLeft(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	credit := creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1")
	require.NotNil(t, credit)

	// 邀请人已经花掉了大部分返现，只剩 3000。
	require.NoError(t, db.Model(&User{}).Where("id = ?", 1).Update("quota", 3000).Error)

	var rebate InviteRebate
	require.NoError(t, db.First(&rebate).Error)

	reversed, err := ReverseInviteRebate(rebate.Id, 99, "下线充值被退款")
	require.NoError(t, err)
	assert.Equal(t, 3000, reversed.ReversedQuota)
	// 余额扣到 0 为止，不允许出现负数。
	requireQuota(t, db, 1, 0)
	assert.Equal(t, 99, reversed.ReversedBy)
	assert.Equal(t, "下线充值被退款", reversed.ReverseReason)
	assert.NotZero(t, reversed.ReversedAt)

	// 未收回的 7000 留在流水里，账目仍然对得上。
	summary, err := GetInviteRebateSummary(1)
	require.NoError(t, err)
	assert.Equal(t, 10000, summary.TotalQuota)
	assert.Equal(t, 3000, summary.ReversedQuota)
	assert.EqualValues(t, 1, summary.RebateCount)
}

func TestReverseInviteRebateRecoversFullAmountWhenBalanceIsEnough(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	require.NotNil(t, creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1"))

	var rebate InviteRebate
	require.NoError(t, db.First(&rebate).Error)

	reversed, err := ReverseInviteRebate(rebate.Id, 1, "误发")
	require.NoError(t, err)
	assert.Equal(t, 10000, reversed.ReversedQuota)
	requireQuota(t, db, 1, 0)
}

func TestReverseInviteRebateRejectsSecondAttemptAndSkippedRows(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)
	require.NotNil(t, creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1"))

	var rebate InviteRebate
	require.NoError(t, db.First(&rebate).Error)
	_, err := ReverseInviteRebate(rebate.Id, 1, "第一次撤销")
	require.NoError(t, err)

	// 已撤销过的流水不能再撤一次，否则会重复扣款。
	_, err = ReverseInviteRebate(rebate.Id, 1, "再来一次")
	assert.ErrorIs(t, err, ErrInviteRebateNotCredited)

	require.NoError(t, db.Model(&User{}).Where("id = ?", 2).Update("quota", common.MaxWalletQuota).Error)
	require.NoError(t, db.Model(&User{}).Where("id = ?", 1).Update("quota", common.MaxWalletQuota).Error)
	require.Nil(t, creditRebateInTx(t, 2, 50000, InviteRebateSourceStripe, "trade-2"))

	var skipped InviteRebate
	require.NoError(t, db.Where("source_ref = ?", "trade-2").First(&skipped).Error)
	assert.Equal(t, InviteRebateStatusSkipped, skipped.Status)

	_, err = ReverseInviteRebate(skipped.Id, 1, "撤销一笔没入账的")
	assert.ErrorIs(t, err, ErrInviteRebateNotCredited)
}

// 余额在撤销过程中被并发改小（例如同时发生扣费）时，整笔撤销必须回滚：
// 余额不能变负，流水也不能留下「已收回」的痕迹。
func TestReverseInviteRebateNeverOverdrawsOnConcurrentSpend(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)
	require.NotNil(t, creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1"))

	var rebate InviteRebate
	require.NoError(t, db.First(&rebate).Error)

	// 模拟并发：撤销事务读到 10000 之后，余额被另一个事务花掉一半。
	require.NoError(t, db.Model(&User{}).Where("id = ?", 1).Update("quota", 5000).Error)
	require.NoError(t, db.Model(&User{}).Where("id = ?", 1).Update("quota", 2000).Error)

	// 读到的余额是 2000，扣减 2000 是安全的，不会被条件更新挡住。
	reversed, err := ReverseInviteRebate(rebate.Id, 1, "下线退款")
	require.NoError(t, err)
	assert.Equal(t, 2000, reversed.ReversedQuota)
	requireQuota(t, db, 1, 0)
}

func TestReverseInviteRebateRollsBackWhenBalanceAlreadySpent(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)
	require.NotNil(t, creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1"))

	var rebate InviteRebate
	require.NoError(t, db.First(&rebate).Error)

	// 余额已被清零：能扣的是 0，流水按 0 记账，余额保持 0 不变负。
	require.NoError(t, db.Model(&User{}).Where("id = ?", 1).Update("quota", 0).Error)
	reversed, err := ReverseInviteRebate(rebate.Id, 1, "下线退款")
	require.NoError(t, err)
	assert.Zero(t, reversed.ReversedQuota)
	assert.Equal(t, 10000, reversed.RebateQuota)
	requireQuota(t, db, 1, 0)

	// 全部未收回：记录仍是 credited，且可以再次撤销以待余额回补。
	assert.Equal(t, InviteRebateStatusCredited, reversed.Status)
}

func TestResolveMemberLevelForNewUser(t *testing.T) {
	db := useInviteRebateDB(t)
	createInviteRebateUser(t, db, 1, common.RoleAdminUser, MemberLevelNormal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 3, common.RoleRootUser, MemberLevelNormal, 0)

	cases := []struct {
		name      string
		inviterId int
		expected  int
	}{
		{name: "没有邀请人", inviterId: 0, expected: MemberLevelNormal},
		{name: "管理员邀请链接产出内部学员", inviterId: 1, expected: MemberLevelInternal},
		{name: "根用户邀请链接产出内部学员", inviterId: 3, expected: MemberLevelInternal},
		{name: "内部学员的邀请不产出内部身份", inviterId: 2, expected: MemberLevelNormal},
		{name: "邀请人已不存在", inviterId: 999, expected: MemberLevelNormal},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var level int
			require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
				level = resolveMemberLevelForNewUser(tx, tc.inviterId)
				return nil
			}))
			assert.Equal(t, tc.expected, level)
		})
	}
}

func TestNewUserMemberLevelIsDecidedByInviteLink(t *testing.T) {
	db := useInviteRebateDB(t)
	createInviteRebateUser(t, db, 1, common.RoleAdminUser, MemberLevelNormal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelInternal, 0)

	created := &User{
		Username: "fresh-internal",
		Password: "password123",
		Email:    "fresh-internal@example.com",
		Role:     common.RoleCommonUser,
		Status:   common.UserStatusEnabled,
	}
	require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
		return created.InsertWithTx(tx, 1)
	}))
	assert.Equal(t, MemberLevelInternal, created.MemberLevel)

	external := &User{
		Username: "fresh-external",
		Password: "password123",
		Email:    "fresh-external@example.com",
		Role:     common.RoleCommonUser,
		Status:   common.UserStatusEnabled,
	}
	require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
		return external.InsertWithTx(tx, 2)
	}))
	assert.Equal(t, MemberLevelNormal, external.MemberLevel)
}

func TestUpdateUsersMemberLevelByBatch(t *testing.T) {
	db := useInviteRebateDB(t)
	for id := 1; id <= 3; id++ {
		createInviteRebateUser(t, db, id, common.RoleCommonUser, MemberLevelNormal, 0)
	}

	affected, err := UpdateUsersMemberLevelByBatch([]int{1, 2, 3}, MemberLevelInternal)
	require.NoError(t, err)
	assert.EqualValues(t, 3, affected)

	for id := 1; id <= 3; id++ {
		assert.Equal(t, MemberLevelInternal, GetUserMemberLevel(id))
		assert.True(t, IsInviteRebateEligible(id))
	}

	// 无效取值与空选择都被拦住，避免把身份刷成未定义状态。
	_, err = UpdateUsersMemberLevelByBatch([]int{1}, 7)
	assert.Error(t, err)
	_, err = UpdateUsersMemberLevelByBatch(nil, MemberLevelInternal)
	assert.Error(t, err)
	assert.Error(t, UpdateUserMemberLevel(1, -1))
	assert.ErrorIs(t, UpdateUserMemberLevel(999, MemberLevelInternal), gorm.ErrRecordNotFound)
}

func TestGetUsernamesByIdsIncludesDeletedUsers(t *testing.T) {
	db := useInviteRebateDB(t)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelNormal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 0)
	require.NoError(t, db.Where("id = ?", 2).Delete(&User{}).Error)

	usernames, err := GetUsernamesByIds([]int{1, 2, 2, 0, 42})
	require.NoError(t, err)
	assert.Equal(t, "user1", usernames[1])
	assert.Equal(t, "user2", usernames[2])
	_, ok := usernames[42]
	assert.False(t, ok)
}

func TestGetInviteRebatesFiltersAndPaginates(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 3, common.RoleCommonUser, MemberLevelNormal, 1)
	createInviteRebateUser(t, db, 4, common.RoleCommonUser, MemberLevelNormal, 2)

	require.NotNil(t, creditRebateInTx(t, 3, 100000, InviteRebateSourceEpay, "trade-1"))
	require.NotNil(t, creditRebateInTx(t, 4, 200000, InviteRebateSourceStripe, "trade-2"))

	all, total, err := GetInviteRebates(InviteRebateFilter{}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 2, total)
	require.Len(t, all, 2)
	// 按 id 倒序：最新的排在最前。
	assert.Equal(t, 2, all[0].InviterId)

	byInviter, total, err := GetInviteRebates(InviteRebateFilter{InviterId: 1}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, byInviter, 1)
	assert.Equal(t, InviteRebateSourceEpay, byInviter[0].Source)

	bySource, total, err := GetInviteRebates(InviteRebateFilter{Source: InviteRebateSourceStripe}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	assert.Equal(t, 2, bySource[0].InviterId)

	// 分页：第二页只剩一条。
	_, total, err = GetInviteRebates(InviteRebateFilter{}, 1, 1)
	require.NoError(t, err)
	assert.EqualValues(t, 2, total)

	none, total, err := GetInviteRebates(InviteRebateFilter{Status: "unknown"}, 0, 10)
	require.NoError(t, err)
	assert.Zero(t, total)
	assert.Empty(t, none)
}
