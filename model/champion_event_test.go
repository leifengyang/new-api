package model

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func championTestDB(t *testing.T, dialect string) *gorm.DB {
	t.Helper()
	oldDB, oldLog := DB, LOG_DB
	oldType, oldLogType := common.MainDatabaseType(), common.LogDatabaseType()
	oldPath, oldQuota, oldRedis := common.SQLitePath, common.QuotaPerUnit, common.RedisEnabled
	dsn := "local"
	switch dialect {
	case "sqlite":
		common.SQLitePath = filepath.Join(t.TempDir(), "champion.db")
	case "mysql":
		dsn = os.Getenv("TEST_MYSQL_DSN")
	case "postgres":
		dsn = os.Getenv("TEST_POSTGRES_DSN")
	}
	if dsn == "" {
		t.Skip("dedicated test database not configured")
	}
	t.Setenv("CHAMPION_TEST_DSN", dsn)
	db, kind, err := chooseDB("CHAMPION_TEST_DSN", false)
	require.NoError(t, err)
	conn, err := db.DB()
	require.NoError(t, err)
	if dialect == "sqlite" {
		conn.SetMaxOpenConns(1)
	} else {
		conn.SetMaxOpenConns(4)
	}
	DB, LOG_DB = db, db
	common.SetMainDatabaseType(kind)
	common.SetLogDatabaseType(kind)
	common.QuotaPerUnit, common.RedisEnabled = 500000, false
	t.Cleanup(func() {
		DB, LOG_DB = oldDB, oldLog
		common.SetMainDatabaseType(oldType)
		common.SetLogDatabaseType(oldLogType)
		common.SQLitePath, common.QuotaPerUnit, common.RedisEnabled = oldPath, oldQuota, oldRedis
		require.NoError(t, conn.Close())
	})
	var version string
	versionQuery := "SELECT VERSION()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("%s: %s", dialect, version)
	// TEST_* DSNs are dedicated disposable databases, never production DSNs.
	models := []any{&ChampionAward{}, &ChampionEvent{}, &EnterpriseWalletCharge{}, &Task{}, &Log{}, &User{}}
	require.NoError(t, db.Migrator().DropTable(models...))
	require.NoError(t, db.AutoMigrate(models...))
	return db
}

func TestChampionAwardsAcrossDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := championTestDB(t, dialect)
			ctx := context.Background()
			start, end := ChampionWindow()
			for id := 1; id <= 13; id++ {
				createEnterpriseUser(t, id, fmt.Sprintf("champion%d", id), common.RoleCommonUser, 100)
			}
			require.NoError(t, db.Model(&User{}).Where("id = ?", 10).Update("role", common.RoleAdminUser).Error)
			require.NoError(t, db.Model(&User{}).Where("id = ?", 11).Update("status", common.UserStatusDisabled).Error)
			logs := []Log{}
			for id := 1; id <= 12; id++ {
				logs = append(logs, Log{UserId: id, CreatedAt: start + int64(id), Quota: 1000, Type: LogTypeConsume, RequestId: fmt.Sprintf("consume-%d", id), Other: `{"billing_source":"wallet"}`})
			}
			// Tie: user 2 reaches the same amount earlier despite the larger ID.
			logs[0].CreatedAt = start + 3
			// Refunds never subtract original consumption; subscriptions, enterprise
			// portions and timestamps outside the half-open window never qualify.
			logs = append(logs, Log{UserId: 1, CreatedAt: start + 4, Quota: 1000, Type: LogTypeRefund}, Log{UserId: 9, CreatedAt: start + 4, Quota: 999999, Type: LogTypeConsume, Other: `{"billing_source":"subscription"}`}, Log{UserId: 9, CreatedAt: end, Quota: 999999, Type: LogTypeConsume, Other: `{"billing_source":"wallet"}`}, Log{UserId: 9, CreatedAt: start - 1, Quota: 999999, Type: LogTypeConsume, Other: `{"billing_source":"wallet"}`}, Log{UserId: 13, CreatedAt: start + 10, Quota: 10000, Type: LogTypeConsume, RequestId: "mixed", Other: `{"billing_source":"wallet"}`}, Log{UserId: 9, CreatedAt: start + 4, Quota: 999999, Type: LogTypeConsume, Other: `{broken`})
			require.NoError(t, db.Create(&logs).Error)
			require.NoError(t, db.Create(&EnterpriseWalletCharge{UserId: 13, RequestId: "mixed", Enterprise: 9500, Personal: 500}).Error)
			event, err := GetChampionEvent(ctx)
			require.NoError(t, err)
			require.NoError(t, SaveChampionEvent(ctx, event.Revision, true, []int{12}))
			event, err = GetChampionEvent(ctx)
			require.NoError(t, err)
			require.NoError(t, PreviewChampionEvent(ctx, time.Unix(end, 0), event.Revision))
			event, err = GetChampionEvent(ctx)
			require.NoError(t, err)
			assert.Equal(t, 10, event.Participants)
			assert.Equal(t, int64(234600000), event.TotalQuota) // 7 * $66.60 + 3 * $1
			assert.Equal(t, 1, event.UnknownLogs)
			var award1, award2, mixed ChampionAward
			require.NoError(t, db.Where("user_id = 1").First(&award1).Error)
			require.NoError(t, db.Where("user_id = 2").First(&award2).Error)
			require.NoError(t, db.Where("user_id = 13").First(&mixed).Error)
			assert.Equal(t, 1, award2.Position)
			assert.Equal(t, 2, award1.Position)
			assert.Equal(t, int64(1000), award1.Spend)
			assert.Equal(t, int64(500), mixed.Spend)
			require.Error(t, CreditChampionAward(ctx, award1.ID))
			require.Error(t, ConfirmChampionEvent(ctx, event.Revision, 10, time.Unix(end-1, 0)))
			require.Error(t, ConfirmChampionEvent(ctx, event.Revision-1, 10, time.Unix(end, 0)))
			require.NoError(t, ConfirmChampionEvent(ctx, event.Revision, 10, time.Unix(end, 0)))
			require.Error(t, PreviewChampionEvent(ctx, time.Unix(end+1, 0), event.Revision))
			// Concurrent delivery of the same reward is exactly once.
			if dialect != "sqlite" {
				// Both transactions must own separate connections before either
				// reads the award, so removal of row locking cannot hide behind
				// a serialized connection pool.
				var started sync.WaitGroup
				started.Add(2)
				var queries atomic.Int32
				require.NoError(t, db.Callback().Query().Before("gorm:query").Register("champion_overlap", func(tx *gorm.DB) {
					if tx.Statement.Table == "champion_awards" && queries.Add(1) <= 2 {
						started.Done()
						started.Wait()
					}
				}))
				t.Cleanup(func() { require.NoError(t, db.Callback().Query().Remove("champion_overlap")) })
			}
			var wg sync.WaitGroup
			errors := make(chan error, 2)
			for range 2 {
				wg.Go(func() { errors <- CreditChampionAward(ctx, award1.ID) })
			}
			wg.Wait()
			close(errors)
			for err := range errors {
				require.NoError(t, err)
			}
			require.NoError(t, RunChampionAwards(ctx))
			require.NoError(t, RunChampionAwards(ctx))
			var user User
			require.NoError(t, db.First(&user, 1).Error)
			assert.Equal(t, 33300100, user.Quota)
			require.NoError(t, db.Where("user_id = 13").First(&mixed).Error)
			assert.Equal(t, "credited", mixed.Status)
			assert.Equal(t, 8, mixed.Equipped)
			event, err = GetChampionEvent(ctx)
			require.NoError(t, err)
			assert.Equal(t, "completed", event.Status)
			// Restart migrations preserve the issued ledger and uniqueness.
			for range 2 {
				require.NoError(t, db.AutoMigrate(&ChampionEvent{}, &ChampionAward{}))
			}
			duplicate := ChampionAward{EventID: 1, UserID: 1}
			require.Error(t, db.Create(&duplicate).Error)
			require.NoError(t, db.First(&award1, award1.ID).Error)
			assert.Equal(t, "credited", award1.Status)
		})
	}
}

