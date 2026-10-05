package model

import (
	"fmt"
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
			textTask := &SystemTask{TaskID: "text-probe-live", Type: "degradation_probe_text", Status: SystemTaskStatusRunning}
			require.NoError(t, db.Create(textTask).Error)
			textRecord := &DegradationWatchRecord{ChannelId: 41, ModelName: "sol", GroupName: "alpha", ProbeID: "sanae", RunId: textTask.TaskID, Status: "running"}
			require.NoError(t, CreateDegradationWatchRecord(textRecord))
			require.NoError(t, FailInterruptedDegradationWatchRecords())
			textActive, err := GetDegradationWatchRecordMeta(textRecord.Id)
			require.NoError(t, err)
			assert.Equal(t, "running", textActive.Status)
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

func TestDegradationWatchSevenDayRetentionMatrix(t *testing.T) {
	const now int64 = 1800000000
	cutoff := now - DegradationWatchRetentionSeconds
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := useDegradationWatchMatrixDB(t, dialect)
			fixtures := []DegradationWatchRecord{
				{ChannelId: 1, ModelName: "sol", Status: "succeeded", Success: true, CreatedAt: cutoff - 1, Html: "expired html", OutputText: "expired output"},
				{ChannelId: 1, ModelName: "sol", Status: "failed", Hidden: true, CreatedAt: cutoff - 1, ErrorDetails: "expired error"},
				{ChannelId: 1, ModelName: "sol", CreatedAt: cutoff - 1},
				{ChannelId: 1, ModelName: "sol", Status: "succeeded", Success: true, CreatedAt: cutoff, Html: "boundary html"},
				{ChannelId: 1, ModelName: "sol", Status: "failed", CreatedAt: now},
				{ChannelId: 1, ModelName: "sol", Status: "running", CreatedAt: cutoff - 1},
				{ChannelId: 1, ModelName: "sol", Status: "queued", CreatedAt: cutoff - 1},
			}
			require.NoError(t, db.Create(&fixtures).Error)
			filter := DegradationWatchRecordFilter{ModelNames: []string{"sol"}, IncludeHidden: true, Since: cutoff}
			page, err := ListDegradationWatchRecordsBefore(filter, 0, 10)
			require.NoError(t, err)
			require.Len(t, page, 4, "expired completed content is excluded even before cleanup runs")
			assert.Equal(t, []int{fixtures[6].Id, fixtures[5].Id, fixtures[4].Id, fixtures[3].Id}, []int{page[0].Id, page[1].Id, page[2].Id, page[3].Id})
			stats, err := GetDegradationWatchModelStats(nil, cutoff)
			require.NoError(t, err)
			require.Contains(t, stats, "sol")
			assert.EqualValues(t, 2, stats["sol"].Total)
			assert.EqualValues(t, 1, stats["sol"].Succeeded)
			deleted, err := PruneExpiredDegradationWatchRecords(now)
			require.NoError(t, err)
			assert.EqualValues(t, 3, deleted)
			for _, record := range fixtures[:3] {
				_, err = GetDegradationWatchRecordHtml(record.Id)
				assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
				_, err = GetDegradationWatchOutput(record.Id)
				assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			}
			html, err := GetDegradationWatchRecordHtml(fixtures[3].Id)
			require.NoError(t, err)
			assert.Equal(t, "boundary html", html)
			deleted, err = PruneExpiredDegradationWatchRecords(now)
			require.NoError(t, err)
			assert.Zero(t, deleted, "repeated cleanup is idempotent and preserves active tasks")
			require.NoError(t, FinishDegradationWatchRecord(&fixtures[5]))
			deleted, err = PruneExpiredDegradationWatchRecords(now)
			require.NoError(t, err)
			assert.EqualValues(t, 1, deleted, "an expired task is removed after finishing")
		})
	}
}

