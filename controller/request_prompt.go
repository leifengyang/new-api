package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

func GetLogRequestPrompt(c *gin.Context) {
	// Keep an explicit tombstone for older clients. Saved prompts are only
	// available through database investigation, never through an HTTP response.
	c.JSON(http.StatusGone, gin.H{"success": false, "message": "Request prompt viewing is disabled"})
}

func GetRequestPromptCapture(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"enabled": model.RequestPromptCaptureEnabled()}})
}

func UpdateRequestPromptCapture(c *gin.Context) {
	var request struct {
		Enabled *bool `json:"enabled"`
	}
	if err := common.DecodeJson(c.Request.Body, &request); err != nil || request.Enabled == nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "Invalid capture setting"})
		return
	}
	value := "false"
	if *request.Enabled {
		value = "true"
	}
	if err := model.UpdateOptionsBulk(map[string]string{model.RequestPromptCaptureKey: value}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "Unable to save capture setting"})
		return
	}
	GetRequestPromptCapture(c)
}
