package model

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func useDegradationWatchMatrixDB(t *testing.T, dialect string) *gorm.DB {
	t.Helper()
	const envName = "DEGRADATION_WATCH_MATRIX_DSN"
	switch dialect {
	case "sqlite":
		previousPath := common.SQLitePath
		common.SQLitePath = filepath.Join(t.TempDir(), "degradation-watch-matrix.db")
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
	versionQuery := "SELECT VERSION()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	var version string
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("Database version: %s", version)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)

	previousDB := DB
	previousType := common.MainDatabaseType()
	DB = db
	common.SetMainDatabaseType(dbType)
	t.Cleanup(func() {
		DB = previousDB
		common.SetMainDatabaseType(previousType)
		_ = db.Migrator().DropTable(&DegradationWatchRecord{})
		_ = sqlDB.Close()
	})

	require.NoError(t, db.Migrator().DropTable(&DegradationWatchRecord{}))
	require.NoError(t, db.AutoMigrate(&DegradationWatchRecord{}))
	return db
}

func createDegradationWatchRecords(t *testing.T, channelId int, outcomes ...bool) []*DegradationWatchRecord {
	t.Helper()
	records := make([]*DegradationWatchRecord, 0, len(outcomes))
	for i, success := range outcomes {
		record := &DegradationWatchRecord{
			ChannelId: channelId,
			ModelName: "gpt-6-astra",
			Success:   success,
			CreatedAt: int64(1000 + i),
		}
		if success {
			record.Html = "<html><svg></svg></html>"
		} else {
			record.FailureReason = "no_html"
		}
		require.NoError(t, CreateDegradationWatchRecord(record))
		records = append(records, record)
	}
	return records
}

func TestDegradationWatchDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := useDegradationWatchMatrixDB(t, dialect)

			t.Run("restart_does_not_alter_schema", func(t *testing.T) {
				recorder := &migrationSQLRecorder{}
				require.NoError(t, db.Session(&gorm.Session{Logger: recorder}).AutoMigrate(&DegradationWatchRecord{}))
				assert.Empty(t, recorder.schemaMutations())
			})

			t.Run("html_larger_than_mysql_text_round_trips", func(t *testing.T) {
				// MySQL 的 TEXT 上限 64 KiB，动画作品常常逼近这个量级。
				html := "<html><svg>" + strings.Repeat("<circle r=\"1\"/>", 6000) + "</svg></html>"
				require.Greater(t, len(html), 65535)
				record := &DegradationWatchRecord{ChannelId: 99, Success: true, Html: LongText(html)}
				require.NoError(t, CreateDegradationWatchRecord(record))
				stored, err := GetDegradationWatchRecordHtml(record.Id)
				require.NoError(t, err)
				assert.Equal(t, html, stored)
			})

			t.Run("stats_count_hidden_records_but_not_as_visible", func(t *testing.T) {
				records := createDegradationWatchRecords(t, 1, true, false, true, true)
				createDegradationWatchRecords(t, 2, false)
				require.NoError(t, SetDegradationWatchRecordHidden(records[0].Id, true))

				stats, err := GetDegradationWatchChannelStats([]int{1, 2, 3})
				require.NoError(t, err)
				require.Contains(t, stats, 1)
				assert.EqualValues(t, 4, stats[1].Total)
				assert.EqualValues(t, 3, stats[1].Succeeded, "hiding a record must not change the success rate")
				assert.EqualValues(t, 3, stats[1].Visible)
				assert.EqualValues(t, 1003, stats[1].LastRecordAt)
				assert.EqualValues(t, 0, stats[2].Succeeded)
				assert.NotContains(t, stats, 3)

				visible, err := ListDegradationWatchRecords(1, 0, 10, false)
				require.NoError(t, err)
				require.Len(t, visible, 3)
				assert.Equal(t, records[3].Id, visible[0].Id)
				assert.Empty(t, visible[0].Html, "list queries must not load the artwork")

				older, err := ListDegradationWatchRecords(1, records[2].Id, 10, true)
				require.NoError(t, err)
				require.Len(t, older, 2)
				assert.Equal(t, records[1].Id, older[0].Id)

				assert.ErrorIs(t, SetDegradationWatchRecordHidden(987654, true), gorm.ErrRecordNotFound)
				assert.NoError(t, SetDegradationWatchRecordHidden(records[0].Id, true), "re-hiding is not a missing record")
			})

			t.Run("prune_keeps_latest_per_channel_including_hidden", func(t *testing.T) {
				records := createDegradationWatchRecords(t, 5, true, true, false, true, true)
				other := createDegradationWatchRecords(t, 6, true, true)
				require.NoError(t, SetDegradationWatchRecordHidden(records[4].Id, true))

				pruned, err := PruneDegradationWatchRecords(DegradationWatchSeries{ChannelId: 5, ModelName: "gpt-6-astra"}, 2)
				require.NoError(t, err)
				assert.EqualValues(t, 3, pruned)

				kept, err := ListDegradationWatchRecords(5, 0, 10, true)
				require.NoError(t, err)
				require.Len(t, kept, 2)
				assert.Equal(t, records[4].Id, kept[0].Id)
				assert.Equal(t, records[3].Id, kept[1].Id)

				untouched, err := ListDegradationWatchRecords(6, 0, 10, true)
				require.NoError(t, err)
				assert.Len(t, untouched, len(other))

				pruned, err = PruneDegradationWatchRecords(DegradationWatchSeries{ChannelId: 5, ModelName: "gpt-6-astra"}, 2)
				require.NoError(t, err)
				assert.EqualValues(t, 0, pruned)
			})
		})
	}
}