func TestChampionRewardFailureRollsBackAndCanRetry(t *testing.T) {
	db := championTestDB(t, "sqlite")
	ctx := context.Background()
	user := createEnterpriseUser(t, 1, "full-wallet", common.RoleCommonUser, common.MaxWalletQuota)
	award := ChampionAward{EventID: 1, UserID: user.Id, Position: 1, Quota: 33300000, Status: "pending"}
	require.NoError(t, db.Create(&award).Error)
	require.ErrorIs(t, CreditChampionAward(ctx, award.ID), ErrWalletQuotaLimitExceeded)
	var saved ChampionAward
	require.NoError(t, db.First(&saved, award.ID).Error)
	assert.Equal(t, "pending", saved.Status)
	assert.Zero(t, saved.CreditedAt)
	require.NoError(t, db.Model(user).Update("quota", 0).Error)
	require.NoError(t, CreditChampionAward(ctx, award.ID))
	require.NoError(t, db.First(user, user.Id).Error)
	assert.Equal(t, 33300000, user.Quota)
}

func TestChampionPreviewUsesSeparateLogDatabaseAndIncludesLastPage(t *testing.T) {
	db := championTestDB(t, "sqlite")
	logDB, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "logs.db")), &gorm.Config{})
	require.NoError(t, err)
	conn, err := logDB.DB()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, conn.Close()) })
	require.NoError(t, logDB.AutoMigrate(&Log{}))
	LOG_DB = logDB
	createEnterpriseUser(t, 1, "split-logs", common.RoleCommonUser, 0)
	start, end := ChampionWindow()
	// A decoy in the primary DB must not contribute to the ranking.
	require.NoError(t, db.Create(&Log{UserId: 1, CreatedAt: start, Type: LogTypeConsume, Quota: 999999, Other: `{"billing_source":"wallet"}`}).Error)
	logs := make([]Log, 501)
	for i := range logs {
		logs[i] = Log{UserId: 1, CreatedAt: start + int64(i), Type: LogTypeConsume, Quota: 1, RequestId: fmt.Sprintf("page-%d", i), Other: `{"billing_source":"wallet"}`}
	}
	require.NoError(t, logDB.CreateInBatches(logs, 100).Error)
	event, err := GetChampionEvent(context.Background())
	require.NoError(t, err)
	require.NoError(t, PreviewChampionEvent(context.Background(), time.Unix(end, 0), event.Revision))
	var award ChampionAward
	require.NoError(t, db.First(&award).Error)
	assert.Equal(t, int64(501), award.Spend)
	assert.Equal(t, start+500, award.ReachedAt)
}

