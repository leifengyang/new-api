package controller

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/tidwall/gjson"
)

const selfTestTaskType = "self_test_comparison"
const selfTestMaxResponse = 4 << 20

var selfTestClient = service.NewSelfTestHTTPClient()

// Use the same provider authentication for model discovery and generation.
func setSelfTestAuthentication(req *http.Request, protocol, key string) {
	if protocol == "anthropic" {
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
		return
	}
	req.Header.Set("Authorization", "Bearer "+key)
}

type selfTestHandler struct{}

func (selfTestHandler) Type() string            { return selfTestTaskType }
func (selfTestHandler) Interval() time.Duration { return 15 * time.Second }
func (selfTestHandler) NewPayload() any         { return nil }
func (selfTestHandler) Enabled() bool {
	var count int64
	return model.DB.Model(&model.SelfTestRound{}).Where("active_key IS NOT NULL").Count(&count).Error == nil && count > 0
}

// One leased dispatcher admits queued groups across accounts. Each round has its
// own concurrency budget; requests and mutations never own a background worker.
func (selfTestHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	err := model.DB.Model(&model.SelfTestAttempt{}).Where("status = ? AND runner <> ?", "running", task.TaskID).Updates(map[string]any{"status": "failed", "error": "Worker interrupted; retry this group", "secret": ""}).Error
	if err != nil {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, nil, err)
		return
	}
	ctx, cancel := context.WithCancel(ctx)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	done := make(chan int, 20)
	active := map[int]int{}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		var rounds []model.SelfTestRound
		if err = model.DB.Where("active_key IS NOT NULL").Order("id").Find(&rounds).Error; err != nil {
			break
		}
		for _, round := range rounds {
			if len(active) >= 20 {
				break
			}
			used := 0
			for _, roundID := range active {
				if roundID == round.ID {
					used++
				}
			}
			capacity := min(max(0, round.Concurrency-used), 20-len(active))
			if capacity > 0 {
				var queued []model.SelfTestAttempt
				if err = model.DB.Where("round_id = ? AND status = ?", round.ID, "queued").Order("id").Limit(capacity).Find(&queued).Error; err != nil {
					break
				}
				for _, attempt := range queued {
					claim := model.DB.Model(&attempt).Where("status = ?", "queued").Updates(map[string]any{"status": "running", "runner": task.TaskID, "started_at": time.Now().UnixMilli()})
					if claim.Error != nil {
						err = claim.Error
						break
					}
					if claim.RowsAffected == 0 {
						continue
					}
					active[attempt.ID] = round.ID
					workers.Go(func() {
						defer func() { done <- attempt.ID }()
						runSelfTestAttempt(ctx, round, attempt, task.TaskID)
					})
				}
			}
			if err != nil {
				break
			}
			if err = model.FinishSelfTestRound(round.ID); err != nil {
				break
			}
		}
		if err != nil || (len(rounds) == 0 && len(active) == 0) {
			break
		}
		select {
		case <-ctx.Done():
			err = ctx.Err()
		case id := <-done:
			delete(active, id)
		case <-ticker.C:
		}
		if err != nil {
			break
		}
	}
	status := model.SystemTaskStatusSucceeded
	cancel()
	workers.Wait()
	if err != nil {
		status = model.SystemTaskStatusFailed
	}
	finishSystemTaskHandler(task, runnerID, status, nil, err)
}

type selfTestStreamEvent struct {
	data  string
	err   error
	ended bool
}

