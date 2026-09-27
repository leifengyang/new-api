package model

import (
	"os"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// legacyInviteRebate 是加 leg 列、换唯一索引之前的那版台账。用它把「升级前的
// 库」原样搭出来，再跑真正的迁移，验证的是升级路径本身而不是新装的库。
type legacyInviteRebate struct {
	Id              int    `gorm:"primaryKey"`
	InviterId       int    `gorm:"index;not null"`
	InviteeId       int    `gorm:"index;not null"`
	Source          string `gorm:"type:varchar(32);not null;uniqueIndex:idx_invite_rebate_source,priority:1"`
	SourceRef       string `gorm:"type:varchar(255);not null;uniqueIndex:idx_invite_rebate_source,priority:2"`
	BaseQuota       int    `gorm:"type:bigint;not null;default:0"`
	RateBasisPoints int    `gorm:"not null;default:0"`
	RebateQuota     int    `gorm:"type:bigint;not null;default:0"`
	Status          string `gorm:"type:varchar(16);not null"`
	SkipReason      string `gorm:"type:varchar(64);not null;default:''"`
	ReversedQuota   int    `gorm:"type:bigint;not null;default:0"`
	ReversedAt      int64  `gorm:"type:bigint;not null;default:0"`
	ReversedBy      int    `gorm:"not null;default:0"`
	ReverseReason   string `gorm:"type:varchar(255);not null;default:''"`
	CreatedAt       int64  `gorm:"autoCreateTime;column:created_at"`
}

func (legacyInviteRebate) TableName() string { return "invite_rebates" }

// pgUserAccessTokenChurn 是 PostgreSQL 上每次启动都会重发的一条既有 DDL：GORM 的
// PG 迁移器认为 users.access_token 的 char(32) 与模型定义对不上，于是反复
// ALTER COLUMN TYPE。它出自上游 User 模型，与本迁移无关——单独跑
// AutoMigrate(&User{}) 两遍就能复现同一条语句。
//
// 在这里显式排除它，而不是把 users 整张表移出断言：后者会连同「本迁移可能引入的
// users 变更」一起放过，断言的覆盖面会莫名缩水。
const pgUserAccessTokenChurn = `ALTER TABLE "users" ALTER COLUMN "access_token" TYPE char(32)`

func withoutKnownSchemaChurn(mutations []string) []string {
	kept := make([]string, 0, len(mutations))
	for _, statement := range mutations {
		if strings.HasPrefix(statement, pgUserAccessTokenChurn) {
			continue
		}
		kept = append(kept, statement)
	}
	return kept
}

// testInviteRebateMigrationUpgradesLegacySchema 覆盖一次真实升级要做的两件事：
// 换掉只按 (source, source_ref) 去重的旧索引、补出 leg 列并回填存量行。
//
// 这里的表名是生产用的真名（invite_rebates / users），所以只跑在独立的库上，
// 结束后整表删掉。
func testInviteRebateMigrationUpgradesLegacySchema(t *testing.T, db *gorm.DB) {
	t.Helper()
	t.Cleanup(func() {
		_ = db.Migrator().DropTable("invite_rebates", "users", "logs")
	})
	require.NoError(t, db.Migrator().DropTable("invite_rebates", "users", "logs"))

	// 升级前的库：老索引结构 + 一条老流水。
	require.NoError(t, db.AutoMigrate(&User{}, &legacyInviteRebate{}))
	require.NoError(t, db.Exec("ALTER TABLE users ADD COLUMN first_topup_at bigint DEFAULT 0").Error)
	require.NoError(t, db.Exec(
		"INSERT INTO invite_rebates (inviter_id, invitee_id, source, source_ref, base_quota, rate_basis_points, rebate_quota, status, skip_reason, reversed_quota, reversed_at, reversed_by, reverse_reason, created_at) VALUES (1, 2, 'epay', 'trade-old', 100000, 1000, 10000, 'credited', '', 0, 0, 0, '', 1)",
	).Error)
	require.True(t, db.Migrator().HasIndex(&legacyInviteRebate{}, legacyInviteRebateSourceIndex))
	require.False(t, db.Migrator().HasColumn(&InviteRebate{}, "leg"))

	// 真正的启动路径：迁移跑在 AutoMigrate 之前；重启一次必须什么都不改。
	recorder := &migrationSQLRecorder{}
	for pass := range 2 {
		recorder.reset()
		require.NoError(t, migrateInviteRebateGrantUniqueness(db))
		require.NoError(t, db.Session(&gorm.Session{Logger: recorder}).
			AutoMigrate(&User{}, &InviteRebate{}, &Log{}))
		if pass == 1 {
			assert.Empty(t, withoutKnownSchemaChurn(recorder.schemaMutations()),
				"重复启动不能再改 schema")
		}
	}

	assert.False(t, db.Migrator().HasIndex(&InviteRebate{}, legacyInviteRebateSourceIndex),
		"旧索引必须被删掉，否则它会继续挡下一笔充值的第二条腿")
	assert.True(t, db.Migrator().HasIndex(&InviteRebate{}, inviteRebateGrantIndex))
	// first_topup_at 故意留在库里：升级路径不该动它，也不该把 users 的索引带走。
	assert.True(t, db.Migrator().HasColumn(&User{}, "first_topup_at"))
	assert.True(t, db.Migrator().HasIndex(&User{}, "idx_users_username"))

	// 存量行被回填成直属腿，金额一字不改。
	var legacy InviteRebate
	require.NoError(t, db.Where("source_ref = ?", "trade-old").First(&legacy).Error)
	assert.Equal(t, InviteRebateLegDirect, legacy.Leg)
	assert.Equal(t, 10000, legacy.RebateQuota)
}

// 迁移之后同一笔来源能落下两条腿——这正是换索引要解决的问题：带着旧索引时
// 第二条腿会因为 (source, source_ref) 重复被静默挡掉。
func testInviteRebateMigrationAllowsSecondLeg(t *testing.T, db *gorm.DB) {
	t.Helper()
	t.Cleanup(func() {
		_ = db.Migrator().DropTable("invite_rebates", "users", "logs")
	})
	require.NoError(t, db.Migrator().DropTable("invite_rebates", "users", "logs"))

	require.NoError(t, db.AutoMigrate(&User{}, &legacyInviteRebate{}))
	require.NoError(t, migrateInviteRebateGrantUniqueness(db))
	require.NoError(t, db.AutoMigrate(&User{}, &InviteRebate{}, &Log{}))

	previousDB, previousLogDB := DB, LOG_DB
	DB, LOG_DB = db, db
	t.Cleanup(func() { DB, LOG_DB = previousDB, previousLogDB })

	setInviteRebateRates(t, true, 1000, 100, 100)
	t.Cleanup(func() { setInviteRebateSetting(t, true, 1000) })
	createInviteRebateUser(t, db, 101, 1, MemberLevelInternal, 0)
	createInviteRebateUser(t, db, 102, 1, MemberLevelNormal, 101)
	createInviteRebateUser(t, db, 103, 1, MemberLevelNormal, 102)

	credits := creditRebateInTx(t, 103, 100000, InviteRebateSourceEpay, "trade-migrated")
	require.Len(t, credits, 2, "换过索引之后两条腿都要能落库")
}

func TestMigrateInviteRebateSQLite(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)

	var version string
	require.NoError(t, db.Raw("SELECT sqlite_version()").Scan(&version).Error)
	t.Logf("sqlite version: %s", version)

	testInviteRebateMigrationUpgradesLegacySchema(t, db)
	testInviteRebateMigrationAllowsSecondLeg(t, db)
}

func TestMigrateInviteRebateMySQL(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_MYSQL_DSN"))
	if dsn == "" {
		t.Skip("TEST_MYSQL_DSN is not configured")
	}
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })

	testInviteRebateMigrationUpgradesLegacySchema(t, db)
	testInviteRebateMigrationAllowsSecondLeg(t, db)
}

func TestMigrateInviteRebatePostgreSQL(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("TEST_POSTGRES_DSN is not configured")
	}
	db, err := gorm.Open(postgres.New(postgres.Config{
		DSN:                  dsn,
		PreferSimpleProtocol: true,
	}), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })

	testInviteRebateMigrationUpgradesLegacySchema(t, db)
	testInviteRebateMigrationAllowsSecondLeg(t, db)
}
