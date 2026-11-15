package controller

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type championAwardsHandler struct{}

func (championAwardsHandler) Type() string            { return model.ChampionEventTaskType }
func (championAwardsHandler) Interval() time.Duration { return time.Minute }
func (championAwardsHandler) NewPayload() any         { return nil }
func (championAwardsHandler) Enabled() bool {
	_, end := model.ChampionWindow()
	if time.Now().Unix() < end {
		return false
	}
	var event model.ChampionEvent
	err := model.DB.First(&event, 1).Error
	return errors.Is(err, gorm.ErrRecordNotFound) || (err == nil && (event.Status == "draft" || event.Status == "awarding"))
}
func (championAwardsHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	err := model.RunChampionCampaign(ctx, time.Now())
	status := model.SystemTaskStatusSucceeded
	if err != nil {
		status = model.SystemTaskStatusFailed
	}
	finishSystemTaskHandler(task, runnerID, status, nil, err)
}

func GetChampionAdmin(c *gin.Context) {
	event, err := model.GetChampionEvent(c.Request.Context())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	page := common.GetPageQuery(c)
	query := model.DB.WithContext(c.Request.Context()).Model(&model.ChampionAward{}).Where("event_id = ?", 1)
	if c.Query("excluded") == "true" {
		query = query.Where("position = 0")
	} else {
		query = query.Where("position > 0")
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	items := []model.ChampionAward{}
	if err := query.Order("position ASC, user_id ASC").Offset(page.GetStartIdx()).Limit(page.GetPageSize()).Find(&items).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	var credited, pending, skipped int64
	for status, count := range map[string]*int64{"credited": &credited, "pending": &pending, "skipped": &skipped} {
		if err := model.DB.Model(&model.ChampionAward{}).Where("event_id = ? AND status = ?", 1, status).Count(count).Error; err != nil {
			common.ApiError(c, err)
			return
		}
	}
	start, end := model.ChampionWindow()
	common.ApiSuccess(c, gin.H{"event": event, "items": items, "total": total, "start_at": start, "end_at": end, "server_time": time.Now().Unix(), "credited": credited, "pending": pending, "skipped": skipped})
}

func UpdateChampionAdmin(c *gin.Context) {
	var req struct {
		Revision    int64 `json:"revision"`
		Published   bool  `json:"published"`
		ExcludedIDs []int `json:"excluded_ids"`
	}
	if c.ShouldBindJSON(&req) != nil {
		common.ApiErrorMsg(c, "Invalid parameters")
		return
	}
	if req.ExcludedIDs == nil {
		req.ExcludedIDs = []int{}
	}
	if err := model.SaveChampionEvent(c.Request.Context(), req.Revision, req.Published, req.ExcludedIDs); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

func PreviewChampionAdmin(c *gin.Context) {
	var req struct {
		Revision int64 `json:"revision"`
	}
	if c.ShouldBindJSON(&req) != nil {
		common.ApiErrorMsg(c, "Invalid parameters")
		return
	}
	if err := model.PreviewChampionEvent(c.Request.Context(), time.Now(), req.Revision); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

func ConfirmChampionAdmin(c *gin.Context) {
	var req struct {
		Revision int64 `json:"revision"`
	}
	if c.ShouldBindJSON(&req) != nil {
		common.ApiErrorMsg(c, "Invalid parameters")
		return
	}
	if err := model.ConfirmChampionEvent(c.Request.Context(), req.Revision, c.GetInt("id"), time.Now()); err != nil {
		common.ApiError(c, err)
		return
	}
	// The durable campaign status also enables scheduled recovery if enqueue or
	// this HTTP response fails after confirmation commits.
	task, _, err := service.EnqueueSystemTask(model.ChampionEventTaskType, nil)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, task)
}

func GetChampionPublic(c *gin.Context) {
	var event model.ChampionEvent
	err := model.DB.WithContext(c.Request.Context()).First(&event, 1).Error
	if errors.Is(err, gorm.ErrRecordNotFound) || (err == nil && !event.Published) {
		common.ApiSuccess(c, nil)
		return
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items := []model.ChampionAward{}
	if event.SnapshotAt > 0 {
		if err := model.DB.WithContext(c.Request.Context()).Where("event_id = ? AND position BETWEEN 1 AND 7", 1).Order("position").Find(&items).Error; err != nil {
			common.ApiError(c, err)
			return
		}
	}
	winners := make([]gin.H, 0, len(items))
	for _, item := range items {
		name := []rune(strings.TrimSpace(item.Username))
		masked := "***"
		if len(name) > 0 {
			masked = string(name[0]) + "***"
		}
		// Never serialize the private ledger row into this public response.
		winners = append(winners, gin.H{"name": masked, "position": item.Position, "status": item.Status})
	}
	start, end := model.ChampionWindow()
	common.ApiSuccess(c, gin.H{"status": event.Status, "start_at": start, "end_at": end, "snapshot_at": event.SnapshotAt, "winners": winners})
}

func GetChampionSelf(c *gin.Context) {
	var award model.ChampionAward
	err := model.DB.WithContext(c.Request.Context()).Where("event_id = ? AND user_id = ?", 1, c.GetInt("id")).First(&award).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		common.ApiSuccess(c, nil)
		return
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if award.Status == "preview" {
		var event model.ChampionEvent
		if err := model.DB.First(&event, 1).Error; err != nil {
			common.ApiError(c, err)
			return
		}
		if !event.Published || event.SnapshotAt == 0 {
			common.ApiSuccess(c, nil)
			return
		}
	}
	common.ApiSuccess(c, award)
}

func UpdateChampionSelf(c *gin.Context) {
	var req struct {
		Equipped       *int   `json:"equipped"`
		Read           bool   `json:"read"`
		Seen           bool   `json:"seen"`
		Decision       string `json:"decision"`
		ConfirmDecline bool   `json:"confirm_decline"`
	}
	if c.ShouldBindJSON(&req) != nil {
		common.ApiErrorMsg(c, "Invalid parameters")
		return
	}
	if req.Decision != "" {
		if req.Equipped != nil || req.Read || req.Seen || (req.Decision == "decline" && !req.ConfirmDecline) {
			common.ApiErrorMsg(c, "Confirm your decision before giving up the reward")
			return
		}
		if err := model.ResolveChampionAward(c.Request.Context(), c.GetInt("id"), req.Decision); err != nil {
			common.ApiError(c, err)
			return
		}
		common.ApiSuccess(c, nil)
		return
	}
	var award model.ChampionAward
	query := model.DB.WithContext(c.Request.Context()).Where("event_id = ? AND user_id = ? AND status IN ?", 1, c.GetInt("id"), []string{"claimable", "credited", "declined"})
	if err := query.First(&award).Error; err != nil {
		common.ApiErrorMsg(c, "No championship reward yet")
		return
	}
	updates := map[string]any{}
	if req.Equipped != nil {
		badge := *req.Equipped
		if badge != 0 && badge != 8 && !(award.Position <= 7 && badge == award.Position) {
			common.ApiErrorMsg(c, "You do not own this badge")
			return
		}
		updates["equipped"] = badge
	}
	if req.Read {
		updates["read_at"] = time.Now().Unix()
	}
	if req.Seen {
		updates["notice_seen_at"] = time.Now().Unix()
	}
	if len(updates) == 0 {
		common.ApiErrorMsg(c, "Invalid parameters")
		return
	}
	if err := model.DB.Model(&award).Updates(updates).Error; err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}
