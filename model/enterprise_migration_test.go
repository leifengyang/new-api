package model

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// enterpriseColumns 是本次为「企业空间」加在 users 上的四列。迁移验证要证明的是
// 「上一版就有的库，装上这一版之后能用」：先按老结构建库、删掉这四列，再跑真正的
// 启动路径，而不是直接在一个新库上建表。
var enterpriseColumns = []string{
	"is_enterprise",
	"enterprise_owner_id",
	"enterprise_group_limits",
	"enterprise_model_limits",
}

// testEnterpriseMigrationUpgradesLegacySchema 覆盖一次真实升级要做的三件事：
// 补出四列、给归属列建索引、让存量用户默认落在「不是企业、无归属、不受限」上。
//
// 表名是生产用的真名（users / user_sessions），所以只跑在独立的库上，结束后整表删掉。
func testEnterpriseMigrationUpgradesLegacySchema(t *testing.T, db *gorm.DB) {
	t.Helper()
	drop := func() { _ = db.Migrator().DropTable("users", "user_sessions") }
	t.Cleanup(drop)
	require.NoError(t, db.Migrator().DropTable("users", "user_sessions"))

	// 升级前的库：结构同上一版，只是还没有这四列。
	require.NoError(t, db.AutoMigrate(&User{}, &UserSession{}))
	for _, column := range enterpriseColumns {
		if db.Migrator().HasColumn(&User{}, column) {
			require.NoError(t, db.Migrator().DropColumn(&User{}, column))
		}
	}
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, username, password, role, status, quota) VALUES (1, 'legacy', 'x', 1, 1, 500)",
	).Error)

	previousDB, previousLogDB := DB, LOG_DB
	previousType := common.MainDatabaseType()
	DB, LOG_DB = db, db
	common.SetMainDatabaseType(databaseTypeOf(t, db))
	t.Cleanup(func() {
		DB, LOG_DB = previousDB, previousLogDB
		common.SetMainDatabaseType(previousType)
	})

	// 真正的启动路径：先迁移旧表，再 AutoMigrate；重启一次必须什么都不改。
	recorder := &migrationSQLRecorder{}
	for pass := range 2 {
		recorder.reset()
		require.NoError(t, db.Session(&gorm.Session{Logger: recorder}).
			AutoMigrate(&User{}, &UserSession{}))
		if pass == 1 {
			assert.Empty(t, withoutKnownSchemaChurn(recorder.schemaMutations()),
				"重复启动不能再改 schema")
		}
	}

	for _, column := range enterpriseColumns {
		assert.True(t, db.Migrator().HasColumn(&User{}, column), "缺列 %s", column)
	}
	assert.True(t, db.Migrator().HasIndex(&User{}, "idx_users_enterprise_owner_id"))

	// 存量用户落在最保守的一侧：不是企业、没有归属、不受任何限制。
	var legacy User
	require.NoError(t, db.First(&legacy, 1).Error)
	assert.Equal(t, EnterpriseFlagNo, legacy.IsEnterprise)
	assert.Zero(t, legacy.EnterpriseOwnerId)
	assert.Empty(t, legacy.EnterpriseGroupLimits)
	assert.Empty(t, legacy.EnterpriseModelLimits)
	base := legacy.ToBaseUser()
	assert.Nil(t, base.GetEnterpriseGroupLimits(), "空列读出来必须是「不受限」")
	assert.Nil(t, base.GetEnterpriseModelLimits())

	// 新列能被真正用起来：打上标记后，老库里的账号就是一家企业。
	require.NoError(t, db.Model(&User{}).Where("id = ?", 1).Update("is_enterprise", EnterpriseFlagYes).Error)
	enterprise, err := GetEnterpriseAccount(1)
	require.NoError(t, err)
	assert.Equal(t, "legacy", enterprise.Username)

	// 归属查询走的是新索引：成员列表必须只挑得出这一家企业名下的人。
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, username, password, role, status, quota, enterprise_owner_id) VALUES (2, 'member', 'x', 1, 1, 0, 1)",
	).Error)
	members, total, err := ListEnterpriseMembers(1, EnterpriseMemberFilter{}, 0, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, members, 1)
	assert.Equal(t, "member", members[0].Username)
}

// databaseTypeOf 从连接本身判断方言，避免调用方再传一遍。
func databaseTypeOf(t *testing.T, db *gorm.DB) common.DatabaseType {
	t.Helper()
	switch db.Dialector.Name() {
	case "mysql":
		return common.DatabaseTypeMySQL
	case "postgres":
		return common.DatabaseTypePostgreSQL
	default:
		return common.DatabaseTypeSQLite
	}
}

// openMigrationTestDB 按仓库既有约定取一个可写的库：sqlite 走临时文件，
// MySQL / PostgreSQL 走 TEST_*_DSN，未配置则跳过。
func openMigrationTestDB(t *testing.T, dialect string) *gorm.DB {
	t.Helper()
	var dsn string
	switch dialect {
	case "sqlite":
		dsn = "local"
		previousPath := common.SQLitePath
		common.SQLitePath = filepath.Join(t.TempDir(), "enterprise-migration.db")
		t.Cleanup(func() { common.SQLitePath = previousPath })
	case "mysql":
		dsn = os.Getenv("TEST_MYSQL_DSN")
	case "postgres":
		dsn = os.Getenv("TEST_POSTGRES_DSN")
	}
	if dsn == "" {
		t.Skip("test database DSN is not configured")
	}
	t.Setenv("ENTERPRISE_MIGRATION_TEST_DSN", dsn)
	db, _, err := chooseDB("ENTERPRISE_MIGRATION_TEST_DSN", false)
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	t.Cleanup(func() { _ = sqlDB.Close() })
	return db
}

// TestEnterpriseSchemaAcrossDatabases 三库同测：SQLite 直接跑，MySQL 与
// PostgreSQL 需要 TEST_MYSQL_DSN / TEST_POSTGRES_DSN。
func TestEnterpriseSchemaAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := openMigrationTestDB(t, dialect)
			var version string
			if dialect == "sqlite" {
				require.NoError(t, db.Raw("SELECT sqlite_version()").Scan(&version).Error)
			} else {
				require.NoError(t, db.Raw("SELECT version()").Scan(&version).Error)
			}
			t.Logf("%s version: %s", dialect, version)
			testEnterpriseMigrationUpgradesLegacySchema(t, db)
		})
	}
}
