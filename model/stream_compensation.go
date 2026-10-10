package model

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const StreamCompensationTaskType = "stream_compensation"

var CompensationLocation = time.FixedZone("Asia/Shanghai", 8*60*60)

func CompensationStart() int64 {
	return time.Date(2026, 10, 1, 0, 0, 0, 0, CompensationLocation).Unix()
}

// Cutoff is exclusive. Before 02:00 the previous day is not yet due.
func CompensationCutoff(now time.Time) int64 {
	now = now.In(CompensationLocation)
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, CompensationLocation)
	if now.Hour() < 2 {
		day = day.AddDate(0, 0, -1)
	}
	return day.Unix()
}

type StreamCompensationConfig struct {
	ID           int   `json:"-" gorm:"primaryKey;autoIncrement:false"`
	Enabled      bool  `json:"enabled"`
	SettledUntil int64 `json:"settled_until"`
}

type StreamCompensationBatch struct {
	ID            int64  `json:"id" gorm:"primaryKey"`
	StartAt       int64  `json:"start_at"`
	EndAt         int64  `json:"end_at" gorm:"uniqueIndex"`
	Status        string `json:"status" gorm:"type:varchar(24)"`
	CursorTime    int64  `json:"-"`
	CursorRequest string `json:"-" gorm:"type:varchar(64)"`
	CursorID      int    `json:"-"`
	Scanned       int64  `json:"scanned"`
	Error         string `json:"error" gorm:"type:text"`
	CreatedAt     int64  `json:"created_at"`
	CompletedAt   int64  `json:"completed_at"`
}

// The primary DB owns both this immutable charge snapshot and the wallet credit.
// The log DB can be separate or ClickHouse; no cross-database transaction is assumed.
type StreamCompensation struct {
	Dimensions      CompensationDimensions `json:"-" gorm:"embedded;embeddedPrefix:dimension_"`
	SnapshotVersion int                    `json:"-" gorm:"index"`
	ID              int64                  `json:"id" gorm:"primaryKey"`
	SourceKey       string                 `json:"-" gorm:"type:varchar(64);uniqueIndex"`
	BatchID         int64                  `json:"batch_id" gorm:"index"`
	UserID          int                    `json:"user_id" gorm:"index:idx_comp_user_status,priority:1"`
	RequestID       string                 `json:"request_id" gorm:"type:varchar(64);index"`
	ModelName       string                 `json:"model_name" gorm:"type:varchar(255)"`
	ConsumedAt      int64                  `json:"consumed_at" gorm:"index"`
	OriginalQuota   int                    `json:"original_quota"`
	Quota           int                    `json:"quota"`
	Reason          string                 `json:"reason" gorm:"type:varchar(32)"`
	Status          string                 `json:"status" gorm:"type:varchar(24);index:idx_comp_user_status,priority:2"`
	Note            string                 `json:"note" gorm:"type:varchar(255)"`
	CreditedAt      int64                  `json:"credited_at" gorm:"index"`
	ReviewedBy      int                    `json:"reviewed_by"`
}

// One durable inbox item per user and batch; read state is shared across devices.
type StreamCompensationMessage struct {
	ID        int64 `json:"id" gorm:"primaryKey"`
	BatchID   int64 `json:"batch_id" gorm:"uniqueIndex:idx_comp_message,priority:1"`
	UserID    int   `json:"-" gorm:"uniqueIndex:idx_comp_message,priority:2;index"`
	Quota     int64 `json:"quota"`
	Count     int64 `json:"count"`
	StartAt   int64 `json:"start_at"`
	EndAt     int64 `json:"end_at"`
	CreatedAt int64 `json:"created_at"`
	ReadAt    int64 `json:"read_at"`
	Revision  int64 `json:"revision"`
}

func GetStreamCompensationConfig() (StreamCompensationConfig, error) {
	cfg := StreamCompensationConfig{ID: 1, Enabled: true, SettledUntil: CompensationStart()}
	if err := DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&cfg).Error; err != nil {
		return cfg, err
	}
	err := DB.First(&cfg, 1).Error
	return cfg, err
}

func SetStreamCompensationEnabled(enabled bool) error {
	if _, err := GetStreamCompensationConfig(); err != nil {
		return err
	}
	return DB.Model(&StreamCompensationConfig{}).Where("id = 1").Update("enabled", enabled).Error
}

func CompensationSourceKey(log *Log) string {
	if log.RequestId != "" {
		return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("request:%d:%s", log.UserId, log.RequestId))))
	}
	// Legacy rows without a request id still get a stable key, never a display-row id.
	id := log.Id
	if common.UsingLogDatabase(common.DatabaseTypeClickHouse) {
		id = 0
	}
	raw := fmt.Sprintf("legacy:%d:%d:%d:%d:%s:%d:%d", id, log.UserId, log.CreatedAt, log.TokenId, log.ModelName, log.Quota, log.ChannelId)
	return fmt.Sprintf("%x", sha256.Sum256([]byte(raw)))
}

