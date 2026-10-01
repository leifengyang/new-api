package controller

import (
	"bytes"
	"io"
	"math"
	"net/http/httptest"
	"strings"
	"sync"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/tidwall/gjson"
)

// Adaptors can write from their streaming worker and heartbeat goroutines.
// Snapshot readers must not race the recorder's bytes.Buffer.
type degradationWatchStreamRecorder struct {
	*httptest.ResponseRecorder
	mu sync.Mutex
}

type degradationWatchResponseBody struct {
	io.ReadCloser
	recorder *degradationWatchStreamRecorder
}

func (body *degradationWatchResponseBody) Read(p []byte) (int, error) {
	n, err := body.ReadCloser.Read(p)
	if n > 0 {
		_, _ = body.recorder.Write(p[:n])
	}
	return n, err
}

func (w *degradationWatchStreamRecorder) Write(body []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.ResponseRecorder.Write(body)
}
func (w *degradationWatchStreamRecorder) WriteString(body string) (int, error) {
	return w.Write([]byte(body))
}
func (w *degradationWatchStreamRecorder) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.ResponseRecorder.Flush()
}
func (w *degradationWatchStreamRecorder) WriteHeader(code int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.ResponseRecorder.WriteHeader(code)
}
func (w *degradationWatchStreamRecorder) snapshot() []byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return bytes.Clone(w.Body.Bytes())
}

// Estimates are display-only. Final provider usage replaces these counters;
// this path never consumes quota or writes a billing log.
func degradationWatchProgress(body []byte, prompt, modelName string) model.DegradationWatchRecord {
	text := collectDegradationWatchStreamText(body)
	record := model.DegradationWatchRecord{OutputText: model.LongText(text), PromptTokens: service.CountTextToken(prompt, modelName), CompletionTokens: service.CountTextToken(text, modelName), TokensEstimated: true}
	for line := range bytes.SplitSeq(body, []byte{'\n'}) {
		payload, ok := bytes.CutPrefix(bytes.TrimSpace(line), []byte("data:"))
		if !ok || !gjson.ValidBytes(bytes.TrimSpace(payload)) {
			continue
		}
		event := gjson.ParseBytes(payload)
		usage := event.Get("usage")
		if !usage.Exists() {
			usage = event.Get("response.usage")
		}
		if !usage.IsObject() {
			continue
		}
		input, output := usage.Get("prompt_tokens"), usage.Get("completion_tokens")
		if !input.Exists() {
			input = usage.Get("input_tokens")
		}
		if !output.Exists() {
			output = usage.Get("output_tokens")
		}
		if input.Exists() {
			record.PromptTokens = int(min(int64(math.MaxInt32), max(0, input.Int())))
		}
		if output.Exists() {
			record.CompletionTokens = int(min(int64(math.MaxInt32), max(0, output.Int())))
		}
		record.ReasoningTokens = int(min(int64(math.MaxInt32), max(0, usage.Get("completion_tokens_details.reasoning_tokens").Int(), usage.Get("output_tokens_details.reasoning_tokens").Int())))
		record.TokensEstimated = !input.Exists() || !output.Exists()
	}
	return record
}

func redactDegradationWatchError(message string, channel *model.Channel) string {
	// Keep the complete diagnostic while removing usable channel credentials.
	for _, key := range append([]string{channel.Key}, channel.GetKeys()...) {
		if key = strings.TrimSpace(key); key != "" {
			if gjson.Valid(key) {
				for _, field := range []string{"access_token", "refresh_token", "id_token", "private_key", "client_secret", "api_key"} {
					if value := gjson.Get(key, field).String(); value != "" {
						message = strings.ReplaceAll(message, value, "[REDACTED]")
					}
				}
			}
			message = strings.ReplaceAll(message, key, "[REDACTED]")
		}
	}
	return message
}
