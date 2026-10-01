package controller

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relay"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
	"github.com/samber/lo"
	"github.com/tidwall/gjson"
	"gorm.io/gorm"
)

// 失败原因里我们自己判定的几种写成代码，前端按代码翻译；其余是上游或本地
// 报错原文，只给管理员看——原文里常带着上游地址，普通用户只看到
// degradationWatchReasonUpstream。
const (
	degradationWatchReasonTimeout  = "timeout"
	degradationWatchReasonEmpty    = "empty_content"
	degradationWatchReasonNoHtml   = "no_html"
	degradationWatchReasonNoSvg    = "no_svg"
	degradationWatchReasonUpstream = "upstream_error"
)

var degradationWatchReasonCodes = []string{
	degradationWatchReasonTimeout,
	degradationWatchReasonEmpty,
	degradationWatchReasonNoHtml,
	degradationWatchReasonNoSvg,
	degradationWatchReasonUpstream,
}

const (
	// 检测墙一页的轮数。
	degradationWatchDefaultRounds = 10
	degradationWatchMaxRounds     = 30
	// degradationWatchScanBatch 是凑轮次时每次从库里取的记录数。
	degradationWatchScanBatch = 200
	// degradationWatchLegacyRoundGap：没有 run_id 的旧记录，相邻两条相隔超过
	// 这个秒数就算两轮。旧版一轮只跑一个模型，整轮默认 10 分钟超时。
	degradationWatchLegacyRoundGap = 10 * 60
)

// degradationWatchHandler 按后台配置的间隔调度一轮降智检测。
type degradationWatchHandler struct{}

func (degradationWatchHandler) Type() string { return model.SystemTaskTypeDegradationWatch }

func (degradationWatchHandler) Enabled() bool {
	return operation_setting.GetDegradationWatchSetting().Enabled
}

func (degradationWatchHandler) Interval() time.Duration {
	return time.Duration(operation_setting.ResolveDegradationWatchParams().IntervalMinutes) * time.Minute
}

func (degradationWatchHandler) NewPayload() any { return nil }

// degradationWatchTaskPayload 为空表示检测所有启用的目标。后台「立即检测」可以
// 用 Model 只测一个目标（停用的也可以），用 ChannelId 只测一个渠道。
type degradationWatchTaskPayload struct {
	ChannelId int    `json:"channel_id,omitempty"`
	Model     string `json:"model,omitempty"`
}

type degradationWatchSummary struct {
	Tested    int   `json:"tested"`
	Succeeded int   `json:"succeeded"`
	Failed    int   `json:"failed"`
	Pruned    int64 `json:"pruned"`
}

func (degradationWatchHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	payload := degradationWatchTaskPayload{}
	if err := task.DecodePayload(&payload); err != nil {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, nil, err)
		return
	}
	summary, err := runDegradationWatchTask(ctx, task.TaskID, payload, service.NewSystemTaskProgressReporter(task, runnerID))
	if err != nil {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, summary, err)
		return
	}
	finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusSucceeded, summary, nil)
}

// isDegradationWatchCandidate：启用中、在检测分组里、并且配了被测模型的渠道。
func isDegradationWatchCandidate(channel *model.Channel, group string, modelName string) bool {
	if channel == nil || channel.Status != common.ChannelStatusEnabled {
		return false
	}
	if !slices.Contains(channel.GetGroups(), group) {
		return false
	}
	return slices.ContainsFunc(channel.GetModels(), func(m string) bool {
		return strings.TrimSpace(m) == modelName
	})
}

// degradationWatchJob 是一轮里的一次作答：一个目标在一个渠道上画一次。
type degradationWatchJob struct {
	channel *model.Channel
	target  operation_setting.DegradationWatchTarget
}

