package controller

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
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
	defer func() {
		if recovered := recover(); recovered != nil {
			runErr = errors.New("self-test worker failed unexpectedly")
		}
		attempt.ElapsedMs = time.Since(started).Milliseconds()
		attempt.Status = "succeeded"
		if runErr != nil {
			attempt.Status = "failed"
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
	path := "/chat/completions"
	if attempt.Protocol == "responses" {
		path = "/responses"
		payload["input"] = string(round.Prompt)
		if attempt.Effort != "" {
			payload["reasoning"] = map[string]any{"effort": attempt.Effort}
		}
	} else {
		payload["messages"] = []map[string]string{{"role": "user", "content": string(round.Prompt)}}
		payload["stream_options"] = map[string]bool{"include_usage": true}
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
	req.Header.Set("Authorization", "Bearer "+key)
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
		text := gjson.GetBytes(body, "choices.0.message.content").String()
		if attempt.Protocol == "responses" {
			for _, item := range gjson.GetBytes(body, "output").Array() {
				for _, content := range item.Get("content").Array() {
					text += content.Get("text").String()
				}
			}
		}
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
	} else {
		events := make(chan selfTestStreamEvent, 8)
		go readSelfTestEvents(ctx, res.Body, events)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		completed := false
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
					completed = true
					break streamLoop
				}
				if !gjson.Valid(event.data) {
					runErr = fmt.Errorf("invalid stream event\n%s", event.data)
					break streamLoop
				}
				obj := gjson.Parse(event.data)
				kind := obj.Get("type").String()
				if obj.Get("error").Exists() || kind == "response.failed" || kind == "response.incomplete" || kind == "error" {
					runErr = errors.New(event.data)
					break streamLoop
				}
				if kind == "response.completed" || obj.Get("choices.0.finish_reason").String() != "" {
					completed = true
				}
				if attempt.FirstTokenMs == 0 && (obj.Get("choices.0.delta.content").String() != "" || obj.Get("choices.0.delta.reasoning_content").String() != "" || strings.HasSuffix(kind, ".delta") && obj.Get("delta").String() != "") {
					attempt.FirstTokenMs = max(1, time.Since(started).Milliseconds())
				}
				compact, _ := common.Marshal(obj.Value())
				fmt.Fprintf(&raw, "data: %s\n\n", compact)
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
	progress := degradationWatchProgress(raw, prompt, attempt.Model)
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
