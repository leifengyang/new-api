package middleware

import (
	"fmt"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/logger"
	"github.com/gin-gonic/gin"
)

// ImageCaptchaCheck gates password authentication before credential processing.
// The answer belongs in the JSON body, never query parameters or logs.
func ImageCaptchaCheck(purpose string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var request struct {
			ID   string `json:"captcha_id"`
			Code string `json:"captcha_code"`
		}
		if c.ContentType() != gin.MIMEJSON || common.UnmarshalBodyReusable(c, &request) != nil {
			common.ApiErrorI18n(c, i18n.MsgInvalidParams)
			c.Abort()
			return
		}
		valid, err := common.VerifyImageCaptcha(c.Request.Context(), purpose, request.ID, request.Code)
		if err != nil {
			logger.LogError(c.Request.Context(), "image captcha store unavailable")
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": common.TranslateMessage(c, i18n.MsgRetryLater)})
			return
		}
		if !valid {
			logger.LogWarn(c.Request.Context(), fmt.Sprintf("image captcha rejected (purpose=%s, ip=%s)", purpose, c.ClientIP()))
			common.ApiErrorI18n(c, i18n.MsgCaptchaInvalid)
			c.Abort()
			return
		}
		c.Next()
	}
}

// A separate bucket prevents image refreshes from exhausting login attempts.
func ImageCaptchaRateLimit() gin.HandlerFunc {
	return rateLimitFactory(20, 60, "IC")
}
