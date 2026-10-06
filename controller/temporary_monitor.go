package controller

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
)

const temporaryMonitorTaskType = "temporary_upstream_monitor"

func StartTemporaryMonitor(c *gin.Context) {
	var input struct {
		selfTestGroupInput
		TextEffort    string                        `json:"text_effort"`
		DrawingEffort string                        `json:"drawing_effort"`
		TextProbe     *model.TemporaryProbeSettings `json:"text_probe"`
		DrawingProbe  *model.TemporaryProbeSettings `json:"drawing_probe"`
	}
	if !bindSelfTest(c, &input) {
		return
	}
	if input.TextProbe == nil {
		input.TextProbe = &model.TemporaryProbeSettings{Enabled: true, IntervalMinutes: 3}
	}
	if input.DrawingProbe == nil {
		input.DrawingProbe = &model.TemporaryProbeSettings{Enabled: true, IntervalMinutes: 10}
	}
	for _, settings := range []*model.TemporaryProbeSettings{input.TextProbe, input.DrawingProbe} {
		if err := settings.Validate(); err != nil {
			selfTestResponse(c, nil, err)
			return
		}
	}
	// Temporary credentials must be supplied explicitly, never borrowed from profiles.
	input.ID, input.RememberKey = 0, false
	input.Effort = input.TextEffort
	text := input.selfTestGroupInput
	input.Effort = input.DrawingEffort
	_, attempts, err := prepareSelfTestGroups(c.GetInt("id"), []selfTestGroupInput{text, input.selfTestGroupInput}, true)
	if err != nil {
		selfTestResponse(c, nil, err)
		return
	}
	now := common.GetTimestamp()
	monitor := model.TemporaryMonitor{UserID: c.GetInt("id"), Name: attempts[0].Name, BaseURL: attempts[0].BaseURL, Model: attempts[0].Model, Protocol: attempts[0].Protocol,
		TextEffort: input.TextEffort, DrawingEffort: input.DrawingEffort, MaxOutputTokens: attempts[0].MaxOutputTokens, Secret: attempts[0].Secret,
		DrawingPrompt: model.LongText(operation_setting.GetDegradationWatchPrompt()), Status: "running", CreatedAt: now, EndsAt: now + 24*60*60}
	monitor.TextDisabled, monitor.TextIntervalMinutes = !input.TextProbe.Enabled, input.TextProbe.IntervalMinutes
	monitor.DrawingDisabled, monitor.DrawingIntervalMinutes = !input.DrawingProbe.Enabled, input.DrawingProbe.IntervalMinutes
	err = model.CreateTemporaryMonitor(&monitor)
	if err == nil {
		_, _, err = service.EnqueueSystemTask(temporaryMonitorTaskType, nil)
	}
	// A dispatcher failure must not leave a paid schedule the caller thinks failed.
	if err != nil && monitor.ID > 0 {
		_ = model.StopTemporaryMonitor(monitor.ID)
	}
	selfTestResponse(c, monitor, err)
}

func ListTemporaryMonitors(c *gin.Context) {
	monitors := []model.TemporaryMonitor{}
	before, _ := strconv.Atoi(c.Query("before"))
	query := model.DB.Omit("secret", "drawing_prompt", "text_prompt", "text_expected").Order("id desc").Limit(21)
	if before > 0 {
		query = query.Where("id < ?", before)
	}
	err := query.Find(&monitors).Error
	next := 0
	if len(monitors) > 20 {
		monitors = monitors[:20]
		next = monitors[19].ID
	}
	selfTestResponse(c, gin.H{"monitors": monitors, "next_before": next}, err)
}

