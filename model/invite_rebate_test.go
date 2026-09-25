package model

import (
	"fmt"
	"os"
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
	return createNamedInviteRebateUser(t, db, id, fmt.Sprintf("user%d", id), role, memberLevel, inviterId)
}

// createNamedInviteRebateUser 与 createInviteRebateUser 相同，但指定用户名，
// 供按名字检索的用例构造可辨认的账号。
func createNamedInviteRebateUser(t *testing.T, db *gorm.DB, id int, username string, role int, memberLevel int, inviterId int) *User {
	t.Helper()
	user := &User{
		Id:          id,
		Username:    username,
		DisplayName: username,
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

// creditRebateInTx 模拟被邀请人的首次充值带来的返现尝试。
func creditRebateInTx(t *testing.T, inviteeId int, baseQuota int, source string, sourceRef string) *inviteRebateCredit {
	t.Helper()
	return creditRebateInTxFor(t, inviteeId, baseQuota, source, sourceRef, true)
}

// creditRebateInTxFor 显式指定这次充值是不是被邀请人的首充。外部邀请人只在这上面
// 拿得到返现，内部学员不看这个标记。
func creditRebateInTxFor(t *testing.T, inviteeId int, baseQuota int, source string, sourceRef string, firstTopUp bool) *inviteRebateCredit {
	t.Helper()
	var credit *inviteRebateCredit
	require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
		credit = creditInviteRebateTx(tx, inviteeId, baseQuota, source, sourceRef, firstTopUp)
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

func requireAffCount(t *testing.T, db *gorm.DB, userId int, expected int) {
	t.Helper()
	var user User
	require.NoError(t, db.Select("aff_count").First(&user, userId).Error)
	assert.Equal(t, expected, user.AffCount)
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
		{name: "管理员不拿返现", inviterRole: common.RoleAdminUser, inviterLevel: MemberLevelInternal},
		{name: "根用户不拿返现", inviterRole: common.RoleRootUser, inviterLevel: MemberLevelInternal},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := useInviteRebateDB(t)
			setInviteRebateSetting(t, true, 1000)
			createInviteRebateUser(t, db, 1, tc.inviterRole, tc.inviterLevel, 0)
			createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

			// 首充也拿不到：这两种身份与下线充了多少无关，永远不参与返现。
			credit := creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1")
			assert.Nil(t, credit)
			requireQuota(t, db, 1, 0)

			var count int64
			require.NoError(t, db.Model(&InviteRebate{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}

// 外部邀请人只在下线的首充上拿一次返现，之后的充值不再发钱、也不留流水。
func TestCreditInviteRebatePaysExternalInviterOnFirstTopUpOnly(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelNormal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	first := creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1")
	require.NotNil(t, first)
	assert.Equal(t, 10000, first.Quota)
	requireQuota(t, db, 1, 10000)

	// 换来源、换单号都不行：口径是「下线的首充」，不是「每个来源各一次」。
	assert.Nil(t, creditRebateInTxFor(t, 2, 200000, InviteRebateSourceEpay, "trade-2", false))
	assert.Nil(t, creditRebateInTxFor(t, 2, 200000, InviteRebateSourceStripe, "trade-3", false))
	requireQuota(t, db, 1, 10000)

	var count int64
	require.NoError(t, db.Model(&InviteRebate{}).Count(&count).Error)
	assert.EqualValues(t, 1, count)
}

// 内部学员不受首充标记影响：下线的第二笔充值照返。
func TestCreditInviteRebatePaysInternalInviterOnEveryTopUp(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	require.NotNil(t, creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1"))
	require.NotNil(t, creditRebateInTxFor(t, 2, 200000, InviteRebateSourceEpay, "trade-2", false))
	requireQuota(t, db, 1, 30000)
}

// 首充标记由充值漏斗自己维护：它只在充值真的入账之后才落，且外部邀请人的返现
// 在真实充值路径上只发一次。
func TestCreditTopUpQuotaStampsFirstTopUpOnce(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelNormal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

	creditTopUp := func(sourceRef string) (*inviteRebateCredit, error) {
		var credit *inviteRebateCredit
		err := DB.Transaction(func(tx *gorm.DB) error {
			var err error
			credit, err = creditTopUpQuota(tx, 2, 100000, InviteRebateSourceEpay, sourceRef, nil)
			return err
		})
		return credit, err
	}
	readStamp := func() int64 {
		var user User
		require.NoError(t, db.Select("first_topup_at").First(&user, 2).Error)
		return user.FirstTopUpAt
	}

	// 钱包触顶的那次充值没有入账，因此不能占掉首充名额。
	require.NoError(t, db.Model(&User{}).Where("id = ?", 2).Update("quota", common.MaxWalletQuota).Error)
	_, err := creditTopUp("trade-failed")
	require.ErrorIs(t, err, ErrTopUpQuotaLimitExceeded)
	assert.Zero(t, readStamp(), "没入账的充值不能占掉首充名额")

	require.NoError(t, db.Model(&User{}).Where("id = ?", 2).Update("quota", 0).Error)
	first, err := creditTopUp("trade-1")
	require.NoError(t, err)
	require.NotNil(t, first)
	assert.NotZero(t, readStamp(), "首充成功后必须留下时间戳")

	// 后续充值既不发返现，也不许改写已经记下的首充时间。
	require.NoError(t, db.Model(&User{}).Where("id = ?", 2).Update("first_topup_at", 111).Error)
	second, err := creditTopUp("trade-2")
	require.NoError(t, err)
	assert.Nil(t, second)
	assert.EqualValues(t, 111, readStamp())
	requireQuota(t, db, 1, 10000)
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

// 邀请人数曾经只在发放「注册即送」邀请奖励时才累加；奖励退役（QuotaForInviter 归零）
// 之后计数再也没写过，用户页面的邀请人数一直停在 0。计数必须只看邀请关系，两个注册
// 入口都要覆盖。
func TestNewUserInviteIsCountedWithoutTheLegacyReward(t *testing.T) {
	previousQuotaForInviter := common.QuotaForInviter
	common.QuotaForInviter = 0
	t.Cleanup(func() { common.QuotaForInviter = previousQuotaForInviter })

	finalize := map[string]func(*User, int){
		"账号密码注册":   func(user *User, inviterId int) { user.finishInsert(inviterId) },
		"OAuth 注册": func(user *User, inviterId int) { user.FinalizeOAuthUserCreation(inviterId) },
	}
	for name, finish := range finalize {
		t.Run(name, func(t *testing.T) {
			db := useInviteRebateDB(t)
			inviter := createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelNormal, 0)
			invitee := createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, inviter.Id)

			finish(invitee, inviter.Id)

			requireAffCount(t, db, inviter.Id, 1)
			// 退役的注册即送奖励不能借这条路复活。
			var stored User
			require.NoError(t, db.Select("aff_quota", "aff_history").First(&stored, inviter.Id).Error)
			assert.Zero(t, stored.AffQuota)
			assert.Zero(t, stored.AffHistoryQuota)
		})
	}
}

// 存量部署里邀请关系已经存在、计数却是 0（就是上面那个 bug 留下的状态）。回填以
// inviter_id 为准，且重复执行必须收敛。
func TestInitializeInviteCountsBackfillsFromInviteRelation(t *testing.T) {
	db := useInviteRebateDB(t)
	inviter := createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelNormal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, inviter.Id)
	createInviteRebateUser(t, db, 3, common.RoleCommonUser, MemberLevelNormal, inviter.Id)
	lonely := createInviteRebateUser(t, db, 4, common.RoleCommonUser, MemberLevelNormal, 0)
	removed := createInviteRebateUser(t, db, 5, common.RoleCommonUser, MemberLevelNormal, lonely.Id)
	require.NoError(t, db.Model(&User{}).Where("id = ?", lonely.Id).Update("aff_count", 3).Error)
	require.NoError(t, db.Delete(&User{}, removed.Id).Error)

	for range 2 {
		require.NoError(t, InitializeInviteCounts())
		requireAffCount(t, db, inviter.Id, 2)
		// 下线已被删除的邀请人要归零，不能一直挂着过期计数。
		requireAffCount(t, db, lonely.Id, 0)
	}
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

// 管理端用户列表的「收益」列展示累计返现，按页一次性汇总。
// 口径必须和学员自己在钱包里看到的累计返现（GetInviteRebateSummary）一致：
// 只算已入账的流水；冲正只是把这笔钱收回去，不代表当初没发过，这里不回冲。
func TestUserListFillsCumulativeInviteRebate(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 3, common.RoleCommonUser, MemberLevelNormal, 1)
	createInviteRebateUser(t, db, 4, common.RoleCommonUser, MemberLevelNormal, 1)
	createInviteRebateUser(t, db, 5, common.RoleCommonUser, MemberLevelNormal, 2)

	// 10% 的费率：邀请人 1 累计 10000+20000，邀请人 2 累计 5000。
	require.NotNil(t, creditRebateInTx(t, 3, 100000, InviteRebateSourceEpay, "trade-1"))
	require.NotNil(t, creditRebateInTx(t, 4, 200000, InviteRebateSourceEpay, "trade-2"))
	require.NotNil(t, creditRebateInTx(t, 5, 50000, InviteRebateSourceStripe, "trade-3"))

	users, total, err := GetAllUsers(&common.PageInfo{Page: 1, PageSize: 10})
	require.NoError(t, err)
	assert.EqualValues(t, 5, total)
	require.Len(t, users, 5)

	expected := map[int]int{1: 30000, 2: 5000, 3: 0, 4: 0, 5: 0}
	for _, user := range users {
		assert.Equal(t, expected[user.Id], user.InviteRebateQuota, "user%d 的收益列", user.Id)
		summary, err := GetInviteRebateSummary(user.Id)
		require.NoError(t, err)
		assert.Equal(t, summary.TotalQuota, user.InviteRebateQuota,
			"user%d 的收益列必须和钱包里的累计返现一致", user.Id)
	}

	// 搜索是另一条查询路径，同样要填上。
	found, _, err := SearchUsers("user1", "", nil, nil, nil, 0, 10)
	require.NoError(t, err)
	require.Len(t, found, 1)
	assert.Equal(t, 1, found[0].Id)
	assert.Equal(t, 30000, found[0].InviteRebateQuota)

	// 分页只汇总本页出现的邀请人，不把库里其他人的数字带过来。
	page, _, err := GetAllUsers(&common.PageInfo{Page: 1, PageSize: 2})
	require.NoError(t, err)
	require.Len(t, page, 2)
	assert.Equal(t, 5, page[0].Id)
	assert.Equal(t, 4, page[1].Id)
	assert.Zero(t, page[0].InviteRebateQuota)
	assert.Zero(t, page[1].InviteRebateQuota)

	// 钱包已满导致「跳过」的流水不是收益：学员自己也没收到这笔钱。
	require.NoError(t, db.Model(&User{}).Where("id = ?", 2).Update("quota", common.MaxWalletQuota).Error)
	require.Nil(t, creditRebateInTx(t, 5, 50000, InviteRebateSourceStripe, "trade-4"))
	require.NoError(t, db.Model(&User{}).Where("id = ?", 2).Update("quota", 0).Error)

	users, _, err = GetAllUsers(&common.PageInfo{Page: 1, PageSize: 10})
	require.NoError(t, err)
	for _, user := range users {
		assert.Equal(t, expected[user.Id], user.InviteRebateQuota,
			"被跳过的流水不该进 user%d 的收益列", user.Id)
	}

	// 冲正后收益列保持不变：钱是被收回去了，但当初确实发过，后台流水页单独呈现。
	var rebate InviteRebate
	require.NoError(t, db.Where("inviter_id = ?", 2).First(&rebate).Error)
	_, err = ReverseInviteRebate(rebate.Id, 99, "下线充值被退款")
	require.NoError(t, err)
	users, _, err = GetAllUsers(&common.PageInfo{Page: 1, PageSize: 10})
	require.NoError(t, err)
	for _, user := range users {
		assert.Equal(t, expected[user.Id], user.InviteRebateQuota,
			"冲正后 user%d 的收益列不该被重复扣减", user.Id)
	}
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

func TestGetInviteRebatesKeywordMatchesBothSidesByName(t *testing.T) {
	db := useInviteRebateDB(t)
	setInviteRebateSetting(t, true, 1000)
	createNamedInviteRebateUser(t, db, 1, "zhangsan", common.RoleCommonUser, MemberLevelInternal, 0)
	createNamedInviteRebateUser(t, db, 2, "zhang_san", common.RoleCommonUser, MemberLevelNormal, 1)
	createNamedInviteRebateUser(t, db, 3, "wangXer", common.RoleCommonUser, MemberLevelNormal, 1)
	createNamedInviteRebateUser(t, db, 4, "lisi", common.RoleCommonUser, MemberLevelInternal, 0)
	createNamedInviteRebateUser(t, db, 5, "wang_er", common.RoleCommonUser, MemberLevelNormal, 4)

	require.NotNil(t, creditRebateInTx(t, 2, 100000, InviteRebateSourceEpay, "trade-1"))
	require.NotNil(t, creditRebateInTx(t, 3, 100000, InviteRebateSourceEpay, "trade-2"))
	require.NotNil(t, creditRebateInTx(t, 5, 100000, InviteRebateSourceEpay, "trade-3"))

	// 命中邀请人。
	byInviter, total, err := GetInviteRebates(InviteRebateFilter{Keyword: "lisi"}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, byInviter, 1)
	assert.Equal(t, 5, byInviter[0].InviteeId)

	// 命中下线。
	byInvitee, total, err := GetInviteRebates(InviteRebateFilter{Keyword: "zhang_san"}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, byInvitee, 1)
	assert.Equal(t, 1, byInvitee[0].InviterId)

	// 关键词里的 _ 是普通字符：未转义时 %wang_er% 会连 wangXer 一起匹配。
	literal, total, err := GetInviteRebates(InviteRebateFilter{Keyword: "wang_er"}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, literal, 1)
	assert.Equal(t, 4, literal[0].InviterId)

	// 与其它筛选条件叠加时，名字匹配仍受这些条件约束；括号缺失会让 OR 逃出
	// status 的约束，把未发放的流水一起返回。
	matched, total, err := GetInviteRebates(InviteRebateFilter{
		Keyword: "wang",
		Source:  InviteRebateSourceEpay,
		Status:  InviteRebateStatusCredited,
	}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 2, total)
	require.Len(t, matched, 2)

	_, total, err = GetInviteRebates(InviteRebateFilter{
		Keyword: "wang",
		Status:  InviteRebateStatusSkipped,
	}, 0, 10)
	require.NoError(t, err)
	assert.Zero(t, total)

	// 已注销学员的历史返现仍按名字可查，和流水里的用户名展示保持一致。
	require.NoError(t, db.Where("id = ?", 4).Delete(&User{}).Error)
	_, total, err = GetInviteRebates(InviteRebateFilter{Keyword: "lisi"}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)

	_, total, err = GetInviteRebates(InviteRebateFilter{Keyword: "nobody"}, 0, 10)
	require.NoError(t, err)
	assert.Zero(t, total)
}

// ── 三库矩阵 ────────────────────────────────────────────────────────────────
//
// 返现模块带来两处 schema 变更（users.member_level 列、invite_rebates 表及其
// (source, source_ref) 复合唯一索引），查询里又用到了 LIKE ... ESCAPE 和
// COALESCE(SUM(bigint))。这些写法在 SQLite / MySQL / PostgreSQL 上的行为并不
// 一致，只能在真实的三个库上验证，所以下面这组用例必须逐个方言各跑一遍。

// useInviteRebateMatrixDB 为指定方言准备一个干净的库。SQLite 每次新建文件库；
// MySQL / PostgreSQL 复用 TEST_MYSQL_DSN / TEST_POSTGRES_DSN 指向的实例，并先
// 把返现相关的表删掉重来（与 model 包其它迁移用例同一约定）。刻意走 chooseDB
// 而不是 gorm.Open，好把生产用的 dialector 包装一起覆盖进来：MySQL 的
// parseTime 补齐、PostgreSQL 的 PreferSimpleProtocol。
func useInviteRebateMatrixDB(t *testing.T, dialect string) *gorm.DB {
	t.Helper()
	const envName = "INVITE_REBATE_MATRIX_DSN"
	switch dialect {
	case "sqlite":
		previousPath := common.SQLitePath
		common.SQLitePath = filepath.Join(t.TempDir(), "invite-rebate-matrix.db")
		t.Cleanup(func() { common.SQLitePath = previousPath })
		t.Setenv(envName, "local")
	case "mysql":
		dsn := os.Getenv("TEST_MYSQL_DSN")
		if dsn == "" {
			t.Skip("TEST_MYSQL_DSN is not configured")
		}
		t.Setenv(envName, dsn)
	case "postgres":
		dsn := os.Getenv("TEST_POSTGRES_DSN")
		if dsn == "" {
			t.Skip("TEST_POSTGRES_DSN is not configured")
		}
		t.Setenv(envName, dsn)
	}

	db, dbType, err := chooseDB(envName, false)
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)

	previousDB := DB
	previousLogDB := LOG_DB
	previousType := common.MainDatabaseType()
	DB = db
	LOG_DB = db
	common.SetMainDatabaseType(dbType)
	t.Cleanup(func() {
		DB = previousDB
		LOG_DB = previousLogDB
		common.SetMainDatabaseType(previousType)
		_ = db.Migrator().DropTable(&InviteRebate{}, &Log{}, &User{})
		_ = sqlDB.Close()
	})

	// 外部实例是复用的：上一次跑剩的表会让唯一索引把新数据挡下来。
	require.NoError(t, db.Migrator().DropTable(&InviteRebate{}, &Log{}, &User{}))
	require.NoError(t, db.AutoMigrate(&User{}, &InviteRebate{}, &Log{}))
	return db
}

func TestInviteRebateDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			setInviteRebateSetting(t, true, 1000)
			db := useInviteRebateMatrixDB(t, dialect)

			versionQuery := "SELECT version()"
			if dialect == "sqlite" {
				versionQuery = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
			t.Logf("%s version: %s", dialect, version)

			t.Run("member_level_column_and_indexes", func(t *testing.T) {
				assert.True(t, db.Migrator().HasTable(&InviteRebate{}))
				assert.True(t, db.Migrator().HasColumn(&User{}, "member_level"))
				assert.True(t, db.Migrator().HasColumn(&User{}, "first_topup_at"))
				assert.True(t, db.Migrator().HasIndex(&InviteRebate{}, "idx_invite_rebate_source"))

				// 重启不能再产生 schema 变更。member_level 用 int + default:0 而不是
				// GORM 的布尔默认值，正是因为 MySQL / PostgreSQL 对默认值的表达差异
				// 会让 AutoMigrate 每次启动都重复 ALTER TABLE。
				recorder := &migrationSQLRecorder{}
				require.NoError(t, db.Session(&gorm.Session{Logger: recorder}).
					AutoMigrate(&User{}, &InviteRebate{}, &Log{}))
				assert.Empty(t, recorder.schemaMutations())
			})

			t.Run("unique_source_ref_blocks_replays", func(t *testing.T) {
				createInviteRebateUser(t, db, 1, common.RoleCommonUser, MemberLevelInternal, 0)
				createInviteRebateUser(t, db, 2, common.RoleCommonUser, MemberLevelNormal, 1)

				// 同一个 (source, source_ref) 发两次，第二次即 webhook 重放。
				//
				// 断言的重点是「外层充值事务仍然提交成功、付款人的额度落库」，而不只是
				// 「返现没重复发」：PostgreSQL 会把失败语句之后的事务置为 aborted，COMMIT
				// 随即变成 ROLLBACK，付款人的充值会被这笔发不出去的返现一起回滚。SQLite 和
				// MySQL 的失败语句不污染事务，所以只有 PostgreSQL 这一档真的会抓到这个回归，
				// 但三个库跑的是同一段代码路径。
				for attempt := range 2 {
					var credit *inviteRebateCredit
					require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
						if err := tx.Model(&User{}).Where("id = ?", 2).
							Update("quota", gorm.Expr("quota + ?", 1000)).Error; err != nil {
							return err
						}
						// 邀请人是内部学员，与首充标记无关。
						credit = creditInviteRebateTx(tx, 2, 100000, InviteRebateSourceEpay, "trade-dup", false)
						return nil
					}), "第 %d 次充值所在的事务必须能提交", attempt+1)
					if attempt == 0 {
						require.NotNil(t, credit)
					} else {
						assert.Nil(t, credit)
					}
				}

				// 两次充值都入账，返现只发了一次。
				requireQuota(t, db, 2, 2000)
				requireQuota(t, db, 1, 10000)
				var count int64
				require.NoError(t, db.Model(&InviteRebate{}).Count(&count).Error)
				assert.EqualValues(t, 1, count)
			})

			// 外部邀请人只在下线首充上拿返现，判定完全依赖首充打点的 CAS 结果
			// （first_topup_at = 0 → 时间戳）。这是 RowsAffected 的语义差异：MySQL
			// 返回被改变的行数，PostgreSQL 返回被匹配的行数，三库必须给出同一个答案。
			t.Run("first_top_up_stamp_is_cas", func(t *testing.T) {
				createInviteRebateUser(t, db, 61, common.RoleCommonUser, MemberLevelNormal, 0)
				createInviteRebateUser(t, db, 62, common.RoleCommonUser, MemberLevelNormal, 61)

				topUp := func(sourceRef string) *inviteRebateCredit {
					t.Helper()
					var credit *inviteRebateCredit
					require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
						var err error
						credit, err = creditTopUpQuota(tx, 62, 100000, InviteRebateSourceEpay, sourceRef, nil)
						return err
					}))
					return credit
				}
				readStamp := func() int64 {
					var user User
					require.NoError(t, db.Select("first_topup_at").First(&user, 62).Error)
					return user.FirstTopUpAt
				}

				require.NotNil(t, topUp("trade-first"))
				firstStamp := readStamp()
				assert.NotZero(t, firstStamp, "首充成功后必须留下时间戳")

				// 第二笔：CAS 匹配不到行，外部邀请人拿不到第二份返现，时间戳也不许被改写。
				assert.Nil(t, topUp("trade-second"))
				assert.Equal(t, firstStamp, readStamp())

				requireQuota(t, db, 61, 10000)
				var count int64
				require.NoError(t, db.Model(&InviteRebate{}).
					Where("invitee_id = ?", 62).Count(&count).Error)
				assert.EqualValues(t, 1, count)
			})

			t.Run("keyword_search_escapes_like_wildcards", func(t *testing.T) {
				createNamedInviteRebateUser(t, db, 11, "zhang_san", common.RoleCommonUser, MemberLevelInternal, 0)
				createNamedInviteRebateUser(t, db, 12, "user12", common.RoleCommonUser, MemberLevelNormal, 11)
				createNamedInviteRebateUser(t, db, 13, "zhangXsan", common.RoleCommonUser, MemberLevelInternal, 0)
				createNamedInviteRebateUser(t, db, 14, "user14", common.RoleCommonUser, MemberLevelNormal, 13)
				createNamedInviteRebateUser(t, db, 15, "li!si", common.RoleCommonUser, MemberLevelInternal, 0)
				createNamedInviteRebateUser(t, db, 16, "user16", common.RoleCommonUser, MemberLevelNormal, 15)
				createNamedInviteRebateUser(t, db, 17, "lisi", common.RoleCommonUser, MemberLevelInternal, 0)
				createNamedInviteRebateUser(t, db, 18, "user18", common.RoleCommonUser, MemberLevelNormal, 17)

				require.NotNil(t, creditRebateInTx(t, 12, 100000, InviteRebateSourceEpay, "trade-k1"))
				require.NotNil(t, creditRebateInTx(t, 14, 100000, InviteRebateSourceEpay, "trade-k2"))
				require.NotNil(t, creditRebateInTx(t, 16, 100000, InviteRebateSourceEpay, "trade-k3"))
				require.NotNil(t, creditRebateInTx(t, 18, 100000, InviteRebateSourceEpay, "trade-k4"))

				// 名字里的 _ 是普通字符。没转义时 %zhang_san% 会把 zhangXsan 一起捞出来。
				matched, total, err := GetInviteRebates(InviteRebateFilter{Keyword: "zhang_san"}, 0, 10)
				require.NoError(t, err)
				assert.EqualValues(t, 1, total)
				require.Len(t, matched, 1)
				assert.Equal(t, 11, matched[0].InviterId)

				// 名字里的 ! 既是关键字又是 ESCAPE 字符，必须自己转义自己：
				// 没转义时 %li!si% 会被读成「li + 转义 s + i」，匹配到 lisi。
				matched, total, err = GetInviteRebates(InviteRebateFilter{Keyword: "li!si"}, 0, 10)
				require.NoError(t, err)
				assert.EqualValues(t, 1, total)
				require.Len(t, matched, 1)
				assert.Equal(t, 15, matched[0].InviterId)

				// 与其它条件叠加时，名字匹配仍受这些条件约束；括号缺失会让 OR 逃出
				// source 的约束，把别的来源的流水一起返回。
				_, total, err = GetInviteRebates(InviteRebateFilter{
					Keyword: "zhang",
					Source:  InviteRebateSourceStripe,
					Status:  InviteRebateStatusCredited,
				}, 0, 10)
				require.NoError(t, err)
				assert.Zero(t, total)

				// 已注销学员留下的历史返现仍要能被搜到（Unscoped）。
				require.NoError(t, db.Where("id = ?", 15).Delete(&User{}).Error)
				_, total, err = GetInviteRebates(InviteRebateFilter{Keyword: "li!si"}, 0, 10)
				require.NoError(t, err)
				assert.EqualValues(t, 1, total)
			})

			t.Run("wallet_sized_quota_and_summary", func(t *testing.T) {
				createInviteRebateUser(t, db, 21, common.RoleCommonUser, MemberLevelInternal, 0)
				createInviteRebateUser(t, db, 22, common.RoleCommonUser, MemberLevelNormal, 21)

				// 返现额可以超过 int32：bigint 列必须原样往返。
				credit := creditRebateInTx(t, 22, 9_000_000_000_000_000, InviteRebateSourceStripe, "trade-big")
				require.NotNil(t, credit)
				assert.Equal(t, 900_000_000_000_000, credit.Quota)
				requireQuota(t, db, 21, 900_000_000_000_000)

				// COALESCE(SUM(bigint), 0) 在 PostgreSQL 上是 numeric，聚合结果扫进
				// Go 的 int 不能丢精度；空集的 COALESCE 分支也要落到 0。
				summary, err := GetInviteRebateSummary(21)
				require.NoError(t, err)
				assert.Equal(t, 900_000_000_000_000, summary.TotalQuota)
				assert.Zero(t, summary.ReversedQuota)
				assert.EqualValues(t, 1, summary.RebateCount)

				empty, err := GetInviteRebateSummary(9999)
				require.NoError(t, err)
				assert.Zero(t, empty.TotalQuota)
				assert.Zero(t, empty.ReversedQuota)
				assert.Zero(t, empty.RebateCount)
			})

			t.Run("member_level_filter", func(t *testing.T) {
				createInviteRebateUser(t, db, 31, common.RoleCommonUser, MemberLevelInternal, 0)
				createInviteRebateUser(t, db, 32, common.RoleCommonUser, MemberLevelNormal, 0)
				createInviteRebateUser(t, db, 33, common.RoleCommonUser, MemberLevelNormal, 0)

				internal := MemberLevelInternal
				users, total, err := SearchUsers("user3", "", nil, nil, &internal, 0, 50)
				require.NoError(t, err)
				assert.EqualValues(t, 1, total)
				require.Len(t, users, 1)
				assert.Equal(t, 31, users[0].Id)
				assert.Equal(t, MemberLevelInternal, users[0].MemberLevel)

				external := MemberLevelNormal
				_, total, err = SearchUsers("user3", "", nil, nil, &external, 0, 50)
				require.NoError(t, err)
				assert.EqualValues(t, 2, total)

				affected, err := UpdateUsersMemberLevelByBatch([]int{32, 33}, MemberLevelInternal)
				require.NoError(t, err)
				assert.EqualValues(t, 2, affected)
				assert.True(t, IsInviteRebateEligible(32))
			})

			t.Run("user_list_rebate_column", func(t *testing.T) {
				createInviteRebateUser(t, db, 51, common.RoleCommonUser, MemberLevelInternal, 0)
				createInviteRebateUser(t, db, 52, common.RoleCommonUser, MemberLevelInternal, 0)
				createInviteRebateUser(t, db, 53, common.RoleCommonUser, MemberLevelNormal, 51)
				createInviteRebateUser(t, db, 54, common.RoleCommonUser, MemberLevelNormal, 52)
				createInviteRebateUser(t, db, 55, common.RoleCommonUser, MemberLevelNormal, 51)

				require.NotNil(t, creditRebateInTx(t, 53, 100000, InviteRebateSourceEpay, "trade-list-1"))
				require.NotNil(t, creditRebateInTx(t, 55, 100000, InviteRebateSourceEpay, "trade-list-2"))
				require.NotNil(t, creditRebateInTx(t, 54, 100000, InviteRebateSourceEpay, "trade-list-3"))

				// 收益列是「一次 GROUP BY 汇总整页」，不再逐行查询：SUM(bigint) 在
				// PostgreSQL 上是 numeric，MySQL 的 ONLY_FULL_GROUP_BY 又只接受按
				// 分组列取值的投影，两边都得给出同一个数，且本页没有流水的邀请人
				// 要被填成 0（空集不出现在 GROUP BY 结果里）。
				assertRebateColumn := func(t *testing.T, users []*User) {
					t.Helper()
					got := make(map[int]int, len(users))
					for _, user := range users {
						got[user.Id] = user.InviteRebateQuota
					}
					// 51 拉来 53、55 两笔，52 拉来 54 一笔；53 自己是被邀请人，没发过返现。
					assert.Equal(t, 20000, got[51], "user%d 的收益列", 51)
					assert.Equal(t, 10000, got[52], "user%d 的收益列", 52)
					assert.Zero(t, got[53], "user%d 的收益列", 53)
				}

				users, _, err := GetAllUsers(&common.PageInfo{Page: 1, PageSize: 50})
				require.NoError(t, err)
				assertRebateColumn(t, users)

				// 列表有两条查询路径，搜索那条也要填。
				found, _, err := SearchUsers("user5", "", nil, nil, nil, 0, 10)
				require.NoError(t, err)
				assertRebateColumn(t, found)
			})

			t.Run("credit_reverse_and_wallet_limit", func(t *testing.T) {
				createInviteRebateUser(t, db, 41, common.RoleCommonUser, MemberLevelInternal, 0)
				createInviteRebateUser(t, db, 42, common.RoleCommonUser, MemberLevelNormal, 41)
				require.NotNil(t, creditRebateInTx(t, 42, 100000, InviteRebateSourceEpay, "trade-rev"))

				var rebate InviteRebate
				require.NoError(t, db.Where("source_ref = ?", "trade-rev").First(&rebate).Error)

				// 撤销取的是「FOR UPDATE + reversed_quota 的 CAS」：SQLite 上 FOR UPDATE
				// 是空操作，MySQL / PostgreSQL 上会真的加行锁，两条路径都要扣对且只能扣一次。
				reversed, err := ReverseInviteRebate(rebate.Id, 7, "三库验证")
				require.NoError(t, err)
				assert.Equal(t, 10000, reversed.ReversedQuota)
				requireQuota(t, db, 41, 0)
				_, err = ReverseInviteRebate(rebate.Id, 7, "再撤一次")
				assert.ErrorIs(t, err, ErrInviteRebateNotCredited)

				// 触顶守卫把上限比较和自增放在同一条 UPDATE 里，边界值要能原样存取。
				require.NoError(t, db.Model(&User{}).Where("id = ?", 41).
					Update("quota", common.MaxWalletQuota).Error)
				assert.Nil(t, creditRebateInTx(t, 42, 50000, InviteRebateSourceStripe, "trade-full"))
				requireQuota(t, db, 41, common.MaxWalletQuota)

				var skipped InviteRebate
				require.NoError(t, db.Where("source_ref = ?", "trade-full").First(&skipped).Error)
				assert.Equal(t, InviteRebateStatusSkipped, skipped.Status)
				assert.Equal(t, InviteRebateSkipWalletLimit, skipped.SkipReason)
			})

			// 邀请人数回填要跨方言成立：一条 GROUP BY 聚合加一批按 id 的 UPDATE，
			// MySQL 的 ONLY_FULL_GROUP_BY、PostgreSQL 把 COUNT(*) 当 numeric 回来
			// 都不能让它跑偏，重复执行还必须是空操作。
			t.Run("invite_count_backfill", func(t *testing.T) {
				inviter := createInviteRebateUser(t, db, 71, common.RoleCommonUser, MemberLevelNormal, 0)
				createInviteRebateUser(t, db, 72, common.RoleCommonUser, MemberLevelNormal, inviter.Id)
				createInviteRebateUser(t, db, 73, common.RoleCommonUser, MemberLevelNormal, inviter.Id)
				orphaned := createInviteRebateUser(t, db, 74, common.RoleCommonUser, MemberLevelNormal, 0)
				gone := createInviteRebateUser(t, db, 75, common.RoleCommonUser, MemberLevelNormal, orphaned.Id)
				require.NoError(t, db.Model(&User{}).Where("id = ?", orphaned.Id).Update("aff_count", 9).Error)
				require.NoError(t, db.Where("id = ?", gone.Id).Delete(&User{}).Error)

				for range 2 {
					require.NoError(t, InitializeInviteCounts())
					requireAffCount(t, db, inviter.Id, 2)
					// 下线已被注销的邀请人要归零，不能一直挂着过期计数。
					requireAffCount(t, db, orphaned.Id, 0)
				}
			})
		})
	}
}
