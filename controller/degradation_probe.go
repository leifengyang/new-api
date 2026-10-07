package controller

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
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

// Resolve old settings without rewriting them or enabling any new paid probes.
func resolveDegradationProbePlan() (*operation_setting.DegradationProbePlan, error) {
	setting := operation_setting.GetDegradationWatchSetting()
	if setting.ProbePlan != "" {
		return operation_setting.ParseDegradationProbePlan(setting.ProbePlan)
	}
	params := operation_setting.ResolveDegradationWatchParams()
	plan := &operation_setting.DegradationProbePlan{Enabled: setting.Enabled, Concurrency: params.Concurrency, TimeoutSeconds: params.TimeoutSeconds,
		Probes: []operation_setting.DegradationProbe{
			{ID: "sanae", Name: "早苗探针", Kind: "text", Prompt: operation_setting.SanaeProbePrompt, Expected: "高市早苗", Match: "exact", IntervalMinutes: 5},
			{ID: "drawing", Name: "绘画检测", Kind: "drawing", Prompt: operation_setting.GetDegradationWatchPrompt(), IntervalMinutes: 60},
		}, Targets: []operation_setting.DegradationProbeTarget{}}
	channels, err := model.GetAllChannels(0, 0, true, true)
	if err != nil {
		return nil, err
	}
	slices.SortFunc(channels, func(a, b *model.Channel) int { return a.Id - b.Id })
	aliases := operation_setting.GetDegradationWatchChannelAliases()
	for _, target := range operation_setting.ResolveDegradationWatchTargets() {
		shown := false
		for _, channel := range channels {
			if !isDegradationWatchCandidate(channel, target.Group, target.Model) {
				continue
			}
			public := !shown && aliases[strconv.Itoa(channel.Id)] != ""
			shown = shown || public
			plan.Targets = append(plan.Targets, operation_setting.DegradationProbeTarget{Group: target.Group, Model: target.Model, ChannelID: channel.Id, ReasoningEffort: target.ReasoningEffort, Enabled: target.Enabled, Public: public,
				Probes: []operation_setting.DegradationProbeBinding{{ProbeID: "drawing", Enabled: true, IntervalMinutes: params.IntervalMinutes}, {ProbeID: "sanae"}}})
		}
	}
	return plan, nil
}

func GetDegradationProbePlan(c *gin.Context) {
	plan, err := resolveDegradationProbePlan()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, struct {
		*operation_setting.DegradationProbePlan
		Configured bool `json:"configured"`
	}{plan, operation_setting.GetDegradationWatchSetting().ProbePlan != ""})
}

func SaveDegradationProbePlan(c *gin.Context) {
	var plan operation_setting.DegradationProbePlan
	if err := common.DecodeJson(http.MaxBytesReader(c.Writer, c.Request.Body, 2*1024*1024), &plan); err != nil {
		common.ApiErrorMsg(c, "invalid probe plan")
		return
	}
	raw, err := common.Marshal(plan)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if _, err := operation_setting.ParseDegradationProbePlan(string(raw)); err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	channels, err := model.GetAllChannels(0, 0, true, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	for _, target := range plan.Targets {
		if !slices.ContainsFunc(channels, func(ch *model.Channel) bool {
			return ch.Id == target.ChannelID && slices.Contains(ch.GetGroups(), target.Group) && slices.Contains(ch.GetModels(), target.Model)
		}) {
			common.ApiErrorMsg(c, "A target no longer belongs to its group or offers its model. Refresh channels and update the target.")
			return
		}
	}
	if err := model.UpdateOptionsBulk(map[string]string{operation_setting.DegradationProbePlanKey: string(raw)}); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, plan)
}

type degradationTextProbeHandler struct{}

func (degradationTextProbeHandler) Type() string { return "degradation_probe_text" }
func (degradationTextProbeHandler) Enabled() bool {
	return operation_setting.GetDegradationWatchSetting().ProbePlan != "" && (degradationWatchHandler{}).Enabled()
}
func (degradationTextProbeHandler) Interval() time.Duration { return time.Minute }
func (degradationTextProbeHandler) NewPayload() any {
	return degradationWatchTaskPayload{Scheduled: true}
}
func (degradationTextProbeHandler) Run(ctx context.Context, task *model.SystemTask, runner string) {
	runDegradationProbeTask(ctx, task, runner, "text")
}

type degradationProbeJob struct {
	target  operation_setting.DegradationProbeTarget
	probe   operation_setting.DegradationProbe
	channel *model.Channel
}

