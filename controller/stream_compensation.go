package controller

import (
	"context"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

type streamCompensationHandler struct{}

func (streamCompensationHandler) Type() string            { return model.StreamCompensationTaskType }
func (streamCompensationHandler) Interval() time.Duration { return 5 * time.Minute }
func (streamCompensationHandler) NewPayload() any         { return nil }
func (streamCompensationHandler) Enabled() bool {
	cfg, err := model.GetStreamCompensationConfig()
	if err != nil || !cfg.Enabled {
		return false
	}
	if cfg.SettledUntil < model.CompensationCutoff(time.Now()) {
		return true
	}
	var failed model.StreamCompensation
	result := model.DB.Where("status = ?", "failed").Limit(1).Find(&failed)
	return result.Error == nil && result.RowsAffected > 0
}
func (streamCompensationHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	err := service.RunStreamCompensation(ctx, time.Now())
	status := model.SystemTaskStatusSucceeded
	if err != nil {
		status = model.SystemTaskStatusFailed
	}
	finishSystemTaskHandler(task, runnerID, status, nil, err)
}

func GetStreamCompensationSettings(c *gin.Context) {
	cfg, err := model.GetStreamCompensationConfig()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, cfg)
}
func UpdateStreamCompensationSettings(c *gin.Context) {
	var req struct {
		Enabled *bool `json:"enabled"`
	}
	if c.ShouldBindJSON(&req) != nil || req.Enabled == nil {
		common.ApiErrorMsg(c, "enabled is required")
		return
	}
	if err := model.SetStreamCompensationEnabled(*req.Enabled); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}
func StartStreamCompensation(c *gin.Context) {
	task, _, err := service.EnqueueSystemTask(model.StreamCompensationTaskType, nil)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, task)
}

func GetStreamCompensations(c *gin.Context) {
	userID := c.GetInt("id")
	if c.GetBool("compensation_admin") {
		userID, _ = strconv.Atoi(c.Query("user_id"))
		if userID < 0 {
			userID = 0
		}
	}
	page := common.GetPageQuery(c)
	batchID, _ := strconv.ParseInt(c.Query("batch_id"), 10, 64)
	start, _ := strconv.ParseInt(c.Query("start_at"), 10, 64)
	end, _ := strconv.ParseInt(c.Query("end_at"), 10, 64)
	items, total, totals, err := model.ListStreamCompensations(userID, c.Query("status"), batchID, start, end, page.GetStartIdx(), page.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": total, "totals": totals})
}

func GetStreamCompensationBatches(c *gin.Context) {
	page := common.GetPageQuery(c)
	items := []model.StreamCompensationBatch{}
	var count int64
	if err := model.DB.Model(&model.StreamCompensationBatch{}).Count(&count).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.DB.Order("id DESC").Offset(page.GetStartIdx()).Limit(page.GetPageSize()).Find(&items).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": count})
}

func ReviewStreamCompensation(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	var req struct {
		Approve *bool `json:"approve"`
	}
	if err != nil || id <= 0 || c.ShouldBindJSON(&req) != nil || req.Approve == nil {
		common.ApiErrorMsg(c, "invalid review")
		return
	}
	if err := model.CreditStreamCompensation(c.Request.Context(), id, c.GetInt("id"), *req.Approve); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

func GetStreamCompensationMessages(c *gin.Context) {
	page := common.GetPageQuery(c)
	items, total, err := model.ListStreamCompensationMessages(c.GetInt("id"), c.Query("unread") == "true", page.GetStartIdx(), page.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": total})
}
func ReadStreamCompensationMessage(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	var req struct {
		Revision int64 `json:"revision"`
	}
	if err != nil || c.ShouldBindJSON(&req) != nil {
		common.ApiErrorMsg(c, "invalid notification")
		return
	}
	if err := model.MarkStreamCompensationMessageRead(c.GetInt("id"), id, req.Revision); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}