// Released rc.39.22 schema: exercise upgrading existing records, not only fresh creation.
type degradationWatchReleasedRecord struct {
	Id        int `json:"id"`
	ChannelId int `json:"channel_id" gorm:"index;not null"`
	// RunId 是这一轮系统任务的 TaskID，同一轮所有模型、所有渠道共用，检测墙
	// 按它把作品对齐成一行。多模型之前的旧记录为空，按时间归轮。
	RunId           string `json:"run_id" gorm:"type:varchar(64);not null;default:''"`
	ModelName       string `json:"model_name" gorm:"type:varchar(128);not null;default:''"`
	ReasoningEffort string `json:"reasoning_effort" gorm:"type:varchar(32);not null;default:''"`
	Success         bool   `json:"success" gorm:"not null;default:false"`
	// FailureReason 截断到 maxDegradationWatchFailureReasonRunes，上游偶尔把整页
	// HTML 错误页塞进报错里。
	FailureReason string `json:"failure_reason" gorm:"type:varchar(512);not null;default:''"`
	// Html 是抽出来的作品本体，动辄几十 KB，所以用 LongText；列表接口不查这一列。
	Html             LongText `json:"-"`
	ElapsedMs        int64    `json:"elapsed_ms" gorm:"not null;default:0"`
	PromptTokens     int      `json:"prompt_tokens" gorm:"not null;default:0"`
	CompletionTokens int      `json:"completion_tokens" gorm:"not null;default:0"`
	ReasoningTokens  int      `json:"reasoning_tokens" gorm:"not null;default:0"`
	// Hidden 只影响展示：被管理员藏起来的作品照样计入成功率。
	Hidden    bool  `json:"hidden" gorm:"not null;default:false"`
	CreatedAt int64 `json:"created_at" gorm:"bigint;index"`
}

func (degradationWatchReleasedRecord) TableName() string { return "degradation_watch_records" }

func TestDegradationWatchLiveDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := useDegradationWatchMatrixDB(t, dialect)
			require.NoError(t, db.Migrator().DropTable(&DegradationWatchRecord{}))
			require.NoError(t, db.AutoMigrate(&degradationWatchReleasedRecord{}))
			legacy := degradationWatchReleasedRecord{ChannelId: 41, ModelName: "sol", Success: true, Html: "<html><svg/></html>", Hidden: true}
			require.NoError(t, db.Create(&legacy).Error)
			require.NoError(t, db.AutoMigrate(&DegradationWatchRecord{}, &SystemTask{}))
			t.Cleanup(func() { _ = db.Migrator().DropTable(&SystemTask{}) })
			logger := &migrationSQLRecorder{}
			require.NoError(t, db.Session(&gorm.Session{Logger: logger}).AutoMigrate(&DegradationWatchRecord{}))
			assert.Empty(t, logger.schemaMutations())
			stored, err := GetDegradationWatchRecordMeta(legacy.Id)
			require.NoError(t, err)
			assert.True(t, stored.Success)
			assert.True(t, stored.Hidden)
			assert.Empty(t, stored.Status)
			html, err := GetDegradationWatchRecordHtml(legacy.Id)
			require.NoError(t, err)
			assert.Equal(t, string(legacy.Html), html)
			task := &SystemTask{TaskID: "live-batch", Type: SystemTaskTypeDegradationWatch, Status: SystemTaskStatusRunning}
			require.NoError(t, db.Create(task).Error)
			pending := &DegradationWatchRecord{ChannelId: 41, ModelName: "sol", RunId: task.TaskID, Status: "queued"}
			require.NoError(t, CreateDegradationWatchRecord(pending))
			require.NoError(t, SetDegradationWatchRecordHidden(pending.Id, true))
			pending.Status = "running"
			pending.OutputText = LongText(strings.Repeat("stream-output", 6000))
			pending.CompletionTokens = 37
			pending.TokensEstimated = true
			require.NoError(t, UpdateDegradationWatchProgress(pending))
			require.NoError(t, FailInterruptedDegradationWatchRecords())
			active, err := GetDegradationWatchRecordMeta(pending.Id)
			require.NoError(t, err)
			assert.Equal(t, "running", active.Status)
			assert.True(t, active.Hidden)
			assert.Empty(t, active.OutputText)
			output, err := GetDegradationWatchOutput(pending.Id)
			require.NoError(t, err)
			assert.Equal(t, string(pending.OutputText), output)
			stats, err := GetDegradationWatchChannelStats([]int{41})
			require.NoError(t, err)
			assert.EqualValues(t, 1, stats[41].Total)
			pending.FailureReason = strings.Repeat("upstream diagnostic ", 6000) + "last-error-line"
			require.NoError(t, FinishDegradationWatchRecord(pending))
			pending.Status = "running"
			pending.CompletionTokens = 999
			require.NoError(t, UpdateDegradationWatchProgress(pending))
			terminal, err := GetDegradationWatchRecordMeta(pending.Id)
			require.NoError(t, err)
			assert.Equal(t, "failed", terminal.Status)
			assert.Equal(t, 37, terminal.CompletionTokens)
			assert.True(t, strings.HasSuffix(string(terminal.ErrorDetails), "last-error-line"))
			assert.Len(t, []rune(terminal.FailureReason), 500)
			abandoned := &DegradationWatchRecord{ChannelId: 41, ModelName: "sol", RunId: "orphaned", Status: "running"}
			require.NoError(t, CreateDegradationWatchRecord(abandoned))
			require.NoError(t, FailInterruptedDegradationWatchRecords())
			interrupted, err := GetDegradationWatchRecordMeta(abandoned.Id)
			require.NoError(t, err)
			assert.Equal(t, "failed", interrupted.Status)
			assert.Equal(t, "interrupted", interrupted.FailureReason)
		})
	}
}