// selectDegradationWatchJobs 按目标顺序展开这一轮要跑的作答。指定了模型时只跑
// 这个目标（停用的也跑，是管理员手动点的）；没指定时只跑启用的目标。
func selectDegradationWatchJobs(channels []*model.Channel, targets []operation_setting.DegradationWatchTarget, payload degradationWatchTaskPayload) []degradationWatchJob {
	jobs := make([]degradationWatchJob, 0)
	for _, target := range targets {
		if payload.Model != "" && target.Model != payload.Model {
			continue
		}
		if payload.Model == "" && !target.Enabled {
			continue
		}
		for _, channel := range channels {
			if payload.ChannelId > 0 && channel.Id != payload.ChannelId {
				continue
			}
			if isDegradationWatchCandidate(channel, target.Group, target.Model) {
				jobs = append(jobs, degradationWatchJob{channel: channel, target: target})
			}
		}
	}
	return jobs
}

func runDegradationWatchTask(ctx context.Context, runId string, payload degradationWatchTaskPayload, report func(processed, total int)) (degradationWatchSummary, error) {
	summary := degradationWatchSummary{}
	params := operation_setting.ResolveDegradationWatchParams()
	prompt := operation_setting.GetDegradationWatchPrompt()

	testUserID, err := resolveChannelTestUserID(nil)
	if err != nil {
		return summary, err
	}
	channels, err := model.GetAllChannels(0, 0, true, false)
	if err != nil {
		return summary, err
	}
	jobs := selectDegradationWatchJobs(channels, operation_setting.ResolveDegradationWatchTargets(), payload)
	if (payload.ChannelId > 0 || payload.Model != "") && len(jobs) == 0 {
		return summary, fmt.Errorf("no eligible channel for model %q, channel %d: check the target, its group and the channel's models", payload.Model, payload.ChannelId)
	}

	var (
		mu        sync.Mutex
		wg        sync.WaitGroup
		processed int
	)
	sem := make(chan struct{}, params.Concurrency)
	if report != nil {
		report(0, len(jobs))
	}
	for _, job := range jobs {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
		wg.Go(func() {
			defer func() { <-sem }()
			// 超时按单次请求计：排在后面的请求不该因为前面的请求慢而被判失败。
			requestCtx, cancel := context.WithTimeout(ctx, time.Duration(params.TimeoutSeconds)*time.Second)
			defer cancel()
			record := drawDegradationWatch(requestCtx, job.channel, testUserID, job.target.Model, job.target.ReasoningEffort, prompt)
			// 父 ctx 被取消说明租约丢了，这一轮不作数；只有撞上单次时限才记成超时失败。
			if ctx.Err() != nil {
				return
			}
			record.RunId = runId
			if err := model.CreateDegradationWatchRecord(record); err != nil {
				common.SysError(fmt.Sprintf("degradation watch: failed to save record for channel %d model %s: %v", job.channel.Id, job.target.Model, err))
			}
			mu.Lock()
			defer mu.Unlock()
			summary.Tested++
			if record.Success {
				summary.Succeeded++
			} else {
				summary.Failed++
			}
			processed++
			if report != nil {
				report(processed, len(jobs))
			}
		})
	}
	wg.Wait()

	// 裁剪覆盖表里出现过的所有「渠道 + 模型」：移出配置的也不能无限留着旧作品。
	series, err := model.GetDegradationWatchRecordedSeries()
	if err != nil {
		return summary, err
	}
	for _, item := range series {
		pruned, err := model.PruneDegradationWatchRecords(item, params.Retention)
		if err != nil {
			return summary, err
		}
		summary.Pruned += pruned
	}
	return summary, nil
}

