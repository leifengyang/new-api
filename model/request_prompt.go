package model

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

const RequestPromptCaptureKey = "RequestPromptCaptureEnabled"
const RequestPromptRetention = 7 * 24 * time.Hour

// RequestPrompt deliberately lives in the primary database, separate from all
// log projections (including external ClickHouse logs), for database-only
// investigation. No response or request headers are stored here.
type RequestPrompt struct {
	RequestID   string `json:"-" gorm:"primaryKey;type:varchar(64)"`
	CreatedAt   int64  `json:"created_at" gorm:"not null;index"`
	Text        string `json:"text" gorm:"size:131072"`
	Attachments string `json:"attachments" gorm:"type:varchar(64)"`
	Status      string `json:"status" gorm:"type:varchar(32)"`
	Truncated   bool   `json:"truncated"`
}

func RequestPromptCaptureEnabled() bool {
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	return common.OptionMap[RequestPromptCaptureKey] != "false"
}

func SaveRequestPrompt(prompt *RequestPrompt) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// SQL errors must never print user text, even with debug SQL logging enabled.
	return DB.WithContext(ctx).Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)}).
		Clauses(clause.OnConflict{DoNothing: true}).Create(prompt).Error
}

// Some requests are rejected before the ordinary relay error logger runs.
// Give those requests a zero-charge error row without duplicating existing
// consume/error rows or retaining the response body.
func RecordUnloggedPromptRejection(log *Log) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	db := LOG_DB.WithContext(ctx)
	var count int64
	if err := db.Model(&Log{}).Where("request_id = ?", log.RequestId).Count(&count).Error; err != nil {
		return err
	}
	if count != 0 {
		return nil
	}
	return db.Create(log).Error
}

func GetRequestPrompt(requestID string, now int64) (*RequestPrompt, error) {
	var prompt RequestPrompt
	err := DB.Where("request_id = ? AND created_at > ?", requestID, now-int64(RequestPromptRetention/time.Second)).First(&prompt).Error
	return &prompt, err
}

func PruneRequestPrompts(now int64) error {
	// Bound each deletion to avoid a large transaction after downtime. Repeated
	// passes drain the backlog.
	var ids []string
	if err := DB.Model(&RequestPrompt{}).Where("created_at <= ?", now-int64(RequestPromptRetention/time.Second)).
		Order("created_at").Limit(1000).Pluck("request_id", &ids).Error; err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	return DB.Where("request_id IN ?", ids).Delete(&RequestPrompt{}).Error
}
