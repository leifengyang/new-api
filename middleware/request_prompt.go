package middleware

import (
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// Runs after authentication and before request/channel transformations.
func CaptureRequestPrompt() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Method != http.MethodPost || c.GetInt("id") <= 0 {
			c.Next()
			return
		}
		prompt := model.RequestPrompt{RequestID: c.GetString(common.RequestIdKey), CreatedAt: common.GetTimestamp(), Status: "disabled"}
		if model.RequestPromptCaptureEnabled() {
			prompt.Status = "unsupported_format"
			storage, err := common.GetBodyStorage(c)
			if err == nil {
				contentType := c.GetHeader("Content-Type")
				var extracted model.RequestPrompt
				if strings.HasPrefix(contentType, "multipart/form-data") {
					extracted = service.ExtractMultipartRequestPrompt(storage, contentType)
				} else {
					body, readErr := storage.Bytes()
					if readErr == nil {
						extracted = service.ExtractRequestPrompt(body)
					} else {
						extracted.Status = "invalid_body"
					}
				}
				extracted.RequestID, extracted.CreatedAt = prompt.RequestID, prompt.CreatedAt
				prompt = extracted
				_, _ = storage.Seek(0, io.SeekStart)
				c.Request.Body = io.NopCloser(storage)
			} else {
				prompt.Status = "invalid_body"
			}
		}
		c.Next()
		if prompt.RequestID == "" {
			return
		}
		var rejection *model.Log
		if prompt.Status != "disabled" && c.Writer.Status() >= 400 {
			rejection = &model.Log{
				RequestId: prompt.RequestID, CreatedAt: prompt.CreatedAt, Type: model.LogTypeError,
				UserId: c.GetInt("id"), Username: c.GetString("username"), TokenId: c.GetInt("token_id"), TokenName: c.GetString("token_name"),
				ModelName: c.GetString("original_model"), ChannelId: c.GetInt("channel_id"), Group: c.GetString("group"),
				Content: fmt.Sprintf("Request rejected (HTTP %d)", c.Writer.Status()),
			}
		}
		service.QueueRequestPrompt(&prompt, rejection)
	}
}
