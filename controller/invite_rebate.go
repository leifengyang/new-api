package controller

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// maxReverseReasonLength 与 invite_rebates.reverse_reason 的列宽一致，
// 在这里拦住超长输入，避免 MySQL 严格模式下写入失败。
const maxReverseReasonLength = 255

// inviteRebateItem 是返现流水的对外形态。邀请人、下线都以用户名呈现，
// 管理员看全名，下线本人看到的是脱敏后的名字。
type inviteRebateItem struct {
	Id              int    `json:"id"`
	InviterId       int    `json:"inviter_id"`
	InviterName     string `json:"inviter_name"`
	InviteeId       int    `json:"invitee_id"`
	InviteeName     string `json:"invitee_name"`
	Source          string `json:"source"`
	SourceRef       string `json:"source_ref"`
	BaseQuota       int    `json:"base_quota"`
	RateBasisPoints int    `json:"rate_basis_points"`
	RebateQuota     int    `json:"rebate_quota"`
	Outstanding     int    `json:"outstanding_quota"`
	Status          string `json:"status"`
	SkipReason      string `json:"skip_reason"`
	ReversedQuota   int    `json:"reversed_quota"`
	ReversedAt      int64  `json:"reversed_at"`
	ReversedBy      int    `json:"reversed_by"`
	ReverseReason   string `json:"reverse_reason"`
	CreatedAt       int64  `json:"created_at"`
}

// maskDownlineName 脱敏下线用户名：保留首尾字符，中间一律替换为 ***。
// 下线身份只在管理员视图里完整可见，邀请人只能看到自己确实拉到了人、
// 以及对方贡献了多少返现。
func maskDownlineName(username string) string {
	runes := []rune(username)
	switch len(runes) {
	case 0:
		return "***"
	case 1, 2:
		return string(runes[0]) + "***"
	default:
		return string(runes[0]) + "***" + string(runes[len(runes)-1])
	}
}

func buildInviteRebateItem(rebate *model.InviteRebate, usernames map[int]string, maskDownline bool) inviteRebateItem {
	item := inviteRebateItem{
		Id:              rebate.Id,
		InviterId:       rebate.InviterId,
		InviterName:     usernames[rebate.InviterId],
		InviteeId:       rebate.InviteeId,
		InviteeName:     usernames[rebate.InviteeId],
		Source:          rebate.Source,
		SourceRef:       rebate.SourceRef,
		BaseQuota:       rebate.BaseQuota,
		RateBasisPoints: rebate.RateBasisPoints,
		RebateQuota:     rebate.RebateQuota,
		Outstanding:     rebate.RebateQuota - rebate.ReversedQuota,
		Status:          rebate.Status,
		SkipReason:      rebate.SkipReason,
		ReversedQuota:   rebate.ReversedQuota,
		ReversedAt:      rebate.ReversedAt,
		ReversedBy:      rebate.ReversedBy,
		ReverseReason:   rebate.ReverseReason,
		CreatedAt:       rebate.CreatedAt,
	}
	if maskDownline {
		item.InviteeName = maskDownlineName(item.InviteeName)
	}
	return item
}

// buildInviteRebateItems 补全用户名并保持入参顺序。
func buildInviteRebateItems(rebates []*model.InviteRebate, maskDownline bool) ([]inviteRebateItem, error) {
	ids := make([]int, 0, len(rebates)*2)
	for _, rebate := range rebates {
		ids = append(ids, rebate.InviterId, rebate.InviteeId)
	}
	usernames, err := model.GetUsernamesByIds(ids)
	if err != nil {
		return nil, err
	}
	items := make([]inviteRebateItem, 0, len(rebates))
	for _, rebate := range rebates {
		items = append(items, buildInviteRebateItem(rebate, usernames, maskDownline))
	}
	return items, nil
}

func parseInviteRebateFilter(c *gin.Context) (model.InviteRebateFilter, error) {
	filter := model.InviteRebateFilter{
		Keyword: strings.TrimSpace(c.Query("keyword")),
		Source:  c.Query("source"),
		Status:  c.Query("status"),
	}
	for _, field := range []struct {
		query string
		dest  *int
	}{
		{"inviter_id", &filter.InviterId},
		{"invitee_id", &filter.InviteeId},
	} {
		raw := c.Query(field.query)
		if raw == "" {
			continue
		}
		value, err := strconv.Atoi(raw)
		if err != nil {
			return filter, errors.New("无效的查询参数：" + field.query)
		}
		*field.dest = value
	}
	for _, field := range []struct {
		query string
		dest  *int64
	}{
		{"start_time", &filter.StartTime},
		{"end_time", &filter.EndTime},
	} {
		raw := c.Query(field.query)
		if raw == "" {
			continue
		}
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return filter, errors.New("无效的查询参数：" + field.query)
		}
		*field.dest = value
	}
	return filter, nil
}

