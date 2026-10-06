package model

import (
	"errors"

	"gorm.io/gorm"
)

// Temporary monitors never create routable channels or public wall records.
type TemporaryMonitor struct {
	ID              int      `json:"id"`
	UserID          int      `json:"-" gorm:"index"`
	Name            string   `json:"name" gorm:"size:128"`
	BaseURL         string   `json:"base_url" gorm:"size:1024"`
	Model           string   `json:"model" gorm:"size:128"`
	Protocol        string   `json:"protocol" gorm:"size:32"`
	TextEffort      string   `json:"text_effort" gorm:"size:32"`
	DrawingEffort   string   `json:"drawing_effort" gorm:"size:32"`
	MaxOutputTokens *uint    `json:"max_output_tokens"`
	Secret          LongText `json:"-"`
	DrawingPrompt   LongText `json:"drawing_prompt"`
	Status          string   `json:"status" gorm:"size:16;index"`
	CreatedAt       int64    `json:"created_at"`
	EndsAt          int64    `json:"ends_at" gorm:"index"`
}

type TemporaryMonitorAttempt struct {
	SelfTestAttempt `gorm:"embedded"`
	MonitorID       int    `json:"monitor_id" gorm:"uniqueIndex:idx_temp_monitor_slot;index"`
	Kind            string `json:"kind" gorm:"size:16;uniqueIndex:idx_temp_monitor_slot"`
	Slot            int64  `json:"slot" gorm:"uniqueIndex:idx_temp_monitor_slot"`
	Verdict         string `json:"verdict" gorm:"size:16"`
}

func CreateTemporaryMonitor(monitor *TemporaryMonitor) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).First(&user, monitor.UserID).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&TemporaryMonitor{}).Where("user_id = ? AND status = ? AND ends_at > ?", monitor.UserID, "running", monitor.CreatedAt).Count(&count).Error; err != nil {
			return err
		}
		if count >= 10 {
			return errors.New("at most 10 temporary monitors may run per administrator")
		}
		return tx.Create(monitor).Error
	})
}

func StopTemporaryMonitor(id int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var monitor TemporaryMonitor
		if err := lockForUpdate(tx).First(&monitor, id).Error; err != nil {
			return err
		}
		if err := tx.Model(&monitor).Where("status = ?", "running").Updates(map[string]any{"status": "stopped", "secret": ""}).Error; err != nil {
			return err
		}
		return tx.Model(&TemporaryMonitorAttempt{}).Where("monitor_id = ? AND status IN ?", id, []string{"queued", "running"}).Updates(map[string]any{"status": "cancelled", "error": "Stopped by administrator", "secret": ""}).Error
	})
}

// Claim is protected by the session row lock and a per-kind slot uniqueness
// constraint. Missed slots are skipped; a slow request never overlaps itself.
func ClaimTemporaryMonitorAttempt(id int, kind, runner string, now int64) (*TemporaryMonitorAttempt, error) {
	var claimed *TemporaryMonitorAttempt
	err := DB.Transaction(func(tx *gorm.DB) error {
		var monitor TemporaryMonitor
		if err := lockForUpdate(tx).First(&monitor, id).Error; err != nil {
			return err
		}
		if monitor.Status != "running" || now >= monitor.EndsAt || now < monitor.CreatedAt {
			return nil
		}
		seconds, effort := int64(180), monitor.TextEffort
		if kind == "drawing" {
			seconds, effort = 600, monitor.DrawingEffort
		} else if kind != "text" {
			return errors.New("invalid monitor probe")
		}
		slot := (now - monitor.CreatedAt) / seconds
		var count int64
		if err := tx.Model(&TemporaryMonitorAttempt{}).Where("monitor_id = ? AND kind = ? AND (slot = ? OR status IN ?)", id, kind, slot, []string{"queued", "running"}).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return nil
		}
		attempt := &TemporaryMonitorAttempt{MonitorID: id, Kind: kind, Slot: slot, SelfTestAttempt: SelfTestAttempt{
			UserID: monitor.UserID, Name: monitor.Name, BaseURL: monitor.BaseURL, Model: monitor.Model, Protocol: monitor.Protocol, Effort: effort, MaxOutputTokens: monitor.MaxOutputTokens,
			Status: "running", Runner: runner, CreatedAt: now, StartedAt: now * 1000, TokensEstimated: true,
		}}
		if err := tx.Create(attempt).Error; err != nil {
			return err
		}
		// Only the session stores the encrypted key. Worker copies stay in memory.
		attempt.Secret = monitor.Secret
		claimed = attempt
		return nil
	})
	return claimed, err
}

func MaintainTemporaryMonitors(now int64, runner string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&TemporaryMonitor{}).Where("status = ? AND ends_at <= ?", "running", now).Updates(map[string]any{"status": "completed", "secret": ""}).Error; err != nil {
			return err
		}
		inactive := tx.Model(&TemporaryMonitor{}).Select("id").Where("status <> ?", "running")
		if err := tx.Model(&TemporaryMonitorAttempt{}).Where("status IN ? AND monitor_id IN (?)", []string{"running", "queued"}, inactive).Updates(map[string]any{"status": "cancelled", "error": "Monitoring ended", "secret": ""}).Error; err != nil {
			return err
		}
		if err := tx.Model(&TemporaryMonitorAttempt{}).Where("status = ? AND runner <> ?", "running", runner).Updates(map[string]any{"status": "failed", "verdict": "error", "error": "Worker interrupted", "secret": ""}).Error; err != nil {
			return err
		}
		var old []int
		if err := tx.Model(&TemporaryMonitor{}).Where("ends_at < ? AND status <> ?", now-DegradationWatchRetentionSeconds, "running").Order("id").Limit(50).Pluck("id", &old).Error; err != nil {
			return err
		}
		if len(old) == 0 {
			return nil
		}
		if err := tx.Where("monitor_id IN ?", old).Delete(&TemporaryMonitorAttempt{}).Error; err != nil {
			return err
		}
		return tx.Where("id IN ?", old).Delete(&TemporaryMonitor{}).Error
	})
}