// drawDegradationWatch 直连渠道发一次绘图请求。流程照抄 testChannel 的合成上下文，
// 但刻意不做 settleTestQuota / RecordConsumeLog：检测不扣任何人的额度，也不进
// 使用日志。一律走流式，长时间推理时非流式请求容易被中间代理掐断。
func drawDegradationWatch(ctx context.Context, channel *model.Channel, testUserID int, modelName string, effort string, prompt string) *model.DegradationWatchRecord {
	record := &model.DegradationWatchRecord{
		ChannelId:       channel.Id,
		ModelName:       modelName,
		ReasoningEffort: effort,
	}
	tik := time.Now()
	text, usage, err := requestDegradationWatchDrawing(ctx, channel, testUserID, modelName, effort, prompt)
	record.ElapsedMs = time.Since(tik).Milliseconds()
	if usage != nil {
		record.PromptTokens = usage.PromptTokens
		record.CompletionTokens = usage.CompletionTokens
		record.ReasoningTokens = usage.CompletionTokenDetails.ReasoningTokens
		if usage.OutputTokensDetails != nil && usage.OutputTokensDetails.ReasoningTokens > record.ReasoningTokens {
			record.ReasoningTokens = usage.OutputTokensDetails.ReasoningTokens
		}
	}
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			record.FailureReason = degradationWatchReasonTimeout
		} else {
			record.FailureReason = err.Error()
		}
		return record
	}
	html, reason := extractDegradationWatchHtml(text)
	if reason != "" {
		record.FailureReason = reason
		return record
	}
	record.Success = true
	record.Html = model.LongText(html)
	return record
}

func requestDegradationWatchDrawing(ctx context.Context, channel *model.Channel, testUserID int, modelName string, effort string, prompt string) (string, *dto.Usage, error) {
	useResponses := normalizeChannelTestEndpoint(channel, "") == string(constant.EndpointTypeOpenAIResponse)
	requestPath := "/v1/chat/completions"
	relayFormat := types.RelayFormatOpenAI
	if useResponses {
		requestPath = "/v1/responses"
		relayFormat = types.RelayFormatOpenAIResponses
	}

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequestWithContext(ctx, http.MethodPost, requestPath, nil)
	c.Request.Header.Set("Content-Type", "application/json")

	userCache, err := model.GetUserCache(testUserID)
	if err != nil {
		return "", nil, err
	}
	userCache.WriteContext(c)
	c.Set("id", testUserID)
	c.Set("channel", channel.Type)
	c.Set("base_url", channel.GetBaseURL())
	group, _ := model.GetUserGroup(testUserID, false)
	c.Set("group", group)

	if apiErr := middleware.SetupContextForSelectedChannel(c, channel, modelName); apiErr != nil {
		return "", nil, apiErr
	}

	var request dto.Request
	if useResponses {
		input, err := common.Marshal([]map[string]string{{"role": "user", "content": prompt}})
		if err != nil {
			return "", nil, err
		}
		responsesRequest := &dto.OpenAIResponsesRequest{
			Model:  modelName,
			Input:  input,
			Stream: lo.ToPtr(true),
		}
		if effort != "" {
			responsesRequest.Reasoning = &dto.Reasoning{Effort: effort}
		}
		request = responsesRequest
	} else {
		request = &dto.GeneralOpenAIRequest{
			Model:           modelName,
			Stream:          lo.ToPtr(true),
			StreamOptions:   &dto.StreamOptions{IncludeUsage: true},
			Messages:        []dto.Message{{Role: "user", Content: prompt}},
			ReasoningEffort: effort,
		}
	}

	info, err := relaycommon.GenRelayInfo(c, relayFormat, request, nil)
	if err != nil {
		return "", nil, err
	}
	info.IsChannelTest = true
	info.InitChannelMeta(c)
	if err := helper.ModelMappedHelper(c, info, request); err != nil {
		return "", nil, err
	}
	if err := helper.ApplyReasoningModelSuffix(c, info, request); err != nil {
		return "", nil, err
	}
	request.SetModelName(info.UpstreamModelName)

	apiType, _ := common.ChannelType2APIType(channel.Type)
	adaptor := relay.GetAdaptor(apiType)
	if adaptor == nil {
		return "", nil, fmt.Errorf("invalid api type: %d, adaptor is nil", apiType)
	}
	adaptor.Init(info)

	var converted any
	switch req := request.(type) {
	case *dto.OpenAIResponsesRequest:
		converted, err = adaptor.ConvertOpenAIResponsesRequest(c, info, *req)
	case *dto.GeneralOpenAIRequest:
		converted, err = adaptor.ConvertOpenAIRequest(c, info, req)
	}
	if err != nil {
		return "", nil, err
	}
	jsonData, err := common.Marshal(converted)
	if err != nil {
		return "", nil, err
	}
	if len(info.ParamOverride) > 0 {
		jsonData, err = relaycommon.ApplyParamOverrideWithRelayInfo(jsonData, info)
		if err != nil {
			return "", nil, err
		}
	}

	c.Request.Body = io.NopCloser(bytes.NewBuffer(jsonData))
	resp, err := adaptor.DoRequest(c, info, bytes.NewBuffer(jsonData))
	if err != nil {
		return "", nil, err
	}
	var httpResp *http.Response
	if resp != nil {
		httpResp = resp.(*http.Response)
		if httpResp.StatusCode != http.StatusOK {
			return "", nil, service.RelayErrorHandler(c.Request.Context(), httpResp, true)
		}
	}
	usageAny, respErr := adaptor.DoResponse(c, httpResp, info)
	if respErr != nil {
		return "", nil, respErr
	}
	usage, _ := coerceTestUsage(usageAny, true, info.GetEstimatePromptTokens())

	body, err := io.ReadAll(w.Result().Body)
	if err != nil {
		return "", usage, err
	}
	if bodyErr := detectErrorFromTestResponseBody(body); bodyErr != nil {
		return "", usage, bodyErr
	}
	return collectDegradationWatchStreamText(body), usage, nil
}