// Opt in only with disposable databases initialized by the latest release.
// Run this separately from the destructive fresh-schema fixtures above.
func TestChampionDatabaseMigration(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			dsn := os.Getenv("TEST_CHAMPION_RELEASE_" + strings.ToUpper(dialect))
			fresh := dsn == ""
			if fresh {
				dsn = os.Getenv("TEST_CHAMPION_FRESH_" + strings.ToUpper(dialect))
			}
			if dsn == "" {
				t.Skip("disposable full database fixture not configured")
			}
			oldDB, oldLog := DB, LOG_DB
			oldType, oldLogType, oldPath := common.MainDatabaseType(), common.LogDatabaseType(), common.SQLitePath
			if dialect == "sqlite" {
				common.SQLitePath, dsn = dsn, "local"
			}
			t.Setenv("CHAMPION_RELEASE_DSN", dsn)
			db, kind, err := chooseDB("CHAMPION_RELEASE_DSN", false)
			require.NoError(t, err)
			conn, err := db.DB()
			require.NoError(t, err)
			DB, LOG_DB = db, db
			common.SetMainDatabaseType(kind)
			common.SetLogDatabaseType(kind)
			initCol()
			t.Cleanup(func() {
				DB, LOG_DB = oldDB, oldLog
				common.SetMainDatabaseType(oldType)
				common.SetLogDatabaseType(oldLogType)
				common.SQLitePath = oldPath
				initCol()
				require.NoError(t, conn.Close())
			})
			require.False(t, db.Migrator().HasTable(&ChampionAward{}), "must not already contain the new schema")
			if fresh {
				require.False(t, db.Migrator().HasTable(&User{}), "fresh fixture must be empty")
				require.NoError(t, migrateDB())
				require.NoError(t, migrateLOGDB())
			} else {
				require.True(t, db.Migrator().HasTable(&User{}), "must originate from the released image")
			}
			user := createEnterpriseUser(t, 910901, "champion-upgrade", common.RoleCommonUser, 7654321)
			for range 2 {
				require.NoError(t, migrateDB())
				require.NoError(t, migrateLOGDB())
			}
			require.NoError(t, db.First(user, user.Id).Error)
			assert.Equal(t, 7654321, user.Quota)
			assert.True(t, db.Migrator().HasIndex(&ChampionAward{}, "idx_champion_award"))
			award := ChampionAward{EventID: 1, UserID: user.Id, Quota: 500000, Position: 8, Status: "pending"}
			require.NoError(t, db.Create(&award).Error)
			require.NoError(t, CreditChampionAward(context.Background(), award.ID))
			for range 2 {
				require.NoError(t, migrateDB())
				require.NoError(t, migrateLOGDB())
			}
			require.NoError(t, CreditChampionAward(context.Background(), award.ID))
			require.NoError(t, db.First(user, user.Id).Error)
			assert.Equal(t, 8154321, user.Quota)
		})
	}
}

func TestChampionRanksTaskConsumptionFromDurableFunding(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := championTestDB(t, dialect)
			createEnterpriseUser(t, 1, "task-user", common.RoleCommonUser, 0)
			require.NoError(t, db.Create(&[]Task{
				{TaskID: "personal", UserId: 1, PrivateData: TaskPrivateData{BillingSource: "wallet"}},
				{TaskID: "subscription", UserId: 1, PrivateData: TaskPrivateData{BillingSource: "subscription", SubscriptionId: 3}},
				{TaskID: "other-user", UserId: 2, PrivateData: TaskPrivateData{BillingSource: "wallet"}},
				{TaskID: "ambiguous", UserId: 1, PrivateData: TaskPrivateData{BillingSource: "wallet"}},
				{TaskID: "ambiguous", UserId: 1, PrivateData: TaskPrivateData{BillingSource: "subscription", SubscriptionId: 4}},
			}).Error)
			start, end := ChampionWindow()
			require.NoError(t, db.Create(&[]Log{
				{UserId: 1, CreatedAt: start, Type: LogTypeConsume, Quota: 100, Other: `{"is_task":true,"task_id":"personal"}`},
				{UserId: 1, CreatedAt: start + 1, Type: LogTypeConsume, Quota: 50, Other: `{"is_task":true,"task_id":"personal","pre_consumed_quota":100,"actual_quota":150}`},
				{UserId: 1, CreatedAt: start + 2, Type: LogTypeConsume, Quota: 999, Other: `{"is_task":true,"task_id":"subscription"}`},
				{UserId: 1, CreatedAt: start + 2, Type: LogTypeConsume, Quota: 999, Other: `{"is_task":true,"task_id":"other-user"}`},
				{UserId: 1, CreatedAt: start + 2, Type: LogTypeConsume, Quota: 999, Other: `{"is_task":true,"task_id":"ambiguous"}`},
			}).Error)
			event, err := GetChampionEvent(context.Background())
			require.NoError(t, err)
			require.NoError(t, PreviewChampionEvent(context.Background(), time.Unix(end, 0), event.Revision))
			var award ChampionAward
			require.NoError(t, db.First(&award).Error)
			assert.Equal(t, int64(150), award.Spend)
			event, err = GetChampionEvent(context.Background())
			require.NoError(t, err)
			assert.Equal(t, 2, event.UnknownLogs)
		})
	}
}
