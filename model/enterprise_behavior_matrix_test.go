package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// 下面三个场景在三库上跑同一份逻辑。SQLite 上 lockForUpdate 是空操作，正确性全靠
// 每条 UPDATE 的 CAS 条件；MySQL / PostgreSQL 上才是真的 SELECT ... FOR UPDATE。
// 两条路径都必须成立，所以不能在 SQLite 上跑绿就算数。

func testEnterpriseTransferMovesQuotaBothWays(t *testing.T) {
	t.Helper()
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 1000)
	markEnterprise(t, enterprise.Id)
	member := createEnterpriseUser(t, 2, "member", common.RoleCommonUser, 0)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", member.Id).
		Update("enterprise_owner_id", enterprise.Id).Error)

	_, err := TransferEnterpriseQuotaToMember(enterprise.Id, member.Id, 400)
	require.NoError(t, err)
	requireQuotaValue(t, enterprise.Id, 600)
	requireQuotaValue(t, member.Id, 400)

	// 停用把余额原样退回，金额一分不差。
	returned, err := SetEnterpriseMemberStatus(enterprise.Id, member.Id, false)
	require.NoError(t, err)
	assert.Equal(t, 400, returned)
	requireQuotaValue(t, enterprise.Id, 1000)
	requireQuotaValue(t, member.Id, 0)
}

func testEnterpriseUnmarkReleasesEveryMember(t *testing.T) {
	t.Helper()
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 700)
	markEnterprise(t, enterprise.Id)

	for id, quota := range map[int]int{2: 120, 3: 0, 4: -25} {
		createEnterpriseUser(t, id, "m"+string(rune('0'+id)), common.RoleCommonUser, quota)
		require.NoError(t, DB.Model(&User{}).Where("id = ?", id).Updates(map[string]any{
			"enterprise_owner_id":     enterprise.Id,
			"enterprise_group_limits": `["vip"]`,
		}).Error)
	}

	released, err := SetUserEnterpriseFlag(enterprise.Id, false)
	require.NoError(t, err)
	assert.Equal(t, 3, released)
	// 带符号求和：-25 也要退回去。
	requireQuotaValue(t, enterprise.Id, 700+120+0-25)
	for id := range map[int]int{2: 0, 3: 0, 4: 0} {
		requireQuotaValue(t, id, 0)
		var member User
		require.NoError(t, DB.First(&member, id).Error)
		assert.Zero(t, member.EnterpriseOwnerId)
		assert.Empty(t, member.EnterpriseGroupLimits)
	}
}

// CAS 兜底：余额在锁外被人改动过时，条件更新必须不命中，让上层重来，而不是
// 拿着过期余额盲目覆盖。SQLite 上没有行锁，这条断言就是正确性的全部依靠。
func testEnterpriseTransferRefusesStaleBalance(t *testing.T) {
	t.Helper()
	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 1000)
	markEnterprise(t, enterprise.Id)
	member := createEnterpriseUser(t, 2, "member", common.RoleCommonUser, 0)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", member.Id).
		Update("enterprise_owner_id", enterprise.Id).Error)

	stale := User{Id: enterprise.Id, Quota: 1000}
	// 模拟并发写入：另一个人已经把企业余额改掉了。
	require.NoError(t, DB.Model(&User{}).Where("id = ?", enterprise.Id).Update("quota", 999).Error)

	_, err := applyWalletDeltaTx(DB, &stale, -100)
	assert.ErrorIs(t, err, ErrEnterpriseWalletChanged)
	// 失败时绝不能落库。
	requireQuotaValue(t, enterprise.Id, 999)

	// 余额一致时正常写入。
	fresh := User{Id: enterprise.Id, Quota: 999}
	after, err := applyWalletDeltaTx(DB, &fresh, -100)
	require.NoError(t, err)
	assert.Equal(t, 899, after)
	requireQuotaValue(t, enterprise.Id, 899)
}

func TestEnterpriseBehaviorAcrossDatabases(t *testing.T) {
	scenarios := []struct {
		name string
		run  func(*testing.T)
	}{
		{"transfer_and_refund", testEnterpriseTransferMovesQuotaBothWays},
		{"unmark_releases_members", testEnterpriseUnmarkReleasesEveryMember},
		{"stale_balance_cas", testEnterpriseTransferRefusesStaleBalance},
	}

	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := openMigrationTestDB(t, dialect)
			for _, scenario := range scenarios {
				t.Run(scenario.name, func(t *testing.T) {
					resetEnterpriseTables(t, db)
					useEnterpriseGlobalsFor(t, db)
					scenario.run(t)
				})
			}
		})
	}
}

// resetEnterpriseTables 每个场景都从空表开始，免得上一个场景留下的行被算进成员数。
func resetEnterpriseTables(t *testing.T, db *gorm.DB) {
	t.Helper()
	require.NoError(t, db.Migrator().DropTable("users", "user_sessions"))
	require.NoError(t, db.AutoMigrate(&User{}, &UserSession{}))
}

// useEnterpriseGlobalsFor 把包级 DB 指向给定连接，并按方言设置主库类型
// （lockForUpdate 靠它决定要不要发 FOR UPDATE）。
func useEnterpriseGlobalsFor(t *testing.T, db *gorm.DB) {
	t.Helper()
	previousDB, previousLogDB := DB, LOG_DB
	previousType := common.MainDatabaseType()
	previousCache := common.RedisEnabled
	DB, LOG_DB = db, db
	common.SetMainDatabaseType(databaseTypeOf(t, db))
	common.RedisEnabled = false
	t.Cleanup(func() {
		DB, LOG_DB = previousDB, previousLogDB
		common.SetMainDatabaseType(previousType)
		common.RedisEnabled = previousCache
	})
}
