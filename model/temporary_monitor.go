package model

import (
	"errors"
	"math/rand/v2"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"gorm.io/gorm"
)

// Keep the entire connection envelope out of the generic options response.
const TemporaryMonitorRewriterOption = "TemporaryMonitorRewriterSecret"

type temporaryMonitorRewriterEnvelope struct {
	Profile SelfTestProfile `json:"profile"`
	UserID  int             `json:"owner_id"`
	Secret  LongText        `json:"secret"`
}

func GetTemporaryMonitorRewriter() (SelfTestProfile, error) {
	var option Option
	err := DB.Where(&Option{Key: TemporaryMonitorRewriterOption}).First(&option).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return SelfTestProfile{}, nil
	}
	if err != nil {
		return SelfTestProfile{}, err
	}
	var saved temporaryMonitorRewriterEnvelope
	if err := common.UnmarshalJsonStr(option.Value, &saved); err != nil {
		return SelfTestProfile{}, err
	}
	saved.Profile.UserID, saved.Profile.Secret = saved.UserID, saved.Secret
	saved.Profile.HasSavedKey = saved.Secret != ""
	return saved.Profile, nil
}

func SaveTemporaryMonitorRewriter(profile SelfTestProfile) error {
	encoded, err := common.Marshal(temporaryMonitorRewriterEnvelope{Profile: profile, UserID: profile.UserID, Secret: profile.Secret})
	if err != nil {
		return err
	}
	return DB.Save(&Option{Key: TemporaryMonitorRewriterOption, Value: string(encoded)}).Error
}

// Temporary monitors never create routable channels or public wall records.
type TemporaryMonitor struct {
	ID                       int      `json:"id"`
	UserID                   int      `json:"-" gorm:"index"`
	Name                     string   `json:"name" gorm:"size:128"`
	BaseURL                  string   `json:"base_url" gorm:"size:1024"`
	Model                    string   `json:"model" gorm:"size:128"`
	Protocol                 string   `json:"protocol" gorm:"size:32"`
	TextEffort               string   `json:"text_effort" gorm:"size:32"`
	DrawingEffort            string   `json:"drawing_effort" gorm:"size:32"`
	MaxOutputTokens          *uint    `json:"max_output_tokens"`
	Secret                   LongText `json:"-"`
	DrawingPrompt            LongText `json:"drawing_prompt"`
	Status                   string   `json:"status" gorm:"size:16;index"`
	CreatedAt                int64    `json:"created_at"`
	EndsAt                   int64    `json:"ends_at" gorm:"index"`
	TextDisabled             bool     `json:"text_disabled"`
	DrawingDisabled          bool     `json:"drawing_disabled"`
	TextIntervalMinutes      int      `json:"text_interval_minutes"`
	DrawingIntervalMinutes   int      `json:"drawing_interval_minutes"`
	TextPrompt               LongText `json:"text_prompt"`
	TextExpected             LongText `json:"text_expected"`
	TextIntermediateExpected *string  `json:"text_intermediate_expected" gorm:"type:text"`
}

func (monitor TemporaryMonitor) IntermediateAnswer() string {
	_, expected := monitor.ProbePrompt("text")
	return (operation_setting.DegradationProbe{Expected: string(expected), IntermediateExpected: monitor.TextIntermediateExpected}).IntermediateAnswer()
}

func (monitor TemporaryMonitor) ProbePrompt(kind string) (LongText, LongText) {
	if kind == "drawing" {
		return monitor.DrawingPrompt, ""
	}
	prompt, expected := monitor.TextPrompt, monitor.TextExpected
	if prompt == "" {
		prompt = LongText(operation_setting.SanaeProbePrompt)
	}
	if expected == "" {
		expected = "高市早苗"
	}
	return prompt, expected
}