func selectDegradationProbeJobs(plan *operation_setting.DegradationProbePlan, channels []*model.Channel, payload degradationWatchTaskPayload, kind string, now int64) ([]degradationProbeJob, error) {
	jobs := []degradationProbeJob{}
	for _, target := range plan.Targets {
		if !target.Enabled || (payload.Group != "" && target.Group != payload.Group) || (payload.Model != "" && target.Model != payload.Model) || (payload.ChannelId > 0 && target.ChannelID != payload.ChannelId) {
			continue
		}
		var channel *model.Channel
		for _, ch := range channels {
			if ch.Id == target.ChannelID && isDegradationWatchCandidate(ch, target.Group, target.Model) {
				channel = ch
				break
			}
		}
		if channel == nil {
			continue
		}
		for _, binding := range target.Probes {
			if !binding.Enabled || (payload.ProbeID != "" && payload.ProbeID != binding.ProbeID) {
				continue
			}
			for _, probe := range plan.Probes {
				if probe.ID != binding.ProbeID || probe.Kind != kind {
					continue
				}
				interval := probe.IntervalMinutes
				if binding.IntervalMinutes > 0 {
					interval = binding.IntervalMinutes
				}
				if payload.Scheduled {
					last, err := model.LastDegradationProbeAttempt(probeSeries(target, probe))
					if err != nil {
						return nil, err
					}
					if last > 0 && now-last < int64(interval)*60 {
						continue
					}
				}
				probeTarget := target
				if binding.ReasoningEffort != nil {
					probeTarget.ReasoningEffort = *binding.ReasoningEffort
				}
				jobs = append(jobs, degradationProbeJob{target: probeTarget, probe: probe, channel: channel})
			}
		}
	}
	return jobs, nil
}

func runDegradationProbeTask(ctx context.Context, task *model.SystemTask, runner, kind string) {
	summary, err := executeDegradationProbes(ctx, task, runner, kind)
	status := model.SystemTaskStatusSucceeded
	if err != nil {
		status = model.SystemTaskStatusFailed
	}
	finishSystemTaskHandler(task, runner, status, summary, err)
}

func executeDegradationProbes(ctx context.Context, task *model.SystemTask, runner, kind string) (degradationWatchSummary, error) {
	summary := degradationWatchSummary{}
	plan, err := resolveDegradationProbePlan()
	if err != nil {
		return summary, err
	}
	var payload degradationWatchTaskPayload
	if err := task.DecodePayload(&payload); err != nil {
		return summary, err
	}
	if payload.Scheduled && !plan.Enabled {
		return summary, nil
	}
	channels, err := model.GetAllChannels(0, 0, true, false)
	if err != nil {
		return summary, err
	}
	jobs, err := selectDegradationProbeJobs(plan, channels, payload, kind, common.GetTimestamp())
	if err != nil || len(jobs) == 0 {
		return summary, err
	}
	userID, err := resolveChannelTestUserID(nil)
	if err != nil {
		return summary, err
	}
	records := make([]*model.DegradationWatchRecord, 0, len(jobs))
	defer func() {
		for _, record := range records { // Only queued/running rows can be finished.
			_ = model.FinishDegradationWatchRecord(&model.DegradationWatchRecord{Id: record.Id, Verdict: "error", FailureReason: "interrupted", ErrorDetails: "Detection task ended before this attempt completed."})
		}
	}()
	for _, job := range jobs {
		record := &model.DegradationWatchRecord{RunId: task.TaskID, ChannelId: job.target.ChannelID, GroupName: job.target.Group, ModelName: job.target.Model, ReasoningEffort: job.target.ReasoningEffort,
			ProbeID: job.probe.ID, ProbeName: job.probe.Name, ProbeKind: job.probe.Kind, PromptSnapshot: model.LongText(job.probe.Prompt), ExpectedSnapshot: model.LongText(job.probe.Expected), IntermediateExpectedSnapshot: model.LongText(job.probe.IntermediateAnswer()), MatchSnapshot: job.probe.Match, Status: "queued", TokensEstimated: true}
		if err := model.CreateDegradationWatchRecord(record); err != nil {
			return summary, err
		}
		records = append(records, record)
	}
	report := service.NewSystemTaskProgressReporter(task, runner)
	report(0, len(jobs))
	var mu sync.Mutex
	var wg sync.WaitGroup
	var saveErr error
	sem := make(chan struct{}, plan.Concurrency)
	for i, job := range jobs {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
		record := records[i]
		wg.Go(func() {
			defer func() { <-sem }()
			requestCtx, cancel := context.WithTimeout(ctx, time.Duration(plan.TimeoutSeconds)*time.Second)
			defer cancel()
			progress := func(snapshot *model.DegradationWatchRecord) {
				snapshot.Id, snapshot.Status = record.Id, "running"
				if err := model.UpdateDegradationWatchProgress(snapshot); err != nil {
					mu.Lock()
					saveErr = err
					mu.Unlock()
					cancel()
				}
			}
			progress(&model.DegradationWatchRecord{TokensEstimated: true})
			performDegradationProbe(requestCtx, job, userID, record, progress)
			err := model.FinishDegradationWatchRecord(record)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				saveErr = err
			}
			summary.Tested++
			if record.Success {
				summary.Succeeded++
			} else if record.Verdict == "intermediate" {
				summary.Intermediate++
			} else {
				summary.Failed++
			}
			report(summary.Tested, len(jobs))
		})
	}
	wg.Wait()
	if saveErr != nil {
		return summary, saveErr
	}
	return summary, ctx.Err()
}