func SaveStreamCompensation(ctx context.Context, record *StreamCompensation) error {
	return DB.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(record).Error
}

// CreditStreamCompensation serializes the wallet update with a conditional ledger
// transition. Retrying after a crash, duplicate scan, or concurrent approval is safe.
func CreditStreamCompensation(ctx context.Context, id int64, reviewer int, approve bool) error {
	var userID, creditedQuota int
	credited := false
	err := DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var record StreamCompensation
		if err := lockForUpdate(tx).First(&record, id).Error; err != nil {
			return err
		}
		if record.Status == "credited" || record.Status == "skipped" || record.Status == "rejected" {
			return nil
		}
		if record.Status == "review" && reviewer == 0 {
			return nil
		}
		if reviewer > 0 && record.Status != "review" {
			return errors.New("only pending reviews can be approved or rejected")
		}
		if reviewer > 0 && record.Status == "review" && !approve {
			return tx.Model(&record).Updates(map[string]any{"status": "rejected", "reviewed_by": reviewer}).Error
		}
		// An administrator may review a row days after the initial scan. Check
		// again for an independently recorded refund before committing a credit.
		if record.RequestID != "" {
			var refunded int64
			logStore := LOG_DB
			if LOG_DB == DB {
				logStore = tx
			}
			if err := logStore.WithContext(ctx).Model(&Log{}).Where("user_id = ? AND request_id = ? AND type = ? AND quota > 0", record.UserID, record.RequestID, LogTypeRefund).Count(&refunded).Error; err != nil {
				return err
			}
			if refunded > 0 {
				return tx.Model(&record).Updates(map[string]any{"status": "skipped", "note": "already_refunded", "reviewed_by": reviewer}).Error
			}
		}
		userID = record.UserID
		var user User
		if err := lockForUpdate(tx).Select("id", "quota", "enterprise_frozen_quota").First(&user, record.UserID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return tx.Model(&record).Updates(map[string]any{"status": "skipped", "note": "account_deleted"}).Error
			}
			return err
		}
		if record.Quota <= 0 || common.ValidateWalletQuota(record.Quota) != nil {
			return errors.New("invalid compensation quota")
		}
		result := tx.Model(&User{}).Where("id = ? AND quota + enterprise_frozen_quota <= ?", user.Id, common.MaxWalletQuota-record.Quota).Update("quota", gorm.Expr("quota + ?", record.Quota))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrWalletQuotaLimitExceeded
		}
		now := time.Now().Unix()
		if err := tx.Model(&record).Updates(map[string]any{"status": "credited", "credited_at": now, "reviewed_by": reviewer, "note": ""}).Error; err != nil {
			return err
		}
		var batch StreamCompensationBatch
		if err := tx.First(&batch, record.BatchID).Error; err != nil {
			return err
		}
		message := StreamCompensationMessage{BatchID: record.BatchID, UserID: record.UserID, StartAt: batch.StartAt, EndAt: batch.EndAt, CreatedAt: now}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&message).Error; err != nil {
			return err
		}
		if err := tx.Model(&StreamCompensationMessage{}).Where("batch_id = ? AND user_id = ?", record.BatchID, record.UserID).Updates(map[string]any{"quota": gorm.Expr("quota + ?", record.Quota), "count": gorm.Expr("count + 1"), "read_at": 0, "revision": gorm.Expr("revision + 1")}).Error; err != nil {
			return err
		}
		credited = true
		creditedQuota = record.Quota
		return nil
	})
	if credited && err == nil {
		// Preserve in-flight preconsumption deltas using the same cache credit
		// path as top-ups. Cache failure never replays the committed DB credit.
		syncCreditUserQuotaCache(userID, creditedQuota, "stream compensation")
	}
	return err
}

func NewStreamCompensationBatch(ctx context.Context, cutoff int64) (*StreamCompensationBatch, error) {
	cfg, err := GetStreamCompensationConfig()
	if err != nil || !cfg.Enabled || cfg.SettledUntil >= cutoff {
		return nil, err
	}
	var batch StreamCompensationBatch
	result := DB.WithContext(ctx).Where("status <> ?", "completed").Order("id").Limit(1).Find(&batch)
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected > 0 {
		return &batch, nil
	}
	// First run covers the complete catch-up period in one notification. After
	// that, missed daily settlements are recovered one day at a time.
	end := cutoff
	if cfg.SettledUntil > CompensationStart() {
		end = min(cutoff, cfg.SettledUntil+86400)
	}
	batch = StreamCompensationBatch{StartAt: cfg.SettledUntil, EndAt: end, Status: "running", CursorTime: cfg.SettledUntil, CreatedAt: time.Now().Unix()}
	if err := DB.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&batch).Error; err != nil {
		return nil, err
	}
	err = DB.WithContext(ctx).Where("end_at = ?", end).First(&batch).Error
	return &batch, err
}