func UpdateTemporaryMonitorPrompt(id int, kind, prompt, expected string, intermediate *string, now int64) error {
	prompt, expected = strings.TrimSpace(prompt), strings.TrimSpace(expected)
	if (kind != "text" && kind != "drawing") || prompt == "" || len([]rune(prompt)) > operation_setting.MaxDegradationWatchPromptLength {
		return errors.New("invalid probe prompt")
	}
	if kind == "text" && (expected == "" || len([]rune(expected)) > 2000) {
		return errors.New("expected answer must contain 1 to 2000 characters")
	}
	if kind == "text" && intermediate != nil && (len([]rune(*intermediate)) > 2000 || strings.TrimSpace(*intermediate) == expected) {
		return errors.New("blue answer must differ from the green answer and contain at most 2000 characters")
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var monitor TemporaryMonitor
		if err := lockForUpdate(tx).First(&monitor, id).Error; err != nil {
			return err
		}
		if monitor.Status != "running" || now >= monitor.EndsAt {
			return errors.New("monitoring has ended")
		}
		if kind == "text" {
			configured := monitor.TextIntermediateExpected
			if intermediate != nil {
				configured = intermediate
			}
			if (operation_setting.DegradationProbe{Expected: expected, IntermediateExpected: configured}).IntermediateAnswer() == expected {
				return errors.New("blue answer must differ from the green answer")
			}
		}
		// Older releases used the current monitor prompt and did not store snapshots.
		// Freeze those historical inputs before the first edit changes their source.
		oldPrompt, oldExpected := monitor.ProbePrompt(kind)
		if err := tx.Model(&TemporaryMonitorAttempt{}).Where("monitor_id = ? AND kind = ? AND (prompt_captured = ? OR prompt_captured IS NULL)", id, kind, false).Updates(map[string]any{"prompt": oldPrompt, "original_prompt": oldPrompt, "expected": oldExpected, "prompt_captured": true}).Error; err != nil {
			return err
		}
		updates := map[string]any{kind + "_prompt": prompt}
		if kind == "text" {
			updates["text_expected"] = expected
			if intermediate != nil {
				updates["text_intermediate_expected"] = strings.TrimSpace(*intermediate)
			}
		}
		return tx.Model(&monitor).Updates(updates).Error
	})
}

type TemporaryProbeSettings struct {
	Enabled         bool `json:"enabled"`
	IntervalMinutes int  `json:"interval_minutes"`
}

func (monitor TemporaryMonitor) ProbeSettings(kind string) (TemporaryProbeSettings, error) {
	settings := TemporaryProbeSettings{}
	switch kind {
	case "text":
		settings.Enabled, settings.IntervalMinutes = !monitor.TextDisabled, monitor.TextIntervalMinutes
		if settings.IntervalMinutes == 0 {
			settings.IntervalMinutes = 3
		}
	case "drawing":
		settings.Enabled, settings.IntervalMinutes = !monitor.DrawingDisabled, monitor.DrawingIntervalMinutes
		if settings.IntervalMinutes == 0 {
			settings.IntervalMinutes = 10
		}
	default:
		return settings, errors.New("invalid monitor probe")
	}
	return settings, nil
}

func (settings TemporaryProbeSettings) Validate() error {
	if settings.IntervalMinutes < 1 || settings.IntervalMinutes > 1440 {
		return errors.New("probe interval must be between 1 and 1440 minutes")
	}
	return nil
}

func UpdateTemporaryMonitorProbe(id int, kind string, settings TemporaryProbeSettings, now int64) error {
	if err := settings.Validate(); err != nil {
		return err
	}
	if kind != "text" && kind != "drawing" {
		return errors.New("invalid monitor probe")
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var monitor TemporaryMonitor
		if err := lockForUpdate(tx).First(&monitor, id).Error; err != nil {
			return err
		}
		if monitor.Status != "running" || now >= monitor.EndsAt {
			return errors.New("monitoring has ended")
		}
		return tx.Model(&monitor).Updates(map[string]any{kind + "_disabled": !settings.Enabled, kind + "_interval_minutes": settings.IntervalMinutes}).Error
	})
}

func (monitor TemporaryMonitor) NewProbeAttempt(kind string, now int64) TemporaryMonitorAttempt {
	effort := monitor.TextEffort
	if kind == "drawing" {
		effort = monitor.DrawingEffort
	}
	return TemporaryMonitorAttempt{MonitorID: monitor.ID, Kind: kind, SelfTestAttempt: SelfTestAttempt{
		UserID: monitor.UserID, Name: monitor.Name, BaseURL: monitor.BaseURL, Model: monitor.Model, Protocol: monitor.Protocol, Effort: effort, MaxOutputTokens: monitor.MaxOutputTokens,
		CreatedAt: now, TokensEstimated: true,
	}}
}