// Scanner runs independently so quiet/reasoning-only streams still publish
// elapsed time, observe stop requests, and honor the whole-request deadline.
func readSelfTestEvents(ctx context.Context, body io.Reader, events chan<- selfTestStreamEvent) {
	defer close(events)
	scanner := bufio.NewScanner(io.LimitReader(body, selfTestMaxResponse+1))
	scanner.Buffer(make([]byte, 8192), selfTestMaxResponse+1)
	var data strings.Builder
	total := 0
	for scanner.Scan() {
		line := scanner.Text()
		total += len(line) + 1
		if total > selfTestMaxResponse {
			select {
			case events <- selfTestStreamEvent{err: errors.New("response exceeds 4 MiB limit")}:
			case <-ctx.Done():
			}
			return
		}
		if payload, ok := strings.CutPrefix(line, "data:"); ok {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimSpace(payload))
		}
		if line == "" && data.Len() > 0 {
			select {
			case events <- selfTestStreamEvent{data: data.String()}:
			case <-ctx.Done():
				return
			}
			data.Reset()
		}
	}
	if data.Len() > 0 {
		select {
		case events <- selfTestStreamEvent{data: data.String()}:
		case <-ctx.Done():
			return
		}
	}
	select {
	case events <- selfTestStreamEvent{err: scanner.Err(), ended: true}:
	case <-ctx.Done():
	}
}

