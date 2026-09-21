package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/gin-gonic/gin"
)

func GetImageCaptcha(c *gin.Context) {
	purpose := c.Query("purpose")
	if purpose != "login" && purpose != "register" {
		common.ApiErrorI18n(c, i18n.MsgInvalidParams)
		return
	}
	id, image, err := common.CreateImageCaptcha(c.Request.Context(), purpose)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": common.TranslateMessage(c, i18n.MsgRetryLater)})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"captcha_id": id,
			"image":      image,
			"expires_in": int(common.ImageCaptchaTTL.Seconds()),
		},
	})
}
