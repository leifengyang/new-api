package model

import (
	"errors"
	"strconv"
	"time"

	"gorm.io/gorm"
)

// Self tests are private diagnostics, never gateway billing records.
type SelfTestProfile struct {
	ID          int      `json:"id"`
	UserID      int      `json:"-" gorm:"index"`
	Name        string   `json:"name" gorm:"size:128"`
	BaseURL     string   `json:"base_url" gorm:"size:1024"`
	Model       string   `json:"model" gorm:"size:128"`
	Protocol    string   `json:"protocol" gorm:"size:32"`
	Effort      string   `json:"effort" gorm:"size:32"`
	RememberKey bool     `json:"remember_key"`
	Secret      LongText `json:"-"`
	HasSavedKey bool     `json:"has_saved_key" gorm:"-"`
}

type SelfTestRound struct {
	ID             int      `json:"id"`
	UserID         int      `json:"-" gorm:"index"`
	ActiveKey      *string  `json:"-" gorm:"size:64;uniqueIndex"`
	Prompt         LongText `json:"prompt"`
	Concurrency    int      `json:"concurrency"`
	TimeoutSeconds int      `json:"timeout_seconds"`
	Status         string   `json:"status" gorm:"size:16;index"`
	CreatedAt      int64    `json:"created_at"`
}

type SelfTestAttempt struct {
	ID              int      `json:"id"`
	UserID          int      `json:"-" gorm:"index"`
	RoundID         int      `json:"round_id" gorm:"index"`
	GroupIndex      int      `json:"group_index"`
	Attempt         int      `json:"attempt"`
	ProfileID       int      `json:"profile_id"`
	Name            string   `json:"name" gorm:"size:128"`
	BaseURL         string   `json:"base_url" gorm:"size:1024"`
	Model           string   `json:"model" gorm:"size:128"`
	Protocol        string   `json:"protocol" gorm:"size:32"`
	Effort          string   `json:"effort" gorm:"size:32"`
	Secret          LongText `json:"-"`
	Runner          string   `json:"-" gorm:"size:64"`
	Status          string   `json:"status" gorm:"size:16;index"`
	Output          LongText `json:"output"`
	HTML            LongText `json:"html"`
	Error           LongText `json:"error"`
	InputTokens     int      `json:"input_tokens"`
	OutputTokens    int      `json:"output_tokens"`
	ReasoningTokens int      `json:"reasoning_tokens"`
	TokensEstimated bool     `json:"tokens_estimated"`
	ElapsedMs       int64    `json:"elapsed_ms"`
	FirstTokenMs    int64    `json:"first_token_ms"`
	CreatedAt       int64    `json:"created_at"`
	StartedAt       int64    `json:"started_at"`
}

var ErrSelfTestActive = errors.New("a comparison is already active")

func SaveSelfTestProfiles(userID int, profiles []SelfTestProfile) error {
	return DB.Transaction(func(tx *gorm.DB) error { return saveSelfTestProfiles(tx, userID, profiles) })
}

func saveSelfTestProfiles(tx *gorm.DB, userID int, profiles []SelfTestProfile) error {
	var user User
	if err := lockForUpdate(tx).Select("id").First(&user, userID).Error; err != nil {
		return err
	}
	if err := tx.Where("user_id = ?", userID).Delete(&SelfTestProfile{}).Error; err != nil {
		return err
	}
	for i := range profiles {
		profiles[i].ID = 0
		profiles[i].UserID = userID
		if err := tx.Create(&profiles[i]).Error; err != nil {
			return err
		}
	}
	return nil
}