func FinishStreamCompensationBatch(ctx context.Context, batch *StreamCompensationBatch) error {
	return DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(batch).Updates(map[string]any{"status": "completed", "completed_at": time.Now().Unix(), "error": ""}).Error; err != nil {
			return err
		}
		return tx.Model(&StreamCompensationConfig{}).Where("id = 1 AND settled_until < ?", batch.EndAt).Update("settled_until", batch.EndAt).Error
	})
}

type CompensationTotals struct {
	OriginalQuota int64 `json:"original_quota"`
	CreditedQuota int64 `json:"credited_quota"`
	NetQuota      int64 `json:"net_quota"`
}

func ListStreamCompensations(userID int, status string, batchID int64, startAt, endAt int64, offset, limit int) ([]StreamCompensation, int64, CompensationTotals, error) {
	query := DB.Model(&StreamCompensation{})
	if userID > 0 {
		query = query.Where("user_id = ?", userID)
	}
	if status == "unsettled" {
		query = query.Where("status <> ?", "credited")
	} else if status != "" {
		query = query.Where("status = ?", status)
	}
	if batchID > 0 {
		query = query.Where("batch_id = ?", batchID)
	}
	if startAt > 0 {
		query = query.Where("consumed_at >= ?", startAt)
	}
	if endAt > 0 {
		query = query.Where("consumed_at < ?", endAt)
	}
	var count int64
	var totals CompensationTotals
	items := []StreamCompensation{}
	if err := query.Count(&count).Error; err != nil {
		return nil, 0, totals, err
	}
	if err := query.Select("COALESCE(SUM(original_quota), 0) AS original_quota, COALESCE(SUM(CASE WHEN status = 'credited' THEN quota ELSE 0 END), 0) AS credited_quota").Scan(&totals).Error; err != nil {
		return nil, 0, totals, err
	}
	totals.NetQuota = totals.OriginalQuota - totals.CreditedQuota
	err := query.Select("*").Order("consumed_at DESC, id DESC").Offset(offset).Limit(limit).Find(&items).Error
	return items, count, totals, err
}

func ListStreamCompensationMessages(userID int, unread bool, offset, limit int) ([]StreamCompensationMessage, int64, error) {
	q := DB.Model(&StreamCompensationMessage{}).Where("user_id = ? AND batch_id IN (?)", userID, DB.Model(&StreamCompensationBatch{}).Select("id").Where("status = ?", "completed"))
	if unread {
		q = q.Where("read_at = 0")
	}
	items := []StreamCompensationMessage{}
	var count int64
	if err := q.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	err := q.Order("id DESC").Offset(offset).Limit(limit).Find(&items).Error
	return items, count, err
}

func MarkStreamCompensationMessageRead(userID int, id, revision int64) error {
	result := DB.Model(&StreamCompensationMessage{}).Where("id = ? AND user_id = ? AND revision = ? AND read_at = 0", id, userID, revision).Update("read_at", time.Now().Unix())
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		// Repeated acknowledgements of the same revision are idempotent,
		// including MySQL's unchanged-row semantics and concurrent devices.
		var count int64
		if err := DB.Model(&StreamCompensationMessage{}).Where("id = ? AND user_id = ? AND revision = ? AND read_at > 0", id, userID, revision).Count(&count).Error; err != nil {
			return err
		}
		if count != 1 {
			return errors.New("notification changed or not found; refresh and retry")
		}
	}
	return nil
}

func AttachStreamCompensations(logs []*Log) error {
	keys := make([]string, 0, len(logs))
	for _, log := range logs {
		if log.Type == LogTypeConsume {
			keys = append(keys, CompensationSourceKey(log))
		}
	}
	if len(keys) == 0 {
		return nil
	}
	var records []StreamCompensation
	if err := DB.Where("source_key IN ? AND status = ?", keys, "credited").Find(&records).Error; err != nil {
		return err
	}
	byKey := map[string]StreamCompensation{}
	for _, r := range records {
		byKey[r.SourceKey] = r
	}
	for _, log := range logs {
		if r, ok := byKey[CompensationSourceKey(log)]; ok && log.Type == LogTypeConsume {
			log.Compensation = &r
		}
	}
	return nil
}
