package controller

import (
	"errors"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func GetLogRequestPrompt(c *gin.Context) {
	id := c.Query("request_id")
	if id == "" || len(id) > 64 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "Invalid request ID"})
		return
	}
	prompt, err := model.GetRequestPrompt(id, common.GetTimestamp())
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"status": "unavailable"}})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "Unable to load request prompt"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": prompt})
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