func CreateSelfTestRound(round *SelfTestRound, attempts []SelfTestAttempt, profiles []SelfTestProfile) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).Select("id").First(&user, round.UserID).Error; err != nil {
			return err
		}
		var active int64
		if err := tx.Model(&SelfTestRound{}).Where("user_id = ? AND active_key IS NOT NULL", round.UserID).Count(&active).Error; err != nil {
			return err
		}
		if active > 0 {
			return ErrSelfTestActive
		}
		key := strconv.Itoa(round.UserID)
		round.ActiveKey, round.Status, round.CreatedAt = &key, "running", time.Now().Unix()
		if err := tx.Create(round).Error; err != nil {
			return err
		}
		if err := saveSelfTestProfiles(tx, round.UserID, profiles); err != nil {
			return err
		}
		for i := range attempts {
			attempts[i].UserID, attempts[i].RoundID = round.UserID, round.ID
			attempts[i].ProfileID = profiles[i].ID
			attempts[i].GroupIndex, attempts[i].Attempt = i, 1
			attempts[i].Status, attempts[i].CreatedAt = "queued", round.CreatedAt
			if err := tx.Create(&attempts[i]).Error; err != nil {
				return err
			}
		}
		var old []int
		if err := tx.Model(&SelfTestRound{}).Where("user_id = ? AND active_key IS NULL", round.UserID).Order("id desc").Offset(19).Limit(1000).Pluck("id", &old).Error; err != nil {
			return err
		}
		if len(old) == 0 {
			return nil
		}
		if err := tx.Where("round_id IN ? AND user_id = ?", old, round.UserID).Delete(&SelfTestAttempt{}).Error; err != nil {
			return err
		}
		return tx.Where("id IN ? AND user_id = ?", old, round.UserID).Delete(&SelfTestRound{}).Error
	})
}

func FinishSelfTestRound(roundID int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var round SelfTestRound
		if err := lockForUpdate(tx).First(&round, roundID).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&SelfTestAttempt{}).Where("round_id = ? AND status IN ?", roundID, []string{"queued", "running"}).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return nil
		}
		if err := tx.Model(&SelfTestAttempt{}).Where("round_id = ?", roundID).Update("secret", "").Error; err != nil {
			return err
		}
		return tx.Model(&round).Updates(map[string]any{"status": "completed", "active_key": nil}).Error
	})
}

func RetrySelfTestAttempt(userID, id int, secret LongText) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).Select("id").First(&user, userID).Error; err != nil {
			return err
		}
		var previous SelfTestAttempt
		if err := tx.Where("user_id = ?", userID).First(&previous, id).Error; err != nil {
			return err
		}
		var round SelfTestRound
		if err := lockForUpdate(tx).Where("user_id = ?", userID).First(&round, previous.RoundID).Error; err != nil {
			return err
		}
		if previous.Status != "failed" && previous.Status != "cancelled" {
			return errors.New("only failed or cancelled attempts can be retried")
		}
		var latest SelfTestAttempt
		if err := tx.Where("round_id = ? AND group_index = ?", round.ID, previous.GroupIndex).Order("id desc").First(&latest).Error; err != nil {
			return err
		}
		if latest.ID != previous.ID || previous.Attempt >= 10 {
			return errors.New("retry unavailable")
		}
		var active int64
		if err := tx.Model(&SelfTestRound{}).Where("user_id = ? AND id <> ? AND active_key IS NOT NULL", userID, round.ID).Count(&active).Error; err != nil {
			return err
		}
		if active > 0 {
			return ErrSelfTestActive
		}
		key := strconv.Itoa(userID)
		if err := tx.Model(&round).Updates(map[string]any{"status": "running", "active_key": key}).Error; err != nil {
			return err
		}
		next := SelfTestAttempt{UserID: userID, RoundID: round.ID, GroupIndex: previous.GroupIndex, Attempt: previous.Attempt + 1, ProfileID: previous.ProfileID, Name: previous.Name, BaseURL: previous.BaseURL, Model: previous.Model, Protocol: previous.Protocol, Effort: previous.Effort, Secret: secret, Status: "queued", CreatedAt: time.Now().Unix()}
		return tx.Create(&next).Error
	})
}