// Manual requests occupy negative slots, so they never consume a scheduled run.
// The monitor lock deduplicates double clicks and excludes an in-flight probe.
func QueueTemporaryMonitorProbe(id int, kind string, now int64) (*TemporaryMonitorAttempt, error) {
	var attempt TemporaryMonitorAttempt
	err := DB.Transaction(func(tx *gorm.DB) error {
		var monitor TemporaryMonitor
		if err := lockForUpdate(tx).First(&monitor, id).Error; err != nil {
			return err
		}
		if _, err := monitor.ProbeSettings(kind); err != nil {
			return err
		}
		if monitor.Status != "running" || now >= monitor.EndsAt || monitor.Secret == "" {
			return errors.New("monitoring has ended")
		}
		err := tx.Where("monitor_id = ? AND kind = ? AND status IN ?", id, kind, []string{"queued", "running"}).First(&attempt).Error
		if err == nil {
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var previous TemporaryMonitorAttempt
		err = tx.Where("monitor_id = ? AND kind = ? AND slot < 0", id, kind).Order("slot").First(&previous).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		attempt = monitor.NewProbeAttempt(kind, now)
		attempt.Slot, attempt.Status = previous.Slot-1, "queued"
		return tx.Create(&attempt).Error
	})
	return &attempt, err
}

type TemporaryMonitorAttempt struct {
	SelfTestAttempt      `gorm:"embedded"`
	MonitorID            int      `json:"monitor_id" gorm:"uniqueIndex:idx_temp_monitor_slot;index"`
	Kind                 string   `json:"kind" gorm:"size:16;uniqueIndex:idx_temp_monitor_slot"`
	Slot                 int64    `json:"slot" gorm:"uniqueIndex:idx_temp_monitor_slot"`
	Verdict              string   `json:"verdict" gorm:"size:16"`
	Prompt               LongText `json:"prompt"`
	OriginalPrompt       LongText `json:"original_prompt"`
	Expected             LongText `json:"expected"`
	IntermediateExpected LongText `json:"intermediate_expected"`
	PromptCaptured       bool     `json:"prompt_captured"`
	Phase                string   `json:"phase" gorm:"size:16"`
	Subject              string   `json:"subject" gorm:"size:64"`
	RewritePrompt        LongText `json:"rewrite_prompt"`
	RewriteResult        LongText `json:"-"`
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

// The original connection is checked under the lock so a concurrent stop or
// credential edit cannot restore a cleared key or overwrite a newer destination.
func UpdateTemporaryMonitor(original TemporaryMonitor, updated *TemporaryMonitor, restart bool, now int64) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if restart {
			var user User
			if err := lockForUpdate(tx).First(&user, original.UserID).Error; err != nil {
				return err
			}
		}
		var current TemporaryMonitor
		if err := lockForUpdate(tx).First(&current, original.ID).Error; err != nil {
			return err
		}
		if current.Secret != original.Secret || current.BaseURL != original.BaseURL || current.Protocol != original.Protocol || current.Status != original.Status || current.EndsAt != original.EndsAt {
			return errors.New("monitor changed; reload its configuration and try again")
		}
		active := current.Status == "running" && current.EndsAt > now
		if restart {
			if active {
				return errors.New("stop the monitor before restarting")
			}
			if updated.Secret == "" {
				return errors.New("enter an API key to restart monitoring")
			}
			var count int64
			if err := tx.Model(&TemporaryMonitor{}).Where("user_id = ? AND status = ? AND ends_at > ?", current.UserID, "running", now).Count(&count).Error; err != nil {
				return err
			}
			if count >= 10 {
				return errors.New("at most 10 temporary monitors may run per administrator")
			}
			if err := tx.Model(&TemporaryMonitorAttempt{}).Where("monitor_id = ? AND status IN ?", current.ID, []string{"queued", "running"}).Updates(map[string]any{"status": "cancelled", "error": "Previous monitoring session ended", "secret": ""}).Error; err != nil {
				return err
			}
			updated.Status, updated.CreatedAt, updated.EndsAt = "running", now, now+86400
		} else {
			updated.Status, updated.CreatedAt, updated.EndsAt = current.Status, current.CreatedAt, current.EndsAt
			if !active {
				updated.Secret = ""
				if updated.Status == "running" {
					updated.Status = "completed"
				}
			}
		}
		for _, kind := range []string{"text", "drawing"} {
			prompt, expected := current.ProbePrompt(kind)
			if err := tx.Model(&TemporaryMonitorAttempt{}).Where("monitor_id = ? AND kind = ? AND (prompt_captured = ? OR prompt_captured IS NULL)", current.ID, kind, false).Updates(map[string]any{"prompt": prompt, "original_prompt": prompt, "expected": expected, "prompt_captured": true}).Error; err != nil {
				return err
			}
		}
		updated.ID, updated.UserID = current.ID, current.UserID
		if updated.TextIntermediateExpected == nil {
			updated.TextIntermediateExpected = current.TextIntermediateExpected
		}
		_, expected := updated.ProbePrompt("text")
		if updated.IntermediateAnswer() == strings.TrimSpace(string(expected)) {
			return errors.New("blue answer must differ from the green answer")
		}
		if err := tx.Model(&current).Select("name", "base_url", "model", "protocol", "text_effort", "drawing_effort", "max_output_tokens", "secret", "text_disabled", "drawing_disabled", "text_interval_minutes", "drawing_interval_minutes", "text_prompt", "text_expected", "text_intermediate_expected", "drawing_prompt", "status", "created_at", "ends_at").Updates(updated).Error; err != nil {
			return err
		}
		if restart {
			for _, kind := range []string{"text", "drawing"} {
				settings, _ := updated.ProbeSettings(kind)
				if !settings.Enabled {
					continue
				}
				var previous TemporaryMonitorAttempt
				err := tx.Where("monitor_id = ? AND kind = ? AND slot >= 0", current.ID, kind).Order("slot desc").First(&previous).Error
				if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
				attempt := updated.NewProbeAttempt(kind, now)
				attempt.Slot, attempt.Status = max(now, previous.Slot+1), "queued"
				if err := tx.Create(&attempt).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func DeleteTemporaryMonitor(id int) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var monitor TemporaryMonitor
		if err := lockForUpdate(tx).First(&monitor, id).Error; err != nil {
			return err
		}
		if err := tx.Where("monitor_id = ?", id).Delete(&TemporaryMonitorAttempt{}).Error; err != nil {
			return err
		}
		return tx.Delete(&monitor).Error
	})
}

// Claim prioritizes one-shot requests, even when automatic checks are disabled.
// Scheduled runs use the latest scheduled start, so changing an interval cannot
// collide with a previous slot. Missed runs are skipped, never replayed in bulk.
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
		settings, err := monitor.ProbeSettings(kind)
		if err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&TemporaryMonitorAttempt{}).Where("monitor_id = ? AND kind = ? AND status = ?", id, kind, "running").Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return nil
		}
		attempt := monitor.NewProbeAttempt(kind, now)
		err = tx.Where("monitor_id = ? AND kind = ? AND status = ?", id, kind, "queued").Order("id").First(&attempt).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if !settings.Enabled {
				return nil
			}
			var previous TemporaryMonitorAttempt
			err = tx.Where("monitor_id = ? AND kind = ? AND slot >= 0", id, kind).Order("created_at desc, id desc").First(&previous).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			if err == nil && now < previous.CreatedAt+int64(settings.IntervalMinutes)*60 {
				return nil
			}
			attempt.Slot = now
			attempt.Status, attempt.Runner, attempt.StartedAt = "running", runner, now*1000
			if err := tx.Create(&attempt).Error; err != nil {
				return err
			}
		} else {
			// A queued request starts with the latest configuration; an already
			// running request keeps the snapshot it originally claimed.
			fresh := monitor.NewProbeAttempt(kind, now)
			attempt.Name, attempt.BaseURL, attempt.Model, attempt.Protocol = fresh.Name, fresh.BaseURL, fresh.Model, fresh.Protocol
			attempt.Effort, attempt.MaxOutputTokens = fresh.Effort, fresh.MaxOutputTokens
			attempt.Status, attempt.Runner, attempt.StartedAt = "running", runner, now*1000
			if err := tx.Model(&attempt).Updates(map[string]any{"status": attempt.Status, "runner": runner, "started_at": attempt.StartedAt, "name": attempt.Name, "base_url": attempt.BaseURL, "model": attempt.Model, "protocol": attempt.Protocol, "effort": attempt.Effort, "max_output_tokens": attempt.MaxOutputTokens}).Error; err != nil {
				return err
			}
		}
		attempt.OriginalPrompt, attempt.Expected = monitor.ProbePrompt(kind)
		if kind == "text" {
			attempt.IntermediateExpected = LongText(monitor.IntermediateAnswer())
		}
		attempt.Prompt, attempt.PromptCaptured, attempt.Phase = attempt.OriginalPrompt, true, "detecting"
		if kind == "drawing" {
			subjects := []string{"Tibo", "小恐龙", "乌龟", "企鹅", "浣熊", "水豚", "小狐狸", "机器人"}
			var previous TemporaryMonitorAttempt
			err := tx.Select("subject").Where("monitor_id = ? AND kind = ? AND id < ?", id, kind, attempt.ID).Order("id desc").First(&previous).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			choices := make([]string, 0, len(subjects))
			for _, subject := range subjects {
				if subject != previous.Subject && !strings.Contains(strings.ToLower(string(attempt.OriginalPrompt)), strings.ToLower(subject)) {
					choices = append(choices, subject)
				}
			}
			if len(choices) == 0 {
				choices = []string{"戴红帽子的机械小熊"}
			}
			attempt.Subject, attempt.Phase, attempt.Prompt = choices[rand.IntN(len(choices))], "rewriting", ""
		}
		if err := tx.Model(&attempt).Updates(map[string]any{"prompt": attempt.Prompt, "original_prompt": attempt.OriginalPrompt, "expected": attempt.Expected, "intermediate_expected": attempt.IntermediateExpected, "prompt_captured": true, "subject": attempt.Subject, "phase": attempt.Phase}).Error; err != nil {
			return err
		}
		// Only the session stores the encrypted key. Worker copies stay in memory.
		attempt.Secret = monitor.Secret
		claimed = &attempt
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
