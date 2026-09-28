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
	// degradationWatchConcurrency 限制同时在画的渠道数。每个请求都要跑一两分钟，
	// 串行会让一批渠道挤不进单次运行的时限。
	degradationWatchConcurrency = 4
	degradationWatchDefaultPage = 12
	degradationWatchMaxPage     = 60
)

// degradationWatchHandler 按后台配置的间隔调度一轮降智检测。
type degradationWatchHandler struct{}

func (degradationWatchHandler) Type() string { return model.SystemTaskTypeDegradationWatch }

func (degradationWatchHandler) Enabled() bool {
	return operation_setting.GetDegradationWatchSetting().Enabled
}

func (degradationWatchHandler) Interval() time.Duration {
	_, _, _, intervalMinutes, _, _ := operation_setting.ResolveDegradationWatchParams()
	return time.Duration(intervalMinutes) * time.Minute
}

func (degradationWatchHandler) NewPayload() any { return nil }

// degradationWatchTaskPayload 为空表示整组检测；ChannelId > 0 是后台「立即检测
// 一次」只测这一个渠道。
type degradationWatchTaskPayload struct {
	ChannelId int `json:"channel_id,omitempty"`
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
	summary, err := runDegradationWatchTask(ctx, payload.ChannelId, service.NewSystemTaskProgressReporter(task, runnerID))
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

func runDegradationWatchTask(ctx context.Context, onlyChannelId int, report func(processed, total int)) (degradationWatchSummary, error) {
	summary := degradationWatchSummary{}
	group, modelName, effort, _, timeoutSeconds, retention := operation_setting.ResolveDegradationWatchParams()
	prompt := operation_setting.GetDegradationWatchPrompt()

	testUserID, err := resolveChannelTestUserID(nil)
	if err != nil {
		return summary, err
	}
	channels, err := model.GetAllChannels(0, 0, true, false)
	if err != nil {
		return summary, err
	}
	selected := make([]*model.Channel, 0)
	for _, channel := range channels {
		if onlyChannelId > 0 && channel.Id != onlyChannelId {
			continue
		}
		if isDegradationWatchCandidate(channel, group, modelName) {
			selected = append(selected, channel)
		}
	}
	if onlyChannelId > 0 && len(selected) == 0 {
		return summary, fmt.Errorf("channel %d is not enabled, not in group %s, or does not serve model %s", onlyChannelId, group, modelName)
	}

	batchCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	var (
		mu        sync.Mutex
		wg        sync.WaitGroup
		processed int
	)
	sem := make(chan struct{}, degradationWatchConcurrency)
	if report != nil {
		report(0, len(selected))
	}
	for _, channel := range selected {
		wg.Add(1)
		sem <- struct{}{}
		go func(channel *model.Channel) {
			defer wg.Done()
			defer func() { <-sem }()
			record := drawDegradationWatch(batchCtx, channel, testUserID, modelName, effort, prompt)
			// 父 ctx 被取消说明租约丢了，这一轮不作数；只有撞上本轮时限才记成超时失败。
			if ctx.Err() != nil {
				return
			}
			if err := model.CreateDegradationWatchRecord(record); err != nil {
				common.SysError(fmt.Sprintf("degradation watch: failed to save record for channel %d: %v", channel.Id, err))
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
				report(processed, len(selected))
			}
		}(channel)
	}
	wg.Wait()

	// 裁剪覆盖表里出现过的所有渠道：移出分组的渠道也不能无限留着旧作品。
	recorded, err := model.GetDegradationWatchRecordedChannelIds()
	if err != nil {
		return summary, err
	}
	for _, channelId := range recorded {
		pruned, err := model.PruneDegradationWatchRecords(channelId, retention)
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
	Id               int    `json:"id"`
	ModelName        string `json:"model_name"`
	ReasoningEffort  string `json:"reasoning_effort"`
	Success          bool   `json:"success"`
	FailureReason    string `json:"failure_reason"`
	ElapsedMs        int64  `json:"elapsed_ms"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	ReasoningTokens  int    `json:"reasoning_tokens"`
	Hidden           bool   `json:"hidden"`
	CreatedAt        int64  `json:"created_at"`
}

func toDegradationWatchRecordItem(record *model.DegradationWatchRecord, admin bool) degradationWatchRecordItem {
	reason := record.FailureReason
	if !admin && reason != "" && !slices.Contains(degradationWatchReasonCodes, reason) {
		reason = degradationWatchReasonUpstream
	}
	return degradationWatchRecordItem{
		Id:               record.Id,
		ModelName:        record.ModelName,
		ReasoningEffort:  record.ReasoningEffort,
		Success:          record.Success,
		FailureReason:    reason,
		ElapsedMs:        record.ElapsedMs,
		PromptTokens:     record.PromptTokens,
		CompletionTokens: record.CompletionTokens,
		ReasoningTokens:  record.ReasoningTokens,
		Hidden:           record.Hidden,
		CreatedAt:        record.CreatedAt,
	}
}

type degradationWatchSection struct {
	// Title 对普通用户是后台配的别名；管理员看没配别名的渠道时是渠道名。
	Title string `json:"title"`
	// ChannelId / ChannelName / Aliased 只回给管理员。
	ChannelId   int    `json:"channel_id,omitempty"`
	ChannelName string `json:"channel_name,omitempty"`
	Aliased     bool   `json:"aliased"`

	Total        int64                        `json:"total"`
	Succeeded    int64                        `json:"succeeded"`
	Visible      int64                        `json:"visible"`
	LastRecordAt int64                        `json:"last_record_at"`
	Records      []degradationWatchRecordItem `json:"records"`
}

// canViewDegradationWatchChannel：普通用户只能看配了别名的渠道。
func canViewDegradationWatchChannel(c *gin.Context, channelId int) bool {
	if isDegradationWatchAdmin(c) {
		return true
	}
	_, ok := operation_setting.GetDegradationWatchChannelAliases()[strconv.Itoa(channelId)]
	return ok
}

func parseDegradationWatchLimit(c *gin.Context) int {
	limit, err := strconv.Atoi(c.Query("limit"))
	if err != nil || limit <= 0 {
		return degradationWatchDefaultPage
	}
	return min(limit, degradationWatchMaxPage)
}

// GetDegradationWatchWall 返回检测墙：每个可见渠道一节，带统计和最新一页记录。
func GetDegradationWatchWall(c *gin.Context) {
	admin := isDegradationWatchAdmin(c)
	limit := parseDegradationWatchLimit(c)
	aliases := operation_setting.GetDegradationWatchChannelAliases()

	channelIds := make([]int, 0, len(aliases))
	if admin {
		recorded, err := model.GetDegradationWatchRecordedChannelIds()
		if err != nil {
			common.ApiError(c, err)
			return
		}
		channelIds = append(channelIds, recorded...)
	}
	for id := range aliases {
		if channelId, err := strconv.Atoi(id); err == nil && channelId > 0 {
			channelIds = append(channelIds, channelId)
		}
	}
	slices.Sort(channelIds)
	channelIds = slices.Compact(channelIds)

	stats, err := model.GetDegradationWatchChannelStats(channelIds)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	sections := make([]degradationWatchSection, 0, len(channelIds))
	for _, channelId := range channelIds {
		alias, aliased := aliases[strconv.Itoa(channelId)]
		section := degradationWatchSection{Title: alias, Aliased: aliased}
		if admin {
			section.ChannelId = channelId
			if channel, err := model.CacheGetChannel(channelId); err == nil && channel != nil {
				section.ChannelName = channel.Name
			}
			if !aliased {
				section.Title = section.ChannelName
				if section.Title == "" {
					section.Title = fmt.Sprintf("#%d", channelId)
				}
			}
		}
		if stat := stats[channelId]; stat != nil {
			section.Total = stat.Total
			section.Succeeded = stat.Succeeded
			section.Visible = stat.Visible
			section.LastRecordAt = stat.LastRecordAt
		}
		records, err := model.ListDegradationWatchRecords(channelId, 0, limit, admin)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		section.Records = make([]degradationWatchRecordItem, 0, len(records))
		for _, record := range records {
			section.Records = append(section.Records, toDegradationWatchRecordItem(record, admin))
		}
		sections = append(sections, section)
	}
	// 最近有新作品的渠道排前面。
	slices.SortStableFunc(sections, func(a, b degradationWatchSection) int {
		return cmp.Compare(b.LastRecordAt, a.LastRecordAt)
	})

	_, modelName, effort, intervalMinutes, _, _ := operation_setting.ResolveDegradationWatchParams()
	common.ApiSuccess(c, gin.H{
		"enabled":          operation_setting.GetDegradationWatchSetting().Enabled,
		"model":            modelName,
		"reasoning_effort": effort,
		"interval_minutes": intervalMinutes,
		"sections":         sections,
	})
}

// GetDegradationWatchRecords 是「查看更多」：返回与 before 同一渠道、比它更早的记录。
// 用记录 id 当游标，普通用户全程拿不到渠道 id。
func GetDegradationWatchRecords(c *gin.Context) {
	beforeId, err := strconv.Atoi(c.Query("before"))
	if err != nil || beforeId <= 0 {
		common.ApiErrorMsg(c, "invalid before")
		return
	}
	anchor, err := model.GetDegradationWatchRecordMeta(beforeId)
	if err != nil || !canViewDegradationWatchChannel(c, anchor.ChannelId) {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "record not found"})
		return
	}
	admin := isDegradationWatchAdmin(c)
	records, err := model.ListDegradationWatchRecords(anchor.ChannelId, beforeId, parseDegradationWatchLimit(c), admin)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items := make([]degradationWatchRecordItem, 0, len(records))
	for _, record := range records {
		items = append(items, toDegradationWatchRecordItem(record, admin))
	}
	common.ApiSuccess(c, items)
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
	if err != nil || !canViewDegradationWatchChannel(c, meta.ChannelId) || (meta.Hidden && !isDegradationWatchAdmin(c)) {
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

// GetDegradationWatchPrompt 给「自测」用：提示词固定为后台这份，保证自测结果
// 和检测墙可比。
func GetDegradationWatchPrompt(c *gin.Context) {
	_, modelName, effort, _, _, _ := operation_setting.ResolveDegradationWatchParams()
	common.ApiSuccess(c, gin.H{
		"prompt":           operation_setting.GetDegradationWatchPrompt(),
		"model":            modelName,
		"reasoning_effort": effort,
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
	Id        int    `json:"id"`
	Name      string `json:"name"`
	Status    int    `json:"status"`
	HasModel  bool   `json:"has_model"`
	Eligible  bool   `json:"eligible"`
	Alias     string `json:"alias"`
	LastRunAt int64  `json:"last_record_at"`
}

// GetDegradationWatchChannels 列出检测分组里的所有渠道，给后台填别名用。
func GetDegradationWatchChannels(c *gin.Context) {
	group, modelName, _, _, _, _ := operation_setting.ResolveDegradationWatchParams()
	channels, err := model.GetAllChannels(0, 0, true, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	aliases := operation_setting.GetDegradationWatchChannelAliases()
	inGroup := make([]*model.Channel, 0)
	ids := make([]int, 0)
	for _, channel := range channels {
		if slices.Contains(channel.GetGroups(), group) {
			inGroup = append(inGroup, channel)
			ids = append(ids, channel.Id)
		}
	}
	stats, err := model.GetDegradationWatchChannelStats(ids)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items := make([]degradationWatchChannelItem, 0, len(inGroup))
	for _, channel := range inGroup {
		item := degradationWatchChannelItem{
			Id:     channel.Id,
			Name:   channel.Name,
			Status: channel.Status,
			HasModel: slices.ContainsFunc(channel.GetModels(), func(m string) bool {
				return strings.TrimSpace(m) == modelName
			}),
			Eligible: isDegradationWatchCandidate(channel, group, modelName),
			Alias:    aliases[strconv.Itoa(channel.Id)],
		}
		if stat := stats[channel.Id]; stat != nil {
			item.LastRunAt = stat.LastRecordAt
		}
		items = append(items, item)
	}
	common.ApiSuccess(c, gin.H{
		"group":    group,
		"model":    modelName,
		"channels": items,
	})
}

type degradationWatchRunRequest struct {
	ChannelId int `json:"channel_id"`
}

// RunDegradationWatch 手动触发一轮（或只测一个渠道）。已有一轮在跑时拒绝，
// 免得管理员把正在跑的定时任务当成自己这次。
func RunDegradationWatch(c *gin.Context) {
	var req degradationWatchRunRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "invalid request body")
		return
	}
	task, created, err := service.EnqueueSystemTask(model.SystemTaskTypeDegradationWatch, degradationWatchTaskPayload{ChannelId: req.ChannelId})
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
