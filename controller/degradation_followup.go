package controller

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"gorm.io/gorm"
)

// Use the target's drawing template even when its periodic switch is off.
// Targets without a drawing binding use the existing default drawing prompt.
func blueProbeDrawingRecord(plan *operation_setting.DegradationProbePlan, target operation_setting.DegradationProbeTarget, source *model.DegradationWatchRecord) *model.DegradationWatchRecord {
	for _, configured := range plan.Targets {
		if configured.Group == target.Group && configured.ChannelID == target.ChannelID && configured.Model == target.Model {
			target = configured
			break
		}
	}
	drawing := operation_setting.DegradationProbe{ID: "drawing", Name: "绘画检测", Kind: "drawing", Prompt: operation_setting.GetDegradationWatchPrompt()}
	effort := target.ReasoningEffort
	selected := false
	selectedEnabled := false
	for _, binding := range target.Probes {
		for _, probe := range plan.Probes {
			if probe.ID != binding.ProbeID || probe.Kind != "drawing" {
				continue
			}
			if !selected || binding.Enabled {
				drawing, effort, selected = probe, target.ReasoningEffort, true
				selectedEnabled = binding.Enabled
				if binding.ReasoningEffort != nil {
					effort = *binding.ReasoningEffort
				}
			}
			if binding.Enabled {
				break
			}
		}
		if selectedEnabled {
			break
		}
	}
	return &model.DegradationWatchRecord{ChannelId: source.ChannelId, GroupName: source.GroupName, ModelName: source.ModelName,
		ProbeID: drawing.ID, ProbeName: drawing.Name, ProbeKind: "drawing", PromptSnapshot: model.LongText(drawing.Prompt), ReasoningEffort: effort, TokensEstimated: true}
}

type degradationFollowupHandler struct{}

func (degradationFollowupHandler) Type() string            { return "degradation_probe_followup" }
func (degradationFollowupHandler) Interval() time.Duration { return time.Second }
func (degradationFollowupHandler) NewPayload() any         { return nil }
func (degradationFollowupHandler) Enabled() bool {
	var count int64
	return model.DB.Model(&model.DegradationWatchRecord{}).Where("trigger_record_id IS NOT NULL AND status IN ?", []string{"queued", "running"}).Count(&count).Error == nil && count > 0
}
func (degradationFollowupHandler) Run(ctx context.Context, task *model.SystemTask, runner string) {
	err := executeBlueProbeDrawings(ctx, task)
	status := model.SystemTaskStatusSucceeded
	if err != nil {
		status = model.SystemTaskStatusFailed
	}
	finishSystemTaskHandler(task, runner, status, nil, err)
}

func executeBlueProbeDrawings(ctx context.Context, task *model.SystemTask) error {
	if err := model.FailInterruptedDegradationWatchRecords(); err != nil {
		return err
	}
	plan, err := resolveDegradationProbePlan()
	if err != nil {
		return err
	}
	userID, err := resolveChannelTestUserID(nil)
	if err != nil {
		return err
	}
	for ctx.Err() == nil {
		var queued []model.DegradationWatchRecord
		if err := model.DB.Where("trigger_record_id IS NOT NULL AND status = ?", "queued").Order("id").Limit(plan.Concurrency).Find(&queued).Error; err != nil {
			return err
		}
		if len(queued) == 0 {
			return nil
		}
		var wg sync.WaitGroup
		var mu sync.Mutex
		var persistenceErr error
		for _, record := range queued {
			claimed, err := model.ClaimBlueProbeDrawing(record.Id, task.TaskID)
			if err != nil {
				mu.Lock()
				persistenceErr = err
				mu.Unlock()
				break
			}
			if !claimed {
				continue
			}
			wg.Go(func() {
				requestCtx, cancel := context.WithTimeout(ctx, time.Duration(plan.TimeoutSeconds)*time.Second)
				defer cancel()
				channel, err := model.GetChannelById(record.ChannelId, true)
				if err != nil || !isDegradationWatchCandidate(channel, record.GroupName, record.ModelName) {
					record.Verdict, record.FailureReason = "error", "upstream_error"
					record.ErrorDetails = "The source channel is no longer available for this group and model."
				} else {
					job := degradationProbeJob{channel: channel, target: operation_setting.DegradationProbeTarget{Group: record.GroupName, Model: record.ModelName, ChannelID: record.ChannelId, ReasoningEffort: record.ReasoningEffort},
						probe: operation_setting.DegradationProbe{ID: record.ProbeID, Name: record.ProbeName, Kind: "drawing", Prompt: string(record.PromptSnapshot)}}
					performDegradationProbe(requestCtx, job, userID, &record, func(snapshot *model.DegradationWatchRecord) {
						snapshot.Id, snapshot.Status = record.Id, "running"
						if err := model.UpdateDegradationWatchProgress(snapshot); err != nil {
							mu.Lock()
							persistenceErr = err
							mu.Unlock()
							cancel()
						}
					})
				}
				if err := model.FinishDegradationWatchRecord(&record); err != nil {
					mu.Lock()
					persistenceErr = err
					mu.Unlock()
				}
			})
		}
		wg.Wait()
		if persistenceErr != nil {
			return persistenceErr
		}
		// A channel may already be drawing for a scheduled check. Its linked
		// records remain queued, with no lost trigger or replacement by that check.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return ctx.Err()
}

func linkedProbeDrawing(record *model.DegradationWatchRecord, visibility degradationWatchVisibility) (*degradationWatchRecordItem, error) {
	if record.ProbeKind != "text" || record.Verdict != "intermediate" {
		return nil, nil
	}
	var drawing model.DegradationWatchRecord
	err := model.DB.Select("id").Where("trigger_record_id = ?", record.Id).First(&drawing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	meta, err := model.GetDegradationWatchRecordMeta(drawing.Id)
	if err != nil {
		return nil, err
	}
	if !visibility.canView(meta) {
		return nil, nil
	}
	item := toDegradationWatchRecordItem(meta, visibility.admin, visibility.aliases)
	return &item, nil
}