func GetTemporaryMonitor(c *gin.Context) {
	var monitor model.TemporaryMonitor
	if err := model.DB.Omit("secret").Where("id = ?", c.Param("id")).First(&monitor).Error; err != nil {
		c.JSON(404, gin.H{"success": false, "message": "monitor not found"})
		return
	}
	kind := c.DefaultQuery("kind", "text")
	if kind != "text" && kind != "drawing" {
		selfTestResponse(c, nil, errors.New("invalid monitor probe"))
		return
	}
	before, _ := strconv.Atoi(c.Query("before"))
	limit := 100
	if kind == "drawing" {
		limit = 5
	}
	query := model.DB.Model(&model.TemporaryMonitorAttempt{}).Where("monitor_id = ? AND kind = ?", monitor.ID, kind)
	var stats []struct {
		Verdict string `json:"verdict"`
		Status  string `json:"status"`
		Count   int64  `json:"count"`
	}
	if err := query.Select("verdict, status, COUNT(*) AS count").Group("verdict, status").Scan(&stats).Error; err != nil {
		selfTestResponse(c, nil, err)
		return
	}
	query = model.DB.Where("monitor_id = ? AND kind = ?", monitor.ID, kind)
	if before > 0 {
		query = query.Where("id < ?", before)
	}
	attempts := []model.TemporaryMonitorAttempt{}
	err := query.Omit("secret", "output", "html", "prompt", "original_prompt", "expected", "rewrite_prompt", "rewrite_result").Order("id desc").Limit(limit + 1).Find(&attempts).Error
	next := 0
	if len(attempts) > limit {
		attempts = attempts[:limit]
		next = attempts[limit-1].ID
	}
	textPrompt, expected := monitor.ProbePrompt("text")
	monitor.TextPrompt, monitor.TextExpected = textPrompt, expected
	selfTestResponse(c, gin.H{"monitor": monitor, "attempts": attempts, "stats": stats, "next_before": next, "text_prompt": textPrompt, "expected": expected}, err)
}

func GetTemporaryMonitorAttempt(c *gin.Context) {
	var attempt model.TemporaryMonitorAttempt
	err := model.DB.Omit("secret").Where("id = ?", c.Param("id")).First(&attempt).Error
	if err != nil {
		selfTestResponse(c, nil, err)
		return
	}
	if !attempt.PromptCaptured {
		var monitor model.TemporaryMonitor
		if err = model.DB.Omit("secret").First(&monitor, attempt.MonitorID).Error; err != nil {
			selfTestResponse(c, nil, err)
			return
		}
		// An edit freezes legacy inputs before replacing the monitor template.
		// Re-read after the template to avoid mixing pre-edit and post-edit data.
		if err = model.DB.Omit("secret").First(&attempt, attempt.ID).Error; err != nil {
			selfTestResponse(c, nil, err)
			return
		}
		if !attempt.PromptCaptured {
			attempt.Prompt, attempt.Expected = monitor.ProbePrompt(attempt.Kind)
			attempt.OriginalPrompt = attempt.Prompt
		}
	}
	var preparation *model.SelfTestAttempt
	if attempt.RewriteResult != "" {
		err = common.UnmarshalJsonStr(string(attempt.RewriteResult), &preparation)
	}
	selfTestResponse(c, struct {
		model.TemporaryMonitorAttempt
		Preparation *model.SelfTestAttempt `json:"preparation,omitempty"`
	}{attempt, preparation}, err)
}

func UpdateTemporaryMonitorPrompt(c *gin.Context) {
	var input struct {
		Prompt   string `json:"prompt"`
		Expected string `json:"expected"`
	}
	if !bindSelfTest(c, &input) {
		return
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err == nil {
		err = model.UpdateTemporaryMonitorPrompt(id, c.Param("kind"), input.Prompt, input.Expected, common.GetTimestamp())
	}
	selfTestResponse(c, nil, err)
}

func StopTemporaryMonitor(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err == nil {
		err = model.StopTemporaryMonitor(id)
	}
	selfTestResponse(c, nil, err)
}

func UpdateTemporaryMonitorProbe(c *gin.Context) {
	var settings model.TemporaryProbeSettings
	if !bindSelfTest(c, &settings) {
		return
	}
	id, err := strconv.Atoi(c.Param("id"))
	if err == nil {
		err = model.UpdateTemporaryMonitorProbe(id, c.Param("kind"), settings, common.GetTimestamp())
	}
	selfTestResponse(c, nil, err)
}

func RunTemporaryMonitorProbe(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		selfTestResponse(c, nil, err)
		return
	}
	attempt, err := model.QueueTemporaryMonitorProbe(id, c.Param("kind"), common.GetTimestamp())
	if err == nil {
		_, _, err = service.EnqueueSystemTask(temporaryMonitorTaskType, nil)
		if err != nil {
			model.DB.Model(&model.TemporaryMonitorAttempt{}).Where("id = ? AND status = ?", attempt.ID, "queued").Updates(map[string]any{"status": "cancelled", "error": "Could not schedule probe"})
		}
	}
	selfTestResponse(c, attempt, err)
}

