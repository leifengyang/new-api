package service

import (
	"context"
	"io"
	"mime"
	"mime/multipart"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/tidwall/gjson"
)

const MaxRequestPromptBytes = 128 * 1024

// A bounded queue prevents database outages from holding relay requests open
// or spawning unbounded goroutines. It never retains a Gin context or raw body.
type requestPromptJob struct {
	prompt    *model.RequestPrompt
	rejection *model.Log
	done      chan struct{}
}

var requestPromptWriter = sync.OnceValue(func() chan requestPromptJob {
	queue := make(chan requestPromptJob, 64)
	go func() {
		for job := range queue {
			if job.done != nil {
				close(job.done)
				continue
			}
			if err := model.SaveRequestPrompt(job.prompt); err != nil {
				common.SysError("request prompt storage failed")
			}
			if job.rejection != nil && model.LOG_DB != nil {
				if err := model.RecordUnloggedPromptRejection(job.rejection); err != nil {
					common.SysError("request prompt rejection log failed")
				}
			}
		}
	}()
	return queue
})

func QueueRequestPrompt(prompt *model.RequestPrompt, rejection *model.Log) {
	select {
	case requestPromptWriter() <- requestPromptJob{prompt: prompt, rejection: rejection}:
	default:
		common.SysError("request prompt storage queue full")
	}
}

// FlushRequestPrompts drains accepted writes during graceful shutdown.
func FlushRequestPrompts(ctx context.Context) error {
	done := make(chan struct{})
	select {
	case requestPromptWriter() <- requestPromptJob{done: done}:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ExtractRequestPrompt accepts only explicit user-input fields. It must never
// stringify arbitrary content blocks: those may contain tool output, history,
// attachment URLs or inline binary data.
func ExtractRequestPrompt(body []byte) model.RequestPrompt {
	prompt := model.RequestPrompt{Status: "no_user_message"}
	if !gjson.ValidBytes(body) {
		prompt.Status = "invalid_body"
		return prompt
	}
	root := gjson.ParseBytes(body)
	var content gjson.Result
	switch {
	case root.Get("messages").IsArray():
		root.Get("messages").ForEach(func(_, message gjson.Result) bool {
			if message.Get("role").String() == "user" {
				content = message.Get("content")
			}
			return true
		})
	case root.Get("contents").IsArray():
		root.Get("contents").ForEach(func(_, message gjson.Result) bool {
			role := message.Get("role").String()
			if role == "user" || role == "" {
				content = message.Get("parts")
			}
			return true
		})
	case root.Get("input").Type == gjson.String:
		content = root.Get("input")
	case root.Get("input").IsArray():
		root.Get("input").ForEach(func(_, message gjson.Result) bool {
			role, kind := message.Get("role").String(), message.Get("type").String()
			if role == "user" && (kind == "" || kind == "message") {
				content = message.Get("content")
			}
			return true
		})
	case root.Get("prompt").Type == gjson.String:
		content = root.Get("prompt")
	case root.Get("query").Type == gjson.String:
		content = root.Get("query")
	}
	var text strings.Builder
	attachments := []string{}
	if content.Type == gjson.String {
		text.WriteString(content.String())
	} else if content.IsArray() {
		content.ForEach(func(_, part gjson.Result) bool {
			kind := part.Get("type").String()
			attachment := ""
			switch kind {
			case "text", "input_text", "":
				// Gemini parts have no type. functionResponse/functionCall and
				// Anthropic tool_result blocks are intentionally not traversed.
				if value := part.Get("text"); value.Type == gjson.String {
					if text.Len() > 0 {
						text.WriteByte('\n')
					}
					text.WriteString(value.String())
				}
			case "image", "image_url", "input_image":
				attachment = "image"
			case "audio", "input_audio":
				attachment = "audio"
			case "file", "input_file", "document":
				attachment = "file"
			case "video", "video_url", "input_video":
				attachment = "video"
			}
			for _, key := range []string{"inlineData", "fileData", "inline_data", "file_data"} {
				if data := part.Get(key); data.Exists() {
					mimeType := data.Get("mimeType").String()
					if mimeType == "" {
						mimeType = data.Get("mime_type").String()
					}
					attachment = "file"
					for _, category := range []string{"image", "audio", "video"} {
						if strings.HasPrefix(mimeType, category+"/") {
							attachment = category
						}
					}
				}
			}
			if attachment != "" && !slices.Contains(attachments, attachment) {
				attachments = append(attachments, attachment)
			}
			return true
		})
	}
	prompt.Text, prompt.Truncated = BoundRequestPrompt(text.String())
	prompt.Attachments = strings.Join(attachments, ",")
	if prompt.Text != "" || prompt.Attachments != "" {
		prompt.Status = "captured"
	}
	return prompt
}

func BoundRequestPrompt(text string) (string, bool) {
	if len(text) <= MaxRequestPromptBytes {
		return text, false
	}
	const marker = "\n\n[…]\n\n"
	budget := (MaxRequestPromptBytes - len(marker)) / 2
	head, tail := budget, len(text)-budget
	for head > 0 && !utf8.RuneStart(text[head]) {
		head--
	}
	for tail < len(text) && !utf8.RuneStart(text[tail]) {
		tail++
	}
	return text[:head] + marker + text[tail:], true
}

func ExtractMultipartRequestPrompt(reader io.Reader, contentType string) model.RequestPrompt {
	prompt := model.RequestPrompt{Status: "no_user_message"}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		prompt.Status = "invalid_body"
		return prompt
	}
	multipartReader := multipart.NewReader(reader, params["boundary"])
	for {
		part, err := multipartReader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			prompt.Status = "invalid_body"
			return prompt
		}
		if part.FileName() != "" {
			prompt.Attachments = "file"
		} else if part.FormName() == "prompt" || part.FormName() == "input" {
			// Request bodies already have the gateway's overall size limit.
			value, err := io.ReadAll(part)
			if err != nil {
				prompt.Status = "invalid_body"
				return prompt
			}
			prompt.Text, prompt.Truncated = BoundRequestPrompt(string(value))
		}
		_ = part.Close()
	}
	if prompt.Text != "" || prompt.Attachments != "" {
		prompt.Status = "captured"
	}
	return prompt
}