// collectDegradationWatchStreamText 把 SSE 里的正文增量拼回整段文本，兼容
// Chat Completions 与 Responses 两种事件格式。Responses 流如果没有增量事件，
// 回退到 response.completed 里的完整输出。
func collectDegradationWatchStreamText(body []byte) string {
	var chat, deltas, completed strings.Builder
	for line := range bytes.SplitSeq(body, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		payload := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
		if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
			continue
		}
		event := gjson.ParseBytes(payload)
		if content := event.Get("choices.0.delta.content"); content.Type == gjson.String {
			chat.WriteString(content.String())
			continue
		}
		switch event.Get("type").String() {
		case "response.output_text.delta":
			deltas.WriteString(event.Get("delta").String())
		case "response.completed":
			event.Get("response.output").ForEach(func(_, item gjson.Result) bool {
				item.Get("content").ForEach(func(_, part gjson.Result) bool {
					if part.Get("type").String() == "output_text" {
						completed.WriteString(part.Get("text").String())
					}
					return true
				})
				return true
			})
		}
	}
	switch {
	case chat.Len() > 0:
		return chat.String()
	case deltas.Len() > 0:
		return deltas.String()
	default:
		return completed.String()
	}
}

// extractDegradationWatchHtml 从回答里截出 <!doctype html> / <html> 到最后一个
// </html>。模型常常无视「不要代码块」的要求，所以不假设回答以 HTML 开头。
// 返回的 reason 非空表示判定失败。
func extractDegradationWatchHtml(text string) (string, string) {
	if strings.TrimSpace(text) == "" {
		return "", degradationWatchReasonEmpty
	}
	lower := strings.ToLower(text)
	start := strings.Index(lower, "<!doctype html")
	if start < 0 {
		start = strings.Index(lower, "<html")
	}
	end := strings.LastIndex(lower, "</html>")
	if start < 0 || end < start {
		return "", degradationWatchReasonNoHtml
	}
	html := text[start : end+len("</html>")]
	if !strings.Contains(strings.ToLower(html), "<svg") {
		return "", degradationWatchReasonNoSvg
	}
	return html, ""
}

func isDegradationWatchAdmin(c *gin.Context) bool {
	return c.GetInt("role") >= common.RoleAdminUser
}