type temporaryMonitorHandler struct{}

func (temporaryMonitorHandler) Type() string { return temporaryMonitorTaskType }
func (temporaryMonitorHandler) Enabled() bool {
	var count int64
	return model.DB.Model(&model.TemporaryMonitor{}).Where("status = ? OR ends_at < ?", "running", common.GetTimestamp()-model.DegradationWatchRetentionSeconds).Count(&count).Error == nil && count > 0
}
func (temporaryMonitorHandler) Interval() time.Duration { return time.Minute }
func (temporaryMonitorHandler) NewPayload() any         { return nil }

// One leased dispatcher survives browser closes and resumes persisted schedules
// after a process restart. Text and drawing have independent concurrency slots.
func (temporaryMonitorHandler) Run(ctx context.Context, task *model.SystemTask, runner string) {
	ctx, cancel := context.WithCancel(ctx)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	done := make(chan int, 20)
	active := map[int]bool{}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var runErr error
	for {
		now := common.GetTimestamp()
		if runErr = model.MaintainTemporaryMonitors(now, task.TaskID); runErr != nil {
			break
		}
		var monitors []model.TemporaryMonitor
		if runErr = model.DB.Where("status = ? AND ends_at > ?", "running", now).Order("id").Find(&monitors).Error; runErr != nil {
			break
		}
		for _, monitor := range monitors {
			for _, kind := range []string{"text", "drawing"} {
				if len(active) >= 20 {
					break
				}
				var attempt *model.TemporaryMonitorAttempt
				attempt, runErr = model.ClaimTemporaryMonitorAttempt(monitor.ID, kind, task.TaskID, now)
				if runErr != nil {
					break
				}
				if attempt == nil {
					continue
				}
				active[attempt.ID] = true
				workers.Go(func() {
					defer func() { done <- attempt.ID }()
					runTemporaryMonitorAttempt(ctx, monitor, *attempt, task.TaskID)
				})
			}
			if runErr != nil {
				break
			}
		}
		if runErr != nil || (len(monitors) == 0 && len(active) == 0) {
			break
		}
		select {
		case <-ctx.Done():
			runErr = ctx.Err()
		case id := <-done:
			delete(active, id)
		case <-ticker.C:
		}
		if runErr != nil {
			break
		}
	}
	cancel()
	workers.Wait()
	status := model.SystemTaskStatusSucceeded
	if runErr != nil {
		status = model.SystemTaskStatusFailed
	}
	finishSystemTaskHandler(task, runner, status, nil, runErr)
}