// GetAllInviteRebates 管理员按条件分页查看返现流水。
func GetAllInviteRebates(c *gin.Context) {
	filter, err := parseInviteRebateFilter(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo := common.GetPageQuery(c)
	rebates, total, err := model.GetInviteRebates(filter, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items, err := buildInviteRebateItems(rebates, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(items)
	common.ApiSuccess(c, pageInfo)
}

type reverseInviteRebateRequest struct {
	Id     int    `json:"id"`
	Reason string `json:"reason"`
}

// ReverseInviteRebate 管理员撤销一笔已入账的返现。返现可能已被消费，
// 因此按「能扣多少扣多少」处理，未收回的部分留在流水里可见。
func ReverseInviteRebate(c *gin.Context) {
	req := reverseInviteRebateRequest{}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		common.ApiErrorMsg(c, "请填写撤销原因")
		return
	}
	if len([]rune(reason)) > maxReverseReasonLength {
		common.ApiErrorMsg(c, "撤销原因过长")
		return
	}

	rebate, err := model.ReverseInviteRebate(req.Id, c.GetInt("id"), reason)
	if err != nil {
		switch {
		case errors.Is(err, model.ErrInviteRebateNotCredited):
			common.ApiErrorMsg(c, "该返现记录当前不可撤销")
		case errors.Is(err, model.ErrInviteRebateBalanceChanged):
			common.ApiErrorMsg(c, "邀请人余额刚刚发生变化，本次撤销已回滚，请重试")
		case errors.Is(err, gorm.ErrRecordNotFound):
			common.ApiErrorMsg(c, "返现记录不存在")
		default:
			common.ApiError(c, err)
		}
		return
	}

	recordManageAudit(c, "invite_rebate.reverse", map[string]any{
		"rebate_id":   rebate.Id,
		"inviter_id":  rebate.InviterId,
		"invitee_id":  rebate.InviteeId,
		"recovered":   rebate.ReversedQuota,
		"outstanding": rebate.RebateQuota - rebate.ReversedQuota,
		"reason":      reason,
	})
	common.ApiSuccess(c, nil)
}

// GetSelfInviteRebates 内部学员查看自己的返现明细。下线身份脱敏，其余字段
// （充值来源、基数、比例、到账额度）完整展示，便于核对。
func GetSelfInviteRebates(c *gin.Context) {
	userId := c.GetInt("id")
	filter := model.InviteRebateFilter{InviterId: userId}
	pageInfo := common.GetPageQuery(c)
	rebates, total, err := model.GetInviteRebates(filter, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items, err := buildInviteRebateItems(rebates, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	summary, err := model.GetInviteRebateSummary(userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	rebateSetting := operation_setting.GetInviteRebateSetting()
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(items)
	common.ApiSuccess(c, gin.H{
		"page":              pageInfo,
		"summary":           summary,
		"rate_basis_points": rebateSetting.RateBasisPoints,
		"rebate_enabled":    rebateSetting.Enabled,
		"member_level":      model.GetUserMemberLevel(userId),
		// 前端据此决定是否展示邀请返现卡片：内部学员且非管理员才拿得到返现。
		"rebate_available": model.IsInviteRebateEligible(userId),
	})
}

type updateMemberLevelRequest struct {
	Id          int `json:"id"`
	MemberLevel int `json:"member_level"`
}

type updateMemberLevelBatchRequest struct {
	Ids         []int `json:"ids"`
	MemberLevel int   `json:"member_level"`
}

// UpdateUserMemberLevel 管理员调整单个用户的会员等级（内部 / 外部）。
// 存量学员和历史特例靠这个接口纠正，新建用户则由邀请链接自动判定。
func UpdateUserMemberLevel(c *gin.Context) {
	req := updateMemberLevelRequest{}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}
	if err := model.UpdateUserMemberLevel(req.Id, req.MemberLevel); err != nil {
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			common.ApiErrorMsg(c, "用户不存在")
		default:
			common.ApiError(c, err)
		}
		return
	}

	username, _ := model.GetUsernameById(req.Id, true)
	recordManageAudit(c, "user.member_level_update", map[string]any{
		"target_user_id": req.Id,
		"username":       username,
		"member_level":   req.MemberLevel,
	})
	common.ApiSuccess(c, nil)
}

// UpdateUsersMemberLevelBatch 管理员批量设置会员等级，用于把存量学员一次性
// 转成内部用户。
func UpdateUsersMemberLevelBatch(c *gin.Context) {
	req := updateMemberLevelBatchRequest{}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}
	affected, err := model.UpdateUsersMemberLevelByBatch(req.Ids, req.MemberLevel)
	if err != nil {
		common.ApiError(c, err)
		return
	}

	recordManageAudit(c, "user.member_level_batch", map[string]any{
		"count":        affected,
		"requested":    len(req.Ids),
		"ids":          append([]int{}, req.Ids[:min(len(req.Ids), 100)]...),
		"member_level": req.MemberLevel,
	})
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    affected,
	})
}