// Exact record schema from custom-v1.0.0-rc.39.26.
type degradationProbeReleasedRecord struct {
	Id        int `json:"id"`
	ChannelId int `json:"channel_id" gorm:"index;not null"`
	// RunId ties each model/channel attempt to its background batch. Legacy records may be empty.
	RunId           string `json:"run_id" gorm:"type:varchar(64);not null;default:'';index"`
	ModelName       string `json:"model_name" gorm:"type:varchar(128);not null;default:''"`
	ReasoningEffort string `json:"reasoning_effort" gorm:"type:varchar(32);not null;default:''"`
	Success         bool   `json:"success" gorm:"not null;default:false"`
	// FailureReason 截断到 maxDegradationWatchFailureReasonRunes，上游偶尔把整页
	// HTML 错误页塞进报错里。
	FailureReason string `json:"failure_reason" gorm:"type:varchar(512);not null;default:''"`
	// Empty status denotes a completed legacy record.
	Status          string   `json:"status" gorm:"type:varchar(16);not null;default:'';index"`
	ErrorDetails    LongText `json:"error_details"`
	OutputText      LongText `json:"-"`
	TokensEstimated bool     `json:"tokens_estimated" gorm:"not null;default:false"`
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

func (degradationProbeReleasedRecord) TableName() string { return "degradation_watch_records" }

func TestDegradationProbeDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := useDegradationWatchMatrixDB(t, dialect)
			for _, upgrade := range []bool{false, true} {
				t.Run(fmt.Sprint("upgrade=", upgrade), func(t *testing.T) {
					require.NoError(t, db.Migrator().DropTable(&DegradationWatchRecord{}))
					var legacy degradationProbeReleasedRecord
					if upgrade {
						require.NoError(t, db.AutoMigrate(&degradationProbeReleasedRecord{}))
						legacy = degradationProbeReleasedRecord{ChannelId: 80, ModelName: "sol", Html: "<html><svg/></html>", OutputText: "original output", ErrorDetails: "old diagnostics", CreatedAt: 1000, Success: true}
						require.NoError(t, db.Create(&legacy).Error)
					}
					require.NoError(t, db.AutoMigrate(&DegradationWatchRecord{}))
					logger := &migrationSQLRecorder{}
					require.NoError(t, db.Session(&gorm.Session{Logger: logger}).AutoMigrate(&DegradationWatchRecord{}))
					assert.Empty(t, logger.schemaMutations())
					if upgrade {
						var restored DegradationWatchRecord
						require.NoError(t, db.First(&restored, legacy.Id).Error)
						assert.Equal(t, legacy.Html, restored.Html)
						assert.Equal(t, legacy.OutputText, restored.OutputText)
						assert.Equal(t, legacy.ErrorDetails, restored.ErrorDetails)
						assert.Empty(t, restored.GroupName)
						assert.Empty(t, restored.ProbeID)
					}
					series := DegradationProbeSeries{GroupName: "alpha", ChannelID: 81, Model: "sol", ProbeID: "sanae"}
					fixtures := []DegradationWatchRecord{
						{Success: true, Verdict: "passed", Status: "succeeded", ElapsedMs: 1000},
						{Success: true, Verdict: "passed", Status: "succeeded", ElapsedMs: 1001},
						{Verdict: "mismatch", Status: "failed", FailureReason: "answer_mismatch"},
						{Verdict: "error", Status: "failed", FailureReason: "timeout", ErrorDetails: "full diagnostics"},
						{Status: "running", PromptTokens: 20, CompletionTokens: 10},
					}
					for i := range fixtures {
						r := &fixtures[i]
						r.ChannelId, r.GroupName, r.ModelName, r.ProbeID, r.ProbeKind, r.CreatedAt = 81, "alpha", "sol", "sanae", "text", int64(2000+i)
						r.PromptSnapshot, r.ExpectedSnapshot, r.OutputText = "historic prompt", "expected", "answer"
						require.NoError(t, CreateDegradationWatchRecord(r))
					}
					other := fixtures[0]
					other.Id, other.GroupName = 0, "beta"
					require.NoError(t, CreateDegradationWatchRecord(&other))
					other = fixtures[0]
					other.Id, other.ProbeID = 0, "other"
					require.NoError(t, CreateDegradationWatchRecord(&other))
					rows, stats, art, err := GetDegradationProbeHistory(series, 2000, 0, 3, false)
					require.NoError(t, err)
					assert.Len(t, rows, 3)
					assert.Nil(t, art)
					assert.EqualValues(t, 2, stats.Passed)
					assert.EqualValues(t, 1, stats.Mismatched)
					assert.EqualValues(t, 1, stats.Errors)
					assert.Equal(t, 1000.5, stats.AvgElapsedMs)
					assert.Equal(t, "running", rows[0].Status)
					assert.Equal(t, 10, rows[0].CompletionTokens)
					for _, row := range rows {
						assert.Empty(t, row.ErrorDetails)
						assert.Empty(t, row.PromptSnapshot)
						assert.Empty(t, row.OutputText)
					}
					older, _, _, err := GetDegradationProbeHistory(series, 2000, rows[2].Id, 3, false)
					require.NoError(t, err)
					assert.Len(t, older, 2)
					last, err := LastDegradationProbeAttempt(series)
					require.NoError(t, err)
					assert.EqualValues(t, 2004, last)
					content, err := GetDegradationProbeContent(fixtures[0].Id)
					require.NoError(t, err)
					assert.Equal(t, LongText("historic prompt"), content.PromptSnapshot)
				})
			}
		})
	}
}

func TestDegradationProbeAnswerCharacterDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := useDegradationWatchMatrixDB(t, dialect)
			series := DegradationProbeSeries{GroupName: "alpha", ChannelID: 81, Model: "sol", ProbeID: "sanae"}
			cases := []struct {
				output, status, verdict, kind, want string
				hidden                              bool
			}{
				{"高市早苗 \r\n\t\u3000", "succeeded", "passed", "text", "苗", false},
				{"uncertain", "failed", "mismatch", "text", "n", false},
				{"答案𠮷", "succeeded", "passed", "text", "𠮷", false},
				{" \r\n\t", "failed", "mismatch", "text", "", false},
				{"partial", "running", "", "text", "", false},
				{"", "queued", "", "text", "", false},
				{"partial", "failed", "error", "text", "", false},
				{"<html><svg/></html>", "succeeded", "passed", "drawing", "", false},
				{"private", "succeeded", "passed", "text", "e", true},
			}
			for _, tc := range cases {
				record := &DegradationWatchRecord{ChannelId: 81, GroupName: "alpha", ModelName: "sol", ProbeID: "sanae", ProbeKind: tc.kind, OutputText: LongText(tc.output), Status: tc.status, Verdict: tc.verdict, Success: tc.verdict == "passed", Hidden: tc.hidden, CreatedAt: 2000}
				require.NoError(t, CreateDegradationWatchRecord(record))
				rows, _, _, err := GetDegradationProbeHistory(series, 2000, 0, 1, true)
				require.NoError(t, err)
				require.Len(t, rows, 1)
				assert.Equal(t, tc.want, rows[0].AnswerLastCharacter)
				assert.Empty(t, rows[0].OutputText)
				content, err := GetDegradationProbeContent(record.Id)
				require.NoError(t, err)
				assert.Equal(t, tc.output, string(content.OutputText), "summary must preserve full detail content")
			}
			rows, _, _, err := GetDegradationProbeHistory(series, 2000, 0, 20, false)
			require.NoError(t, err)
			require.Len(t, rows, len(cases)-1)
			assert.Equal(t, "苗", rows[len(rows)-1].AnswerLastCharacter)
			older, _, _, err := GetDegradationProbeHistory(series, 2000, rows[1].Id, 20, false)
			require.NoError(t, err)
			assert.Equal(t, "苗", older[len(older)-1].AnswerLastCharacter)
			assert.False(t, db.Migrator().HasColumn(&DegradationWatchRecord{}, "answer_last_character"), "summary needs no schema migration")
			second := series
			second.ChannelID = 82
			other := &DegradationWatchRecord{ChannelId: 82, GroupName: "alpha", ModelName: "sol", ProbeID: "sanae", ProbeKind: "text", Success: true, Status: "succeeded", OutputText: "second", CreatedAt: 2001}
			require.NoError(t, CreateDegradationWatchRecord(other))
			combined, combinedStats, _, err := GetDegradationProbeHistoryForSeries([]DegradationProbeSeries{series, second}, 2000, 0, 2, false)
			require.NoError(t, err)
			require.Len(t, combined, 2)
			assert.Equal(t, other.Id, combined[0].Id)
			assert.Equal(t, "d", combined[0].AnswerLastCharacter)
			assert.EqualValues(t, 4, combinedStats.Passed)
			page, _, _, err := GetDegradationProbeHistoryForSeries([]DegradationProbeSeries{series, second}, 2000, combined[1].Id, 20, false)
			require.NoError(t, err)
			assert.Len(t, page, 7)
			assert.Equal(t, "苗", page[len(page)-1].AnswerLastCharacter)
			empty, emptyStats, _, err := GetDegradationProbeHistoryForSeries(nil, 2000, 0, 20, false)
			require.NoError(t, err)
			assert.Empty(t, empty)
			assert.Zero(t, emptyStats.Passed)
		})
	}
}