func performDegradationProbe(ctx context.Context, job degradationProbeJob, userID int, record *model.DegradationWatchRecord, progress func(*model.DegradationWatchRecord)) {
	started := time.Now()
	defer func() {
		record.ElapsedMs = time.Since(started).Milliseconds()
		if value := recover(); value != nil {
			record.Success = false
			record.Verdict = "error"
			record.FailureReason = "upstream_error"
			record.ErrorDetails = model.LongText(redactDegradationWatchError(fmt.Sprint(value), job.channel))
		}
	}()
	channel := *job.channel
	output, _, err := requestDegradationProbe(ctx, &channel, userID, job.target.Model, job.target.ReasoningEffort, job.probe.Prompt, job.target.Group, func(snapshot *model.DegradationWatchRecord) {
		record.PromptTokens, record.CompletionTokens, record.ReasoningTokens, record.TokensEstimated = snapshot.PromptTokens, snapshot.CompletionTokens, snapshot.ReasoningTokens, snapshot.TokensEstimated
		progress(snapshot)
	})
	record.OutputText = model.LongText(output)
	if err != nil {
		record.Verdict, record.FailureReason = "error", "upstream_error"
		if ctx.Err() == context.DeadlineExceeded {
			record.FailureReason = "timeout"
		}
		record.ErrorDetails = model.LongText(redactDegradationWatchError(err.Error(), job.channel))
		return
	}
	evaluateDegradationProbe(record, job.probe, output)
}

var degradationProbeSVGPattern = regexp.MustCompile(`(?is)<svg\b[^>]*(?:/>|>.*?</svg\s*>)`)

func evaluateDegradationProbe(record *model.DegradationWatchRecord, probe operation_setting.DegradationProbe, output string) {
	if probe.Kind == "drawing" {
		html, reason := extractDegradationWatchHtml(output)
		if reason == "" && !degradationProbeSVGPattern.MatchString(html) {
			html, reason = "", degradationWatchReasonNoSvg
		}
		record.Html, record.FailureReason, record.Success = model.LongText(html), reason, reason == ""
	} else {
		answer := strings.TrimSpace(output)
		record.Success = answer == strings.TrimSpace(probe.Expected)
		if probe.Match == "contains" {
			record.Success = strings.Contains(answer, strings.TrimSpace(probe.Expected))
		}
		if !record.Success {
			intermediate := probe.IntermediateAnswer()
			if intermediate != "" && (answer == intermediate || (probe.Match == "contains" && strings.Contains(answer, intermediate))) {
				record.Verdict, record.FailureReason = "intermediate", ""
				return
			}
			record.FailureReason = "answer_mismatch"
		}
	}
	record.Verdict = "mismatch"
	if record.Success {
		record.Verdict = "passed"
	}
}