func runSelfTestAttempt(parent context.Context, round model.SelfTestRound, attempt model.SelfTestAttempt, runner string) {
	ctx, cancel := context.WithTimeout(parent, time.Duration(round.TimeoutSeconds)*time.Second)
	defer cancel()
	started := time.Now()
	var raw bytes.Buffer
	key := ""
	var runErr error
	incomplete := false
	defer func() {
		if recovered := recover(); recovered != nil {
			runErr = errors.New("self-test worker failed unexpectedly")
		}
		attempt.ElapsedMs = time.Since(started).Milliseconds()
		attempt.Status = "succeeded"
		if runErr != nil {
			attempt.Status = "failed"
			if incomplete {
				attempt.Status = "incomplete"
			}
			attempt.Error = model.LongText(service.RedactSelfTestSecret(runErr.Error(), key))
		}
		attempt.Output = model.LongText(service.RedactSelfTestSecret(string(attempt.Output), key))
		attempt.HTML = model.LongText(service.RedactSelfTestSecret(string(attempt.HTML), key))
		updates := map[string]any{"status": attempt.Status, "error": attempt.Error, "output": attempt.Output, "html": attempt.HTML, "elapsed_ms": attempt.ElapsedMs, "first_token_ms": attempt.FirstTokenMs, "input_tokens": attempt.InputTokens, "output_tokens": attempt.OutputTokens, "reasoning_tokens": attempt.ReasoningTokens, "tokens_estimated": attempt.TokensEstimated}
		// A stopped task or a replacement lease owner always wins over late writes.
		if err := model.DB.Model(&model.SelfTestAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Updates(updates).Error; err != nil {
			common.SysError("self-test final result persistence failed")
		}
		if err := model.FinishSelfTestRound(round.ID); err != nil {
			common.SysError("self-test round finalization failed")
		}
	}()
	key, runErr = service.DecryptSelfTestKey(attempt.UserID, attempt.BaseURL+":"+attempt.Protocol, string(attempt.Secret))
	if runErr != nil {
		return
	}
	attempt.InputTokens = service.CountTextToken(string(round.Prompt), attempt.Model)
	attempt.TokensEstimated = true
	if err := model.DB.Model(&model.SelfTestAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Updates(map[string]any{"input_tokens": attempt.InputTokens, "tokens_estimated": true}).Error; err != nil {
		runErr = errors.New("could not save initial progress")
		return
	}
	payload := map[string]any{"model": attempt.Model, "stream": true}
	// Old attempts retain their original request semantics when retried.
	limit := attempt.MaxOutputTokens
	if limit == nil && attempt.Protocol == "anthropic" {
		legacyLimit := uint(8192)
		limit = &legacyLimit
	}
	path := "/chat/completions"
	if attempt.Protocol == "anthropic" {
		path = "/messages"
		payload["messages"] = []map[string]string{{"role": "user", "content": string(round.Prompt)}}
		payload["max_tokens"] = *limit
		if attempt.Effort != "" {
			payload["output_config"] = map[string]string{"effort": attempt.Effort}
		}
	} else if attempt.Protocol == "responses" {
		path = "/responses"
		payload["input"] = string(round.Prompt)
		if limit != nil {
			payload["max_output_tokens"] = *limit
		}
		if attempt.Effort != "" {
			payload["reasoning"] = map[string]any{"effort": attempt.Effort}
		}
	} else {
		payload["messages"] = []map[string]string{{"role": "user", "content": string(round.Prompt)}}
		payload["stream_options"] = map[string]bool{"include_usage": true}
		if limit != nil {
			payload["max_completion_tokens"] = *limit
		}
		if attempt.Effort != "" {
			payload["reasoning_effort"] = attempt.Effort
		}
	}
	encoded, runErr := common.Marshal(payload)
	if runErr != nil {
		return
	}
	req, runErr := http.NewRequestWithContext(ctx, http.MethodPost, attempt.BaseURL+path, bytes.NewReader(encoded))
	if runErr != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	setSelfTestAuthentication(req, attempt.Protocol, key)
	// Header wait must also remain cancellable through the database stop action.
	monitorDone := make(chan struct{})
	monitorExited := make(chan struct{})
	defer func() { close(monitorDone); <-monitorExited }()
	go func() {
		defer close(monitorExited)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-monitorDone:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				var state model.SelfTestAttempt
				if err := model.DB.Select("status", "runner").First(&state, attempt.ID).Error; err != nil || state.Status != "running" || state.Runner != runner {
					cancel()
					return
				}
				model.DB.Model(&model.SelfTestAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Update("elapsed_ms", time.Since(started).Milliseconds())
			}
		}
	}()
	res, runErr := selfTestClient.Do(req)
	if runErr != nil {
		return
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, err := io.ReadAll(io.LimitReader(res.Body, selfTestMaxResponse+1))
		if err != nil {
			runErr = err
			return
		}
		if len(body) > selfTestMaxResponse {
			body = append(body[:selfTestMaxResponse], []byte("\n[response truncated at 4 MiB]")...)
		}
		runErr = fmt.Errorf("HTTP %d %s\n%s", res.StatusCode, res.Status, string(body))
		return
	}
	if !strings.Contains(res.Header.Get("Content-Type"), "text/event-stream") {
		body, err := io.ReadAll(io.LimitReader(res.Body, selfTestMaxResponse+1))
		if err != nil {
			runErr = err
			return
		}
		if len(body) > selfTestMaxResponse {
			runErr = errors.New("response exceeds 4 MiB limit")
			return
		}
		// Some compatible endpoints ignore stream=true. Preserve their full diagnostic.
		if gjson.GetBytes(body, "error").Exists() {
			runErr = errors.New(string(body))
			return
		}
		if attempt.Protocol == "anthropic" {
			if !gjson.ValidBytes(body) || gjson.GetBytes(body, "type").String() != "message" {
				runErr = fmt.Errorf("invalid Anthropic response\n%s", body)
				return
			}
			compact, _ := common.Marshal(gjson.ParseBytes(body).Value())
			fmt.Fprintf(&raw, "data: %s\n\n", compact)
			attempt.FirstTokenMs = time.Since(started).Milliseconds()
			if gjson.GetBytes(body, "stop_reason").String() == "max_tokens" {
				incomplete = true
				runErr = fmt.Errorf("max_tokens: upstream reached the output limit (requested %d tokens)", *limit)
			}
		} else if attempt.Protocol == "responses" {
			response := gjson.ParseBytes(body)
			if response.Get("response").IsObject() {
				response = response.Get("response")
			}
			status := response.Get("status").String()
			if status == "" {
				status = "completed"
			}
			compact, _ := common.Marshal(map[string]any{"type": "response." + status, "response": response.Value()})
			fmt.Fprintf(&raw, "data: %s\n\n", compact)
			attempt.FirstTokenMs = max(1, time.Since(started).Milliseconds())
			if status := response.Get("status").String(); status == "incomplete" || status == "failed" || status == "cancelled" {
				incomplete = status == "incomplete"
				runErr = errors.New(string(body))
			}
		} else {
			text := gjson.GetBytes(body, "choices.0.message.content").String()
			if text == "" {
				runErr = fmt.Errorf("no output in upstream response\n%s", body)
				return
			}
			attempt.FirstTokenMs = time.Since(started).Milliseconds()
			usage := gjson.GetBytes(body, "usage").Raw
			if usage == "" {
				usage = "{}"
			}
			textJSON, _ := common.Marshal(text)
			fmt.Fprintf(&raw, "data: {\"choices\":[{\"delta\":{\"content\":%s}}],\"usage\":%s}\n\n", textJSON, usage)
			if gjson.GetBytes(body, "choices.0.finish_reason").String() == "length" {
				incomplete = true
				runErr = errors.New("max_output_tokens: upstream reached the output limit")
			}
		}
	} else {
		events := make(chan selfTestStreamEvent, 8)
		go readSelfTestEvents(ctx, res.Body, events)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		completed := false
		anthropicStopReason := ""
	streamLoop:
		for {
			select {
			case <-ctx.Done():
				runErr = ctx.Err()
				break streamLoop
			case event, ok := <-events:
				if !ok || event.ended {
					if event.err != nil {
						runErr = event.err
					}
					break streamLoop
				}
				if event.err != nil {
					runErr = event.err
					break streamLoop
				}
				if event.data == "[DONE]" {
					completed = attempt.Protocol != "anthropic"
					break streamLoop
				}
				if !gjson.Valid(event.data) {
					runErr = fmt.Errorf("invalid stream event\n%s", event.data)
					break streamLoop
				}
				obj := gjson.Parse(event.data)
				kind := obj.Get("type").String()
				// Terminal events carry the final output and usage even when incomplete.
				compact, _ := common.Marshal(obj.Value())
				fmt.Fprintf(&raw, "data: %s\n\n", compact)
				if obj.Get("error").Exists() || kind == "response.failed" || kind == "response.incomplete" || kind == "error" {
					incomplete = kind == "response.incomplete"
					runErr = errors.New(event.data)
					break streamLoop
				}
				if kind == "response.completed" || obj.Get("choices.0.finish_reason").String() != "" {
					completed = attempt.Protocol != "anthropic"
				}
				if obj.Get("choices.0.finish_reason").String() == "length" {
					incomplete = true
					runErr = errors.New("max_output_tokens: upstream reached the output limit")
				}
				if attempt.Protocol == "anthropic" {
					if reason := obj.Get("delta.stop_reason").String(); kind == "message_delta" && reason != "" {
						anthropicStopReason = reason
					}
					if kind == "message_stop" {
						completed = true
						if anthropicStopReason == "max_tokens" {
							incomplete = true
							runErr = fmt.Errorf("max_tokens: upstream reached the output limit (requested %d tokens)", *limit)
						}
						break streamLoop
					}
					if attempt.FirstTokenMs == 0 && (obj.Get("delta.text").String() != "" || obj.Get("delta.thinking").String() != "" || obj.Get("content_block.text").String() != "" || obj.Get("content_block.thinking").String() != "") {
						attempt.FirstTokenMs = max(1, time.Since(started).Milliseconds())
					}
				}
				if attempt.FirstTokenMs == 0 && (obj.Get("choices.0.delta.content").String() != "" || obj.Get("choices.0.delta.reasoning_content").String() != "" || strings.HasSuffix(kind, ".delta") && obj.Get("delta").String() != "") {
					attempt.FirstTokenMs = max(1, time.Since(started).Milliseconds())
				}
				if kind == "response.completed" {
					break streamLoop
				}
			case <-ticker.C:
				applySelfTestProgress(&attempt, raw.Bytes(), string(round.Prompt), started)
				output := service.RedactSelfTestSecret(string(attempt.Output), key)
				update := model.DB.Model(&model.SelfTestAttempt{}).Where("id = ? AND status = ? AND runner = ?", attempt.ID, "running", runner).Updates(map[string]any{"output": output, "input_tokens": attempt.InputTokens, "output_tokens": attempt.OutputTokens, "reasoning_tokens": attempt.ReasoningTokens, "tokens_estimated": attempt.TokensEstimated, "elapsed_ms": attempt.ElapsedMs, "first_token_ms": attempt.FirstTokenMs})
				if update.Error != nil {
					runErr = errors.New("could not save progress")
					break streamLoop
				}
			}
		}
		if runErr == nil && !completed {
			runErr = errors.New("upstream stream ended before completion")
		}
	}
	applySelfTestProgress(&attempt, raw.Bytes(), string(round.Prompt), started)
	if attempt.FirstTokenMs == 0 && attempt.Output != "" {
		attempt.FirstTokenMs = max(1, time.Since(started).Milliseconds())
	}
	if runErr != nil {
		return
	}
	output := string(attempt.Output)
	if strings.TrimSpace(output) == "" {
		runErr = errors.New("no output in upstream response")
		return
	}
	// Self-tests accept arbitrary prompts. HTML is an optional preview, not a
	// success requirement, and does not need the detection wall's SVG artwork.
	lower := strings.ToLower(output)
	start := strings.Index(lower, "<!doctype html")
	if start < 0 {
		start = strings.Index(lower, "<html")
	}
	end := strings.LastIndex(lower, "</html>")
	if start >= 0 && end >= start {
		attempt.HTML = model.LongText(output[start : end+len("</html>")])
	}
}

func applySelfTestProgress(attempt *model.SelfTestAttempt, raw []byte, prompt string, started time.Time) {
	if attempt.Protocol == "anthropic" {
		applyAnthropicSelfTestProgress(attempt, raw, prompt)
		attempt.ElapsedMs = time.Since(started).Milliseconds()
		return
	}
	progress := degradationWatchProgress(raw, prompt, attempt.Model)
	// A final Responses snapshot is authoritative; it may contain text missing
	// from deltas. Replace rather than append, so text is never duplicated.
	var snapshot strings.Builder
	hasOutputUsage := false
	for line := range bytes.SplitSeq(raw, []byte{'\n'}) {
		payload, ok := bytes.CutPrefix(bytes.TrimSpace(line), []byte("data:"))
		if !ok || !gjson.ValidBytes(bytes.TrimSpace(payload)) {
			continue
		}
		event := gjson.ParseBytes(payload)
		for _, field := range []string{"usage.output_tokens", "usage.completion_tokens", "response.usage.output_tokens", "response.usage.completion_tokens"} {
			hasOutputUsage = hasOutputUsage || event.Get(field).Type == gjson.Number
		}
		switch event.Get("type").String() {
		case "response.completed", "response.incomplete", "response.failed", "response.cancelled":
		default:
			continue
		}
		if response := event.Get("response"); response.Get("output").IsArray() {
			for _, item := range response.Get("output").Array() {
				for _, part := range item.Get("content").Array() {
					if part.Get("type").String() == "output_text" {
						snapshot.WriteString(part.Get("text").String())
					}
				}
			}
			if snapshot.Len() > 0 {
				progress.OutputText = model.LongText(snapshot.String())
			}
			snapshot.Reset()
		}
	}
	if !hasOutputUsage {
		progress.CompletionTokens = service.CountTextToken(string(progress.OutputText), attempt.Model)
	}
	attempt.Output, attempt.InputTokens, attempt.OutputTokens = progress.OutputText, progress.PromptTokens, progress.CompletionTokens
	attempt.ReasoningTokens, attempt.TokensEstimated = progress.ReasoningTokens, progress.TokensEstimated
	if progress.TokensEstimated {
		var reasoning strings.Builder
		for line := range bytes.SplitSeq(raw, []byte{'\n'}) {
			payload, ok := bytes.CutPrefix(bytes.TrimSpace(line), []byte("data:"))
			if !ok {
				continue
			}
			event := gjson.ParseBytes(payload)
			reasoning.WriteString(event.Get("choices.0.delta.reasoning_content").String())
			if event.Get("type").String() == "response.reasoning_text.delta" {
				reasoning.WriteString(event.Get("delta").String())
			}
		}
		if reasoning.Len() > 0 {
			attempt.ReasoningTokens = service.CountTextToken(reasoning.String(), attempt.Model)
			attempt.OutputTokens += attempt.ReasoningTokens
		}
	}
	attempt.ElapsedMs = time.Since(started).Milliseconds()
}

// Anthropic usage patches are cumulative and may omit the input fields after
// message_start. Preserve each last-reported counter instead of summing events.
// This is diagnostic display only; it never settles gateway quota.
func applyAnthropicSelfTestProgress(attempt *model.SelfTestAttempt, raw []byte, prompt string) {
	var text, thinking strings.Builder
	counts := map[string]int64{}
	for line := range bytes.SplitSeq(raw, []byte{'\n'}) {
		payload, ok := bytes.CutPrefix(bytes.TrimSpace(line), []byte("data:"))
		if !ok || !gjson.ValidBytes(bytes.TrimSpace(payload)) {
			continue
		}
		event := gjson.ParseBytes(payload)
		usage := event.Get("usage")
		switch event.Get("type").String() {
		case "message_start":
			usage = event.Get("message.usage")
		case "message":
			for _, block := range event.Get("content").Array() {
				if block.Get("type").String() == "text" {
					text.WriteString(block.Get("text").String())
				} else if block.Get("type").String() == "thinking" {
					thinking.WriteString(block.Get("thinking").String())
				}
			}
		case "content_block_start":
			block := event.Get("content_block")
			if block.Get("type").String() == "text" {
				text.WriteString(block.Get("text").String())
			} else if block.Get("type").String() == "thinking" {
				thinking.WriteString(block.Get("thinking").String())
			}
		case "content_block_delta":
			if event.Get("delta.type").String() == "text_delta" {
				text.WriteString(event.Get("delta.text").String())
			} else if event.Get("delta.type").String() == "thinking_delta" {
				thinking.WriteString(event.Get("delta.thinking").String())
			}
		}
		for _, field := range []string{"input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens", "output_tokens_details.thinking_tokens"} {
			if value := usage.Get(field); value.Type == gjson.Number {
				counts[field] = min(int64(math.MaxInt32), max(0, value.Int()))
			}
		}
	}
	input, hasInput := counts["input_tokens"]
	output, hasOutput := counts["output_tokens"]
	reasoning, hasReasoning := counts["output_tokens_details.thinking_tokens"]
	attempt.Output = model.LongText(text.String())
	attempt.InputTokens = service.CountTextToken(prompt, attempt.Model)
	attempt.ReasoningTokens = int(reasoning)
	if !hasReasoning && thinking.Len() > 0 {
		attempt.ReasoningTokens = service.CountTextToken(thinking.String(), attempt.Model)
	}
	attempt.OutputTokens = service.CountTextToken(text.String(), attempt.Model) + attempt.ReasoningTokens
	if hasInput {
		attempt.InputTokens = int(min(int64(math.MaxInt32), input+counts["cache_creation_input_tokens"]+counts["cache_read_input_tokens"]))
	}
	if hasOutput {
		// Anthropic's output_tokens already includes thinking tokens.
		attempt.OutputTokens = int(output)
	}
	attempt.TokensEstimated = !hasInput || !hasOutput || (!hasReasoning && thinking.Len() > 0)
}
