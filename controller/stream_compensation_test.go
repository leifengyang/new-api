package controller

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
	"gorm.io/gorm"
)

func TestStreamCompensationClassification(t *testing.T) {
	for _, tc := range []struct{ name, other, want string }{
		{"client cancel", `{"cache_tokens":0,"stream_status":{"end_reason":"client_gone"}}`, "pending"},
		{"estimated zero", `{"cache_tokens":0,"admin_info":{"usage_billing_path":"estimated"},"stream_status":{"end_reason":"client_gone"}}`, "pending"},
		{"rounded zero excluded", `{"cache_tokens":1,"stream_status":{"end_reason":"client_gone"}}`, ""},
		{"missing cache review", `{"stream_status":{"end_reason":"client_gone"}}`, "review"},
		{"normal eof", `{"cache_tokens":0,"stream_status":{"end_reason":"eof","status":"ok"}}`, ""},
		{"unknown old eof", `{"cache_tokens":0,"stream_status":{"end_reason":"eof"}}`, ""},
		{"missing terminal", `{"cache_tokens":0,"stream_status":{"end_reason":"eof","expects_terminal":true}}`, "pending"},
		{"confirmed eof error", `{"cache_tokens":0,"stream_status":{"end_reason":"eof","status":"error"}}`, "pending"},
		{"completed eof", `{"cache_tokens":0,"stream_status":{"end_reason":"eof","expects_terminal":true,"response_status":"completed"}}`, ""},
		{"length limit", `{"cache_tokens":0,"stream_status":{"end_reason":"eof","status":"error","response_status":"incomplete","incomplete_reason":"max_output_tokens"}}`, ""},
		{"unexpected eof", `{"cache_tokens":0,"stream_status":{"end_reason":"scanner_error","end_error":"unexpected EOF"}}`, "pending"},
		{"timeout excluded", `{"cache_tokens":0,"stream_status":{"end_reason":"timeout","status":"error"}}`, ""},
		{"reset excluded", `{"cache_tokens":0,"stream_status":{"end_reason":"scanner_error","end_error":"connection reset"}}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			log := model.Log{Type: model.LogTypeConsume, Quota: 100, IsStream: true, Other: tc.other}
			status, _ := service.ClassifyStreamCompensation(&log)
			assert.Equal(t, tc.want, status)
			log.Quota = 0
			status, _ = service.ClassifyStreamCompensation(&log)
			assert.Empty(t, status)
		})
	}
	assert.Equal(t, model.CompensationStart()+86400, model.CompensationCutoff(time.Date(2026, 10, 3, 1, 59, 0, 0, model.CompensationLocation)))
	assert.Equal(t, model.CompensationStart()+2*86400, model.CompensationCutoff(time.Date(2026, 10, 3, 2, 0, 0, 0, model.CompensationLocation)))
}

func TestStreamCompensationDatabaseMatrix(t *testing.T) {
	redisEnabled := common.RedisEnabled
	common.RedisEnabled = false
	t.Cleanup(func() { common.RedisEnabled = redisEnabled })
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := selfTestDB(t, dialect)
			if dialect != "sqlite" {
				connection, err := db.DB()
				require.NoError(t, err)
				connection.SetMaxOpenConns(4)
			}
			oldLogDB := model.LOG_DB
			model.LOG_DB = db
			t.Cleanup(func() { model.LOG_DB = oldLogDB })
			tables := []any{&model.StreamCompensationMessage{}, &model.StreamCompensation{}, &model.StreamCompensationBatch{}, &model.StreamCompensationConfig{}}
			require.NoError(t, db.Migrator().DropTable(tables...))
			require.NoError(t, db.Migrator().DropTable(&model.Log{}))
			// The released User/Log schema is unchanged. Preserve a representative
			// account and consume row across installing the additive ledger schema.
			require.NoError(t, db.AutoMigrate(&model.Log{}))
			require.NoError(t, db.Model(&model.User{}).Where("id = 1").Updates(map[string]any{"quota": 500, "used_quota": 400, "status": 2}).Error)
			base := model.CompensationStart()
			logs := []model.Log{
				{UserId: 1, RequestId: "wallet", CreatedAt: base + 1, Type: 2, Quota: 100, IsStream: true, Other: `{"cache_tokens":0,"stream_status":{"end_reason":"client_gone"}}`},
				{UserId: 1, RequestId: "subscription", CreatedAt: base + 86401, Type: 2, Quota: 200, IsStream: true, Other: `{"billing_source":"subscription","cache_tokens":0,"stream_status":{"end_reason":"client_gone"}}`},
				{UserId: 1, RequestId: "enterprise", CreatedAt: base + 2, Type: 2, Quota: 300, IsStream: true, Other: `{"enterprise_quota":300,"cache_tokens":0,"stream_status":{"end_reason":"eof","status":"error"}}`},
				{UserId: 1, RequestId: "unknown", CreatedAt: base + 3, Type: 2, Quota: 50, IsStream: true, Other: `{"stream_status":{"end_reason":"client_gone"}}`},
				{UserId: 1, RequestId: "refunded", CreatedAt: base + 4, Type: 2, Quota: 70, IsStream: true, Other: `{"cache_tokens":0,"stream_status":{"end_reason":"client_gone"}}`},
				{UserId: 1, RequestId: "refunded", CreatedAt: base + 5, Type: 6, Quota: 70},
				{UserId: 99, RequestId: "deleted", CreatedAt: base + 6, Type: 2, Quota: 90, IsStream: true, Other: `{"cache_tokens":0,"stream_status":{"end_reason":"client_gone"}}`},
			}
			require.NoError(t, db.Create(&logs).Error)
			for range 2 {
				require.NoError(t, db.AutoMigrate(tables...))
			}
			assert.True(t, db.Migrator().HasIndex(&model.StreamCompensation{}, "SourceKey"))
			now := time.Date(2026, 10, 3, 2, 0, 0, 0, model.CompensationLocation)
			// Simulate a crash after credits commit but before the scan cursor
			// persists. The resume must scan the same rows without paying twice.
			require.NoError(t, db.Callback().Update().Before("gorm:update").Register("compensation:checkpoint_failure", func(tx *gorm.DB) {
				values, ok := tx.Statement.Dest.(map[string]any)
				if ok && tx.Statement.Table == "stream_compensation_batches" && values["cursor_time"] != nil {
					tx.AddError(errors.New("checkpoint unavailable"))
				}
			}))
			assert.ErrorContains(t, service.RunStreamCompensation(context.Background(), now), "checkpoint unavailable")
			require.NoError(t, db.Callback().Update().Remove("compensation:checkpoint_failure"))
			require.NoError(t, service.RunStreamCompensation(context.Background(), now))
			require.NoError(t, service.RunStreamCompensation(context.Background(), now))
			var user model.User
			require.NoError(t, db.First(&user, 1).Error)
			assert.Equal(t, 1100, user.Quota)
			assert.Equal(t, 400, user.UsedQuota)
			var batch model.StreamCompensationBatch
			require.NoError(t, db.First(&batch).Error)
			assert.Equal(t, base, batch.StartAt)
			assert.Equal(t, base+2*86400, batch.EndAt)
			messages, total, err := model.ListStreamCompensationMessages(1, true, 0, 20)
			require.NoError(t, err)
			require.EqualValues(t, 1, total)
			require.Len(t, messages, 1)
			assert.EqualValues(t, 600, messages[0].Quota)
			assert.EqualValues(t, 3, messages[0].Count)
			assert.Error(t, model.MarkStreamCompensationMessageRead(2, messages[0].ID, messages[0].Revision))
			require.NoError(t, model.MarkStreamCompensationMessageRead(1, messages[0].ID, messages[0].Revision))
			require.NoError(t, model.MarkStreamCompensationMessageRead(1, messages[0].ID, messages[0].Revision), "acknowledgement retries are idempotent")
			var review model.StreamCompensation
			require.NoError(t, db.Where("request_id = ?", "unknown").First(&review).Error)
			require.Equal(t, "review", review.Status)
			require.NoError(t, model.CreditStreamCompensation(context.Background(), review.ID, 2, true))
			require.NoError(t, model.CreditStreamCompensation(context.Background(), review.ID, 2, true))
			assert.Error(t, model.MarkStreamCompensationMessageRead(1, messages[0].ID, messages[0].Revision), "old device cannot mark a changed notification read")
			items, count, totals, err := model.ListStreamCompensations(1, "", 0, 0, 0, 0, 20)
			require.NoError(t, err)
			assert.EqualValues(t, 5, count)
			assert.Len(t, items, 5)
			assert.EqualValues(t, 650, totals.CreditedQuota)
			_, count, _, err = model.ListStreamCompensations(2, "", 0, 0, 0, 0, 20)
			require.NoError(t, err)
			assert.Zero(t, count)
			var original model.Log
			require.NoError(t, db.First(&original, logs[0].Id).Error)
			assert.Equal(t, 100, original.Quota)
			require.NoError(t, model.AttachStreamCompensations([]*model.Log{&original}))
			require.NotNil(t, original.Compensation)
			assert.Equal(t, 100, original.Compensation.Quota)
			// Ledger, wallet and inbox commit together; an over-limit wallet must
			// retain a retryable record with no credit or notification increment.
			record := model.StreamCompensation{SourceKey: "overflow", BatchID: batch.ID, UserID: 2, Quota: 1, OriginalQuota: 1, Status: "pending"}
			require.NoError(t, model.SaveStreamCompensation(context.Background(), &record))
			require.NoError(t, db.Model(&model.User{}).Where("id = 2").Update("quota", common.MaxWalletQuota).Error)
			assert.Error(t, model.CreditStreamCompensation(context.Background(), record.ID, 0, false))
			require.NoError(t, db.First(&record, record.ID).Error)
			assert.Equal(t, "pending", record.Status)
			require.NoError(t, db.Model(&model.User{}).Where("id = 2").Update("quota", 0).Error)
			var wg sync.WaitGroup
			errs := make(chan error, 2)
			for range 2 {
				wg.Go(func() { errs <- model.CreditStreamCompensation(context.Background(), record.ID, 0, false) })
			}
			wg.Wait()
			close(errs)
			for err := range errs {
				require.NoError(t, err)
			}
			user = model.User{}
			require.NoError(t, db.First(&user, 2).Error)
			assert.Equal(t, 1, user.Quota)
			// Migration is repeatable even after real ledger/inbox writes.
			for range 2 {
				require.NoError(t, db.AutoMigrate(tables...))
			}
			require.NoError(t, model.SetStreamCompensationEnabled(false))
			require.NoError(t, service.RunStreamCompensation(context.Background(), now.AddDate(0, 0, 1)))
			cfg, err := model.GetStreamCompensationConfig()
			require.NoError(t, err)
			assert.Equal(t, batch.EndAt, cfg.SettledUntil)
			require.NoError(t, model.SetStreamCompensationEnabled(true))
			require.NoError(t, service.RunStreamCompensation(context.Background(), now.AddDate(0, 0, 2)))
			var batches int64
			require.NoError(t, db.Model(&model.StreamCompensationBatch{}).Count(&batches).Error)
			assert.EqualValues(t, 3, batches)
			// Controller ignores a forged user_id on the self endpoint.
			r := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(r)
			c.Set("id", 2)
			c.Request = httptest.NewRequest("GET", "/?user_id=1", nil)
			GetStreamCompensations(c)
			assert.True(t, gjson.Get(r.Body.String(), "success").Bool())
			assert.NotContains(t, r.Body.String(), `"request_id":"wallet"`)
			var version string
			query := "SELECT version()"
			if dialect == "sqlite" {
				query = "SELECT sqlite_version()"
			}
			require.NoError(t, db.Raw(query).Scan(&version).Error)
			t.Logf("%s %s", dialect, strings.TrimSpace(version))
		})
	}
}

func TestStreamCompensationIndependentLogStores(t *testing.T) {
	for _, tc := range []struct{ kind, env string }{{"mysql", "SELF_TEST_MYSQL_DSN"}, {"postgres", "SELF_TEST_POSTGRES_DSN"}, {"clickhouse", "COMPENSATION_CLICKHOUSE_DSN"}} {
		t.Run(tc.kind, func(t *testing.T) {
			dsn := os.Getenv(tc.env)
			if dsn == "" {
				t.Skip(tc.env + " not configured")
			}
			db := selfTestDB(t, "sqlite")
			require.NoError(t, db.AutoMigrate(&model.StreamCompensationConfig{}, &model.StreamCompensationBatch{}, &model.StreamCompensation{}, &model.StreamCompensationMessage{}))
			logDB, _ := newAuditTestDatabase(t, tc.kind, dsn)
			oldLogDB, oldType, oldRedis := model.LOG_DB, common.LogDatabaseType(), common.RedisEnabled
			model.LOG_DB = logDB
			common.SetLogDatabaseType(common.DatabaseType(tc.kind))
			common.RedisEnabled = false
			t.Cleanup(func() { model.LOG_DB = oldLogDB; common.SetLogDatabaseType(oldType); common.RedisEnabled = oldRedis })
			if tc.kind == "clickhouse" {
				require.NoError(t, logDB.Exec(releasedClickHouseLogSchema).Error)
			} else {
				require.NoError(t, logDB.AutoMigrate(&model.Log{}))
			}
			log := model.Log{UserId: 1, RequestId: "split-log-request", CreatedAt: model.CompensationStart() + 1, Type: 2, Quota: 123, IsStream: true, Other: `{"cache_tokens":0,"stream_status":{"end_reason":"client_gone"}}`}
			require.NoError(t, logDB.Create(&log).Error)
			now := time.Date(2026, 10, 2, 2, 0, 0, 0, model.CompensationLocation)
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			assert.Error(t, service.RunStreamCompensation(ctx, now))
			require.NoError(t, service.RunStreamCompensation(context.Background(), now))
			require.NoError(t, service.RunStreamCompensation(context.Background(), now))
			var user model.User
			require.NoError(t, db.First(&user, 1).Error)
			assert.Equal(t, 123, user.Quota)
			var original model.Log
			require.NoError(t, logDB.Where("request_id = ?", log.RequestId).First(&original).Error)
			assert.Equal(t, 123, original.Quota)
			require.NoError(t, model.AttachStreamCompensations([]*model.Log{&original}))
			require.NotNil(t, original.Compensation)
			messages, count, err := model.ListStreamCompensationMessages(1, true, 0, 10)
			require.NoError(t, err)
			require.EqualValues(t, 1, count)
			assert.EqualValues(t, 123, messages[0].Quota)
		})
	}
}