func runTemporaryMonitorAttempt(parent context.Context, monitor model.TemporaryMonitor, attempt model.TemporaryMonitorAttempt, runner string) {
	ctx, cancel := context.WithDeadline(parent, time.Unix(monitor.EndsAt, 0))
	defer cancel()
	ctx, timeoutCancel := context.WithTimeout(ctx, 20*time.Minute)
	defer timeoutCancel()
	if !attempt.PromptCaptured {
		attempt.Prompt, attempt.Expected = monitor.ProbePrompt(attempt.Kind)
	}
	active := func(elapsed int64) bool {
		var count int64
		if err := model.DB.Model(&model.TemporaryMonitor{}).Where("id = ? AND status = ? AND ends_at > ?", monitor.ID, "running", common.GetTimestamp()).Count(&count).Error; err != nil || count == 0 {
			return false
		}
		if err := model.DB.Model(&model.TemporaryMonitorAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Count(&count).Error; err != nil || count == 0 {
			return false
		}
		return model.DB.Model(&model.TemporaryMonitorAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Update("elapsed_ms", elapsed).Error == nil
	}
	if attempt.Kind == "drawing" && attempt.Subject != "" {
		attempt.RewritePrompt = model.LongText(fmt.Sprintf("你是绘画测试提示词编辑器。不要执行绘画，不要输出 HTML 或 SVG 代码。将下面提示词中的主角（例如鹈鹕）换成「%s」，并同步修改该主角的外形特征描述。保持动作、场景、动画、技术要求和测试难度不变。只返回修改后的完整提示词，不要解释、标题或代码围栏。改写后不得残留鹈鹕。\n<原始提示词>\n%s\n</原始提示词>", attempt.Subject, attempt.OriginalPrompt))
		var preparation model.SelfTestAttempt
		var persistenceErr error
		runDiagnosticAttempt(ctx, model.SelfTestRound{Prompt: attempt.RewritePrompt, TimeoutSeconds: 1200}, attempt.SelfTestAttempt, func(result model.SelfTestAttempt, final bool) error {
			preparation = result
			encoded, err := common.Marshal(result)
			if err != nil {
				persistenceErr = err
				return err
			}
			persistenceErr = model.DB.Model(&model.TemporaryMonitorAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Updates(map[string]any{"rewrite_prompt": attempt.RewritePrompt, "rewrite_result": string(encoded)}).Error
			return persistenceErr
		}, active)
		prompt := strings.TrimSpace(string(preparation.Output))
		lowerPrompt := strings.ToLower(prompt)
		errText := string(preparation.Error)
		if persistenceErr != nil {
			errText = "Could not save rewritten prompt"
		}
		if preparation.Status == "succeeded" && persistenceErr == nil && (prompt == "" || len([]rune(prompt)) > operation_setting.MaxDegradationWatchPromptLength || !strings.Contains(lowerPrompt, strings.ToLower(attempt.Subject)) || strings.Contains(prompt, "鹈鹕") || strings.HasPrefix(lowerPrompt, "<!doctype") || strings.HasPrefix(lowerPrompt, "<html") || strings.HasPrefix(lowerPrompt, "<svg") || strings.HasPrefix(prompt, "```")) {
			errText = "The rewritten prompt is empty, too long, still contains the original subject, or does not contain the replacement subject"
		}
		if errText != "" || preparation.Status != "succeeded" {
			model.DB.Model(&model.TemporaryMonitorAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Updates(map[string]any{"status": "failed", "verdict": "error", "error": "Prompt rewrite failed: " + errText})
			return
		}
		if !active(preparation.ElapsedMs) {
			return
		}
		attempt.Prompt = model.LongText(prompt)
		if err := model.DB.Model(&model.TemporaryMonitorAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Updates(map[string]any{"prompt": attempt.Prompt, "phase": "detecting", "elapsed_ms": 0}).Error; err != nil {
			common.SysError("temporary monitor prompt persistence failed")
			model.DB.Model(&model.TemporaryMonitorAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Updates(map[string]any{"status": "failed", "verdict": "error", "error": "Could not save rewritten prompt"})
			return
		}
	}
	round := model.SelfTestRound{Prompt: attempt.Prompt, TimeoutSeconds: 1200}
	runDiagnosticAttempt(ctx, round, attempt.SelfTestAttempt, func(result model.SelfTestAttempt, final bool) error {
		updates := diagnosticAttemptUpdates(result, final)
		if final {
			verdict := "error"
			if result.Status == "succeeded" {
				record := &model.DegradationWatchRecord{}
				evaluateDegradationProbe(record, operation_setting.DegradationProbe{Kind: attempt.Kind, Expected: string(attempt.Expected), Match: "exact"}, string(result.Output))
				verdict = record.Verdict
				if !record.Success {
					updates["status"], updates["error"] = "failed", record.FailureReason
				}
			}
			updates["verdict"] = verdict
		}
		return model.DB.Model(&model.TemporaryMonitorAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Updates(updates).Error
	}, active)
}