type degradationWatchRecordItem struct {
	Id              int    `json:"id"`
	ModelName       string `json:"model_name"`
	ReasoningEffort string `json:"reasoning_effort"`
	// ChannelTitle 对普通用户是别名；管理员看没配别名的渠道时是渠道名。
	ChannelTitle string `json:"channel_title"`
	Aliased      bool   `json:"aliased"`
	// ChannelId 只回给管理员。
	ChannelId        int    `json:"channel_id,omitempty"`
	Success          bool   `json:"success"`
	FailureReason    string `json:"failure_reason"`
	ElapsedMs        int64  `json:"elapsed_ms"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	ReasoningTokens  int    `json:"reasoning_tokens"`
	Hidden           bool   `json:"hidden"`
	CreatedAt        int64  `json:"created_at"`
}

func toDegradationWatchRecordItem(record *model.DegradationWatchRecord, admin bool, aliases map[string]string) degradationWatchRecordItem {
	reason := record.FailureReason
	if !admin && reason != "" && !slices.Contains(degradationWatchReasonCodes, reason) {
		reason = degradationWatchReasonUpstream
	}
	alias, aliased := aliases[strconv.Itoa(record.ChannelId)]
	item := degradationWatchRecordItem{
		Id:               record.Id,
		ModelName:        record.ModelName,
		ReasoningEffort:  record.ReasoningEffort,
		ChannelTitle:     alias,
		Aliased:          aliased,
		Success:          record.Success,
		FailureReason:    reason,
		ElapsedMs:        record.ElapsedMs,
		PromptTokens:     record.PromptTokens,
		CompletionTokens: record.CompletionTokens,
		ReasoningTokens:  record.ReasoningTokens,
		Hidden:           record.Hidden,
		CreatedAt:        record.CreatedAt,
	}
	if admin {
		item.ChannelId = record.ChannelId
		if !aliased {
			item.ChannelTitle = fmt.Sprintf("#%d", record.ChannelId)
			if channel, err := model.CacheGetChannel(record.ChannelId); err == nil && channel != nil && channel.Name != "" {
				item.ChannelTitle = channel.Name
			}
		}
	}
	return item
}

// degradationWatchRound 是检测墙的一行：同一轮里所有模型、所有渠道的作答。
type degradationWatchRound struct {
	// Key 在刷新之间保持不变：有 run_id 用 run_id，旧记录用这一轮最早那条的 id。
	Key       string                       `json:"key"`
	StartedAt int64                        `json:"started_at"`
	Records   []degradationWatchRecordItem `json:"records"`

	records []*model.DegradationWatchRecord
	minId   int
}

// groupDegradationWatchRounds 把按 id 倒序的记录切成轮次。同一时间只会有一轮
// 在跑，同一轮的记录 id 是连续的，所以只需比较相邻两条：run_id 不同就换轮；
// 都没有 run_id 的旧记录，相隔太久或同一「渠道 + 模型」又出现一次也换轮。
func groupDegradationWatchRounds(records []*model.DegradationWatchRecord) []*degradationWatchRound {
	rounds := make([]*degradationWatchRound, 0)
	var current *degradationWatchRound
	var previous *model.DegradationWatchRecord
	seen := map[model.DegradationWatchSeries]bool{}
	for _, record := range records {
		series := model.DegradationWatchSeries{ChannelId: record.ChannelId, ModelName: record.ModelName}
		sameRound := current != nil && previous.RunId == record.RunId
		if sameRound && record.RunId == "" {
			sameRound = previous.CreatedAt-record.CreatedAt <= degradationWatchLegacyRoundGap && !seen[series]
		}
		if !sameRound {
			current = &degradationWatchRound{Key: record.RunId}
			rounds = append(rounds, current)
			seen = map[model.DegradationWatchSeries]bool{}
		}
		seen[series] = true
		current.records = append(current.records, record)
		current.minId = record.Id
		current.StartedAt = record.CreatedAt
		if record.RunId == "" {
			current.Key = fmt.Sprintf("legacy-%d", record.Id)
		}
		previous = record
	}
	return rounds
}

type degradationWatchLane struct {
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
	Enabled         bool   `json:"enabled"`
	// Configured 为 false 的泳道是已经移出配置的模型，只有管理员看得到。
	Configured   bool  `json:"configured"`
	Total        int64 `json:"total"`
	Succeeded    int64 `json:"succeeded"`
	Visible      int64 `json:"visible"`
	AvgElapsedMs int64 `json:"avg_elapsed_ms"`
	LastRecordAt int64 `json:"last_record_at"`
}

// degradationWatchVisibility 是当前用户能看到的范围：普通用户只看配了别名的
// 渠道、仍在配置里的模型、没被隐藏的作品；管理员不受限。
type degradationWatchVisibility struct {
	admin   bool
	aliases map[string]string
	targets []operation_setting.DegradationWatchTarget
}

func newDegradationWatchVisibility(c *gin.Context) degradationWatchVisibility {
	return degradationWatchVisibility{
		admin:   isDegradationWatchAdmin(c),
		aliases: operation_setting.GetDegradationWatchChannelAliases(),
		targets: operation_setting.ResolveDegradationWatchTargets(),
	}
}

func (v degradationWatchVisibility) filter() model.DegradationWatchRecordFilter {
	if v.admin {
		return model.DegradationWatchRecordFilter{IncludeHidden: true}
	}
	filter := model.DegradationWatchRecordFilter{ChannelIds: []int{}, ModelNames: []string{}}
	for id := range v.aliases {
		if channelId, err := strconv.Atoi(id); err == nil && channelId > 0 {
			filter.ChannelIds = append(filter.ChannelIds, channelId)
		}
	}
	for _, target := range v.targets {
		filter.ModelNames = append(filter.ModelNames, target.Model)
	}
	return filter
}

func (v degradationWatchVisibility) canView(record *model.DegradationWatchRecord) bool {
	if v.admin {
		return true
	}
	if _, ok := v.aliases[strconv.Itoa(record.ChannelId)]; !ok || record.Hidden {
		return false
	}
	return slices.ContainsFunc(v.targets, func(target operation_setting.DegradationWatchTarget) bool {
		return target.Model == record.ModelName
	})
}

// buildDegradationWatchLanes 按配置顺序列出泳道；管理员额外看到表里还有记录、
// 但已经移出配置的模型，排在最后。
func buildDegradationWatchLanes(v degradationWatchVisibility) ([]degradationWatchLane, error) {
	stats, err := model.GetDegradationWatchModelStats(v.filter().ChannelIds)
	if err != nil {
		return nil, err
	}
	lanes := make([]degradationWatchLane, 0, len(v.targets))
	for _, target := range v.targets {
		lanes = append(lanes, degradationWatchLane{
			Model:           target.Model,
			ReasoningEffort: target.ReasoningEffort,
			Enabled:         target.Enabled,
			Configured:      true,
		})
	}
	if v.admin {
		extra := make([]string, 0)
		for modelName := range stats {
			if !slices.ContainsFunc(v.targets, func(target operation_setting.DegradationWatchTarget) bool {
				return target.Model == modelName
			}) {
				extra = append(extra, modelName)
			}
		}
		slices.Sort(extra)
		for _, modelName := range extra {
			lanes = append(lanes, degradationWatchLane{Model: modelName})
		}
	}
	for i := range lanes {
		stat := stats[lanes[i].Model]
		if stat == nil {
			continue
		}
		lanes[i].Total = stat.Total
		lanes[i].Succeeded = stat.Succeeded
		lanes[i].Visible = stat.Visible
		lanes[i].LastRecordAt = stat.LastRecordAt
		if stat.Succeeded > 0 {
			lanes[i].AvgElapsedMs = stat.SucceededElapsed / stat.Succeeded
		}
	}
	return lanes, nil
}

// listDegradationWatchRounds 取 before 之前的 limit 轮，返回下一页的游标（0 表示
// 没有更多）。按批扫描，直到多凑出一轮：多出来的那一轮可能只取到一半，丢掉，
// 下一页从它开始，保证每一轮都完整。
func listDegradationWatchRounds(filter model.DegradationWatchRecordFilter, beforeId int, limit int) ([]*degradationWatchRound, int, error) {
	records := make([]*model.DegradationWatchRecord, 0)
	cursor := beforeId
	for {
		page, err := model.ListDegradationWatchRecordsBefore(filter, cursor, degradationWatchScanBatch)
		if err != nil {
			return nil, 0, err
		}
		records = append(records, page...)
		rounds := groupDegradationWatchRounds(records)
		if len(rounds) > limit {
			return rounds[:limit], rounds[limit-1].minId, nil
		}
		if len(page) < degradationWatchScanBatch {
			return rounds, 0, nil
		}
		cursor = page[len(page)-1].Id
	}
}

func parseDegradationWatchRounds(c *gin.Context) int {
	rounds, err := strconv.Atoi(c.Query("rounds"))
	if err != nil || rounds <= 0 {
		return degradationWatchDefaultRounds
	}
	return min(rounds, degradationWatchMaxRounds)
}

// GetDegradationWatchWall 返回检测墙的一页轮次。before 是上一页返回的
// next_before，普通用户全程拿不到渠道 id。泳道只在第一页返回。
func GetDegradationWatchWall(c *gin.Context) {
	visibility := newDegradationWatchVisibility(c)
	beforeId, _ := strconv.Atoi(c.Query("before"))
	beforeId = max(beforeId, 0)

	rounds, nextBefore, err := listDegradationWatchRounds(visibility.filter(), beforeId, parseDegradationWatchRounds(c))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	for _, round := range rounds {
		round.Records = make([]degradationWatchRecordItem, 0, len(round.records))
		for _, record := range round.records {
			round.Records = append(round.Records, toDegradationWatchRecordItem(record, visibility.admin, visibility.aliases))
		}
		slices.SortStableFunc(round.Records, func(a, b degradationWatchRecordItem) int {
			return cmp.Compare(a.ChannelTitle, b.ChannelTitle)
		})
	}

	response := gin.H{
		"enabled":          operation_setting.GetDegradationWatchSetting().Enabled,
		"interval_minutes": operation_setting.ResolveDegradationWatchParams().IntervalMinutes,
		"rounds":           rounds,
		"next_before":      nextBefore,
	}
	if beforeId == 0 {
		lanes, err := buildDegradationWatchLanes(visibility)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		response["lanes"] = lanes
	}
	common.ApiSuccess(c, response)
}

// GetDegradationWatchRecordHtml 返回作品源码。前端只把它塞进
// sandbox="allow-scripts"（不带 allow-same-origin）的 iframe srcdoc，并在头部
// 注入 CSP，作品碰不到会话也发不出网络请求。
func GetDegradationWatchRecordHtml(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiErrorMsg(c, "invalid id")
		return
	}
	meta, err := model.GetDegradationWatchRecordMeta(id)
	if err != nil || !newDegradationWatchVisibility(c).canView(meta) {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "record not found"})
		return
	}
	html, err := model.GetDegradationWatchRecordHtml(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"html": html})
}

type degradationWatchPromptTarget struct {
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
}

// GetDegradationWatchPrompt 给「自测」用：提示词固定为后台这份，保证自测结果
// 和检测墙可比；模型下拉框的选项是启用中的目标。
func GetDegradationWatchPrompt(c *gin.Context) {
	targets := make([]degradationWatchPromptTarget, 0)
	for _, target := range operation_setting.ResolveDegradationWatchTargets() {
		if target.Enabled {
			targets = append(targets, degradationWatchPromptTarget{Model: target.Model, ReasoningEffort: target.ReasoningEffort})
		}
	}
	common.ApiSuccess(c, gin.H{
		"prompt":  operation_setting.GetDegradationWatchPrompt(),
		"targets": targets,
	})
}

type degradationWatchHiddenRequest struct {
	Hidden bool `json:"hidden"`
}

func SetDegradationWatchRecordHidden(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiErrorMsg(c, "invalid id")
		return
	}
	var req degradationWatchHiddenRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "invalid request body")
		return
	}
	if err := model.SetDegradationWatchRecordHidden(id, req.Hidden); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "record not found"})
			return
		}
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

type degradationWatchChannelItem struct {
	Id     int    `json:"id"`
	Name   string `json:"name"`
	Status int    `json:"status"`
	Alias  string `json:"alias"`
	// Models 是这个渠道能跑的目标模型（分组与模型都匹配、渠道启用）。
	Models    []string `json:"models"`
	LastRunAt int64    `json:"last_record_at"`
}

// The editor needs the live channel inventory before its draft targets are saved.
// Keep this response limited to selection metadata; never serialize Channel itself.
type degradationWatchAvailableChannel struct {
	Id     int      `json:"id"`
	Name   string   `json:"name"`
	Status int      `json:"status"`
	Groups []string `json:"groups"`
	Models []string `json:"models"`
}

// GetDegradationWatchChannels 列出所有目标分组里的渠道，给后台填别名、单测用。
// 别名是全局的，同一个渠道在所有目标之间共用。
func GetDegradationWatchChannels(c *gin.Context) {
	targets := operation_setting.ResolveDegradationWatchTargets()
	channels, err := model.GetAllChannels(0, 0, true, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	aliases := operation_setting.GetDegradationWatchChannelAliases()
	matched := make([]*model.Channel, 0)
	ids := make([]int, 0)
	available := make([]degradationWatchAvailableChannel, 0, len(channels))
	for _, channel := range channels {
		available = append(available, degradationWatchAvailableChannel{
			Id: channel.Id, Name: channel.Name, Status: channel.Status,
			Groups: channel.GetGroups(), Models: channel.GetModels(),
		})
		if slices.ContainsFunc(targets, func(target operation_setting.DegradationWatchTarget) bool {
			return slices.Contains(channel.GetGroups(), target.Group)
		}) {
			matched = append(matched, channel)
			ids = append(ids, channel.Id)
		}
	}
	stats, err := model.GetDegradationWatchChannelStats(ids)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items := make([]degradationWatchChannelItem, 0, len(matched))
	for _, channel := range matched {
		item := degradationWatchChannelItem{
			Id:     channel.Id,
			Name:   channel.Name,
			Status: channel.Status,
			Alias:  aliases[strconv.Itoa(channel.Id)],
			Models: make([]string, 0),
		}
		for _, target := range targets {
			if isDegradationWatchCandidate(channel, target.Group, target.Model) {
				item.Models = append(item.Models, target.Model)
			}
		}
		if stat := stats[channel.Id]; stat != nil {
			item.LastRunAt = stat.LastRecordAt
		}
		items = append(items, item)
	}
	common.ApiSuccess(c, gin.H{
		"targets":            targets,
		"channels":           items,
		"available_channels": available,
	})
}

type degradationWatchRunRequest struct {
	ChannelId int    `json:"channel_id"`
	Model     string `json:"model"`
}

// RunDegradationWatch 手动触发一轮：全部目标、单个目标，或单个目标的单个渠道。
// 已有一轮在跑时拒绝，免得管理员把正在跑的定时任务当成自己这次。
func RunDegradationWatch(c *gin.Context) {
	var req degradationWatchRunRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "invalid request body")
		return
	}
	payload := degradationWatchTaskPayload{ChannelId: req.ChannelId, Model: strings.TrimSpace(req.Model)}
	task, created, err := service.EnqueueSystemTask(model.SystemTaskTypeDegradationWatch, payload)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if !created {
		c.JSON(http.StatusConflict, gin.H{
			"success": false,
			"message": "已有一轮降智检测正在运行或等待中",
			"data":    gin.H{"task_id": task.TaskID, "status": task.Status},
		})
		return
	}
	common.ApiSuccess(c, gin.H{"task_id": task.TaskID, "status": task.Status})
}