func RunDegradationProbes(c *gin.Context) {
	var payload degradationWatchTaskPayload
	if err := common.DecodeJson(c.Request.Body, &payload); err != nil {
		common.ApiErrorMsg(c, "invalid request")
		return
	}
	payload.Scheduled = false
	plan, err := resolveDegradationProbePlan()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if operation_setting.GetDegradationWatchSetting().ProbePlan == "" {
		common.ApiErrorMsg(c, "Save the probe settings before running checks.")
		return
	}
	channels, err := model.GetAllChannels(0, 0, true, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	taskTypes := []string{}
	for _, kind := range []string{"text", "drawing"} {
		jobs, err := selectDegradationProbeJobs(plan, channels, payload, kind, common.GetTimestamp())
		if err != nil {
			common.ApiError(c, err)
			return
		}
		if len(jobs) == 0 {
			continue
		}
		taskType := model.SystemTaskTypeDegradationWatch
		if kind == "text" {
			taskType = "degradation_probe_text"
		}
		active, err := model.GetActiveSystemTask(taskType)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		if active != nil {
			c.JSON(http.StatusConflict, gin.H{"success": false, "message": "已有一轮降智检测正在运行或等待中"})
			return
		}
		taskTypes = append(taskTypes, taskType)
	}
	tasks := []gin.H{}
	for _, taskType := range taskTypes {
		task, created, err := service.EnqueueSystemTask(taskType, payload)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		if !created {
			c.JSON(http.StatusConflict, gin.H{"success": false, "message": "已有一轮降智检测正在运行或等待中", "data": gin.H{"queued_tasks": tasks}})
			return
		}
		tasks = append(tasks, gin.H{"task_id": task.TaskID, "status": task.Status, "created": created})
	}
	if len(tasks) == 0 {
		common.ApiErrorMsg(c, "No enabled probes on eligible channels.")
		return
	}
	common.ApiSuccess(c, tasks)
}

// Existing unscoped artwork belongs only to its original configured group.
func probeSeries(target operation_setting.DegradationProbeTarget, probe operation_setting.DegradationProbe) model.DegradationProbeSeries {
	legacy := false
	if probe.ID == "drawing" {
		for _, previous := range operation_setting.ResolveDegradationWatchTargets() {
			if previous.Model == target.Model {
				legacy = previous.Group == target.Group
				break
			}
		}
	}
	return model.DegradationProbeSeries{GroupName: target.Group, ChannelID: target.ChannelID, Model: target.Model, ProbeID: probe.ID, Legacy: legacy}
}

func canViewDegradationProbeRecord(record *model.DegradationWatchRecord) bool {
	if record.Hidden {
		return false
	}
	plan, err := resolveDegradationProbePlan()
	if err != nil {
		return false
	}
	for _, target := range plan.Targets {
		if target.ChannelID != record.ChannelId || target.Model != record.ModelName {
			continue
		}
		for _, binding := range target.Probes {
			if !binding.IsPublic(target) {
				continue
			}
			for _, probe := range plan.Probes {
				if probe.ID != binding.ProbeID {
					continue
				}
				series := probeSeries(target, probe)
				if (record.GroupName == target.Group && record.ProbeID == probe.ID) || (series.Legacy && record.GroupName == "" && record.ProbeID == "") {
					return true
				}
			}
		}
	}
	return false
}

var probeURLPattern = regexp.MustCompile(`(?i)https?://[^\s<>"']+`)
var probeIPPattern = regexp.MustCompile(`(?:\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?|\[[0-9a-fA-F:]+\](?::\d+)?)`)
var probeCredentialPattern = regexp.MustCompile(`(?i)(bearer\s+|sk-)[a-z0-9_.\-]+`)
var probeChannelPattern = regexp.MustCompile(`(?i)["']?channel(?:[_ -]?(?:id|name))?["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)`)

func publicDegradationProbeError(message string, channelID int) string {
	if message == "" {
		return ""
	}
	channel, err := model.GetChannelById(channelID, true)
	if err != nil || channel == nil {
		return "Details unavailable"
	}
	message = redactDegradationWatchError(message, channel)
	if channel.Name != "" {
		message = strings.ReplaceAll(message, channel.Name, "[REDACTED]")
	}
	if base := channel.GetBaseURL(); base != "" {
		message = strings.ReplaceAll(message, base, "[REDACTED]")
		if parsed, err := url.Parse(base); err == nil && parsed.Hostname() != "" {
			message = strings.ReplaceAll(message, parsed.Hostname(), "[REDACTED]")
		}
	}
	message = probeURLPattern.ReplaceAllString(message, "[REDACTED]")
	message = probeIPPattern.ReplaceAllString(message, "[REDACTED]")
	message = probeCredentialPattern.ReplaceAllString(message, "[REDACTED]")
	return probeChannelPattern.ReplaceAllString(message, "[REDACTED]")
}

func getDegradationProbePrompt(c *gin.Context) {
	plan, err := resolveDegradationProbePlan()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	targets := []degradationWatchPromptTarget{}
	seen := map[string]bool{}
	for _, target := range plan.Targets {
		if slices.ContainsFunc(target.Probes, func(binding operation_setting.DegradationProbeBinding) bool { return binding.IsPublic(target) }) && !seen[target.Model] {
			targets = append(targets, degradationWatchPromptTarget{Model: target.Model, ReasoningEffort: target.ReasoningEffort})
			seen[target.Model] = true
		}
	}
	prompt := operation_setting.GetDegradationWatchPrompt()
	for _, probe := range plan.Probes {
		if probe.Kind == "drawing" {
			prompt = probe.Prompt
			break
		}
	}
	common.ApiSuccess(c, gin.H{"prompt": prompt, "targets": targets})
}
