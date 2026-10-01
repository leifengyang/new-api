package controller

import (
	"errors"
	"sort"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// 企业控制台的每个 handler 都以 currentEnterpriseId(c) 开头，再由 model 层把
// 查询和写入收窄到这家企业名下。这里不做任何可见性判断，只负责把操作者身份
// 取出来交给 model —— 前端的任何参数都不构成授权依据。

func currentEnterpriseId(c *gin.Context) int {
	return c.GetInt("id")
}

// enterpriseMemberIdFromPath 读取路径上的成员 id。解析失败一律当参数非法处理，
// 绝不回退到「操作者自己」——那会让一个打错的 id 变成对企业账号自身的操作。
func enterpriseMemberIdFromPath(c *gin.Context) (int, bool) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

func requireEnterpriseMemberProof(c *gin.Context, memberId int, action string, quota, frozen int) bool {
	context := map[string]any{"member_id": memberId, "action": action}
	if action == "transfer" || action == "classify" {
		context["quota"] = quota
	}
	if action == "classify" {
		context["frozen"] = frozen
	}
	encoded, err := common.Marshal(context)
	if err != nil {
		common.ApiError(c, err)
		return false
	}
	return middleware.RequireSecurityProof(c, service.VerificationOperation{Scope: service.VerificationScopeEnterpriseMember, Context: encoded}) != nil
}

func enterpriseApiError(c *gin.Context, err error, fallback string) {
	switch {
	case err == nil:
		return
	case errors.Is(err, model.ErrEnterpriseFrozenQuota), errors.Is(err, model.ErrEnterpriseMembersRemain), errors.Is(err, model.ErrEnterpriseMemberMustExit):
		common.ApiError(c, err)
	case errors.Is(err, model.ErrEnterpriseNotFound):
		common.ApiErrorMsg(c, "企业账号不存在")
	case errors.Is(err, model.ErrEnterpriseNotAMember):
		common.ApiErrorMsg(c, "该用户不在你的企业名下")
	case errors.Is(err, model.ErrEnterpriseMemberLimitReached):
		common.ApiErrorMsg(c, "成员数量已达上限")
	case errors.Is(err, model.ErrEnterpriseMemberNotEnabled):
		common.ApiErrorMsg(c, "该成员已停用，请先启用再划拨")
	case errors.Is(err, model.ErrEnterpriseMemberExists):
		common.ApiErrorMsg(c, "用户名已被占用")
	case errors.Is(err, model.ErrEnterpriseQuotaNotPositive):
		common.ApiErrorMsg(c, "划拨额度必须大于 0")
	case errors.Is(err, model.ErrInsufficientEnterpriseQuota):
		common.ApiErrorMsg(c, "企业余额不足")
	case errors.Is(err, model.ErrWalletQuotaLimitExceeded):
		common.ApiErrorMsg(c, "额度超出钱包上限")
	case errors.Is(err, model.ErrEnterpriseWalletChanged):
		common.ApiErrorMsg(c, "余额刚刚被改动过，请重试")
	case errors.Is(err, model.ErrInvalidEnterpriseLimits):
		common.ApiErrorMsg(c, "分组或模型范围不合法")
	case errors.Is(err, model.ErrEnterpriseMemberStatusUnchanged):
		common.ApiErrorMsg(c, "成员已经是该状态")
	case errors.Is(err, gorm.ErrRecordNotFound):
		common.ApiErrorMsg(c, "用户不存在")
	default:
		common.ApiErrorMsg(c, fallback)
	}
}

// UpdateUserEnterprise 平台管理员打上或取消某个账号的「企业账号」标记。
// 与会员等级同一类操作：只有管理端能调，普通用户看不到这个入口。
func UpdateUserEnterprise(c *gin.Context) {
	req := struct {
		Id           int  `json:"id"`
		IsEnterprise bool `json:"is_enterprise"`
	}{}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil || req.Id <= 0 {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}

	released, err := model.SetUserEnterpriseFlag(req.Id, req.IsEnterprise)
	if err != nil {
		switch {
		case errors.Is(err, model.ErrEnterpriseTargetNotCommonUser):
			common.ApiErrorMsg(c, "只有普通用户可以被设为公司账号")
		case errors.Is(err, model.ErrEnterpriseTargetIsMember):
			common.ApiErrorMsg(c, "该账号已经是别人的成员，不能同时作为公司账号")
		case errors.Is(err, gorm.ErrRecordNotFound):
			common.ApiErrorMsg(c, "用户不存在")
		default:
			common.ApiError(c, err)
		}
		return
	}

	username, _ := model.GetUsernameById(req.Id, true)
	action := "user.enterprise_mark"
	if !req.IsEnterprise {
		action = "user.enterprise_unmark"
	}
	recordManageAuditFor(c, req.Id, action, map[string]any{
		"target_user_id": req.Id,
		"username":       username,
		"released":       released,
		"is_enterprise":  req.IsEnterprise,
		"member_limit":   common.EnterpriseMemberLimit,
	})
	common.ApiSuccess(c, gin.H{"released_members": released})
}

// GetEnterpriseProfile 控制台首页需要的基本信息：企业自身的余额、成员数上限、
// 以及给成员用的邀请链接。
func GetEnterpriseProfile(c *gin.Context) {
	enterpriseId := currentEnterpriseId(c)
	enterprise, err := model.GetEnterpriseAccount(enterpriseId)
	if err != nil {
		enterpriseApiError(c, err, "读取公司账号失败")
		return
	}
	memberCount, err := model.CountEnterpriseMembers(enterpriseId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"id":           enterprise.Id,
		"username":     enterprise.Username,
		"display_name": enterprise.DisplayName,
		"quota":        enterprise.Quota,
		"used_quota":   enterprise.UsedQuota,
		"member_count": memberCount,
		"member_limit": common.EnterpriseMemberLimit,
		// 企业账号的推广码同时就是它的成员邀请码：新用户带着这个码注册进来，
		// 会直接落到该企业名下，且不会与企业账号建立邀请返现关系（见
		// model.ResolveRegistrationAdmission）。
		"invite_code": enterprise.AffCode,
	})
}

// GetEnterpriseMembers 分页列出企业名下的成员。
func GetEnterpriseMembers(c *gin.Context) {
	enterpriseId := currentEnterpriseId(c)
	pageInfo := common.GetPageQuery(c)
	filter := model.EnterpriseMemberFilter{Keyword: c.Query("keyword")}
	if status, err := strconv.Atoi(c.Query("status")); err == nil {
		filter.Status = status
	}
	members, total, err := model.ListEnterpriseMembers(
		enterpriseId, filter, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(members)
	common.ApiSuccess(c, pageInfo)
}

// CreateEnterpriseMember 企业管理员直接建号：设初始密码，建完即可登录。
func CreateEnterpriseMember(c *gin.Context) {
	enterpriseId := currentEnterpriseId(c)
	req := struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
		Remark      string `json:"remark"`
	}{}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}
	username := strings.TrimSpace(req.Username)
	if username == "" {
		common.ApiErrorMsg(c, "用户名不能为空")
		return
	}

	member := &model.User{
		Username:    username,
		Password:    req.Password,
		DisplayName: strings.TrimSpace(req.DisplayName),
		Remark:      strings.TrimSpace(req.Remark),
	}
	if member.DisplayName == "" {
		member.DisplayName = username
	}
	// 复用账号自己的校验标签（用户名 <=20、密码 8~128、备注 <=255），
	// 免得在这里另写一份规则跟注册链路对不上。
	if err := common.Validate.Struct(member); err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}

	if err := model.CreateEnterpriseMember(enterpriseId, member); err != nil {
		enterpriseApiError(c, err, "创建成员失败")
		return
	}
	model.InitUserSidebarConfig(member)

	recordManageAuditFor(c, member.Id, "enterprise.member_create", map[string]any{
		"target_user_id": member.Id,
		"username":       member.Username,
		"enterprise_id":  enterpriseId,
	})
	common.ApiSuccess(c, gin.H{"id": member.Id, "username": member.Username})
}

// UpdateEnterpriseMemberStatus 停用 / 启用成员。停用会把余额退回企业账号。
func UpdateEnterpriseMemberStatus(c *gin.Context) {
	enterpriseId := currentEnterpriseId(c)
	memberId, ok := enterpriseMemberIdFromPath(c)
	if !ok {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}
	if c.GetInt("role") >= common.RoleAdminUser {
		member, err := model.GetUserById(memberId, false)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		if member.Role >= c.GetInt("role") {
			common.ApiErrorMsg(c, "Permission denied")
			return
		}
		enterpriseId = member.EnterpriseOwnerId
	}

	req := struct {
		Enabled bool `json:"enabled"`
	}{}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}

	actionProof := "disable"
	if req.Enabled {
		actionProof = "enable"
	}
	if !requireEnterpriseMemberProof(c, memberId, actionProof, 0, 0) {
		return
	}
	returned, err := model.SetEnterpriseMemberStatus(enterpriseId, memberId, req.Enabled)
	if err != nil {
		enterpriseApiError(c, err, "更新成员状态失败")
		return
	}

	action := "enterprise.member_disable"
	if req.Enabled {
		action = "enterprise.member_enable"
	}
	recordManageAuditFor(c, memberId, action, map[string]any{
		"target_user_id": memberId,
		"enterprise_id":  enterpriseId,
		"returned":       returned,
	})
	common.ApiSuccess(c, gin.H{"returned_quota": returned})
}

// UpdateEnterpriseMemberLimits 收窄成员的可用分组 / 可用模型。
func UpdateEnterpriseMemberLimits(c *gin.Context) {
	enterpriseId := currentEnterpriseId(c)
	memberId, ok := enterpriseMemberIdFromPath(c)
	if !ok {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}
	req := struct {
		GroupLimits []string `json:"group_limits"`
		ModelLimits []string `json:"model_limits"`
	}{}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}

	member, err := model.GetEnterpriseMember(enterpriseId, memberId)
	if err != nil {
		enterpriseApiError(c, err, "读取成员失败")
		return
	}
	// 允许的分组以「该成员本来就能用的分组」为准，企业的白名单只能是它的子集。
	// 这一步在服务端做，前端提交什么都越不过平台的分组配置。
	allowedGroups := service.GetUserUsableGroups(member.Group, nil)
	groupLimits, err := model.NormalizeEnterpriseGroupLimits(req.GroupLimits, allowedGroups)
	if err != nil {
		enterpriseApiError(c, err, "分组范围不合法")
		return
	}
	modelLimits, err := service.NormalizeEnterpriseModelLimits(req.ModelLimits)
	if err != nil {
		common.ApiErrorMsg(c, "模型名不合法")
		return
	}

	if err := model.UpdateEnterpriseMemberLimits(enterpriseId, memberId, groupLimits, modelLimits); err != nil {
		enterpriseApiError(c, err, "保存可见范围失败")
		return
	}

	recordManageAuditFor(c, memberId, "enterprise.member_limits", map[string]any{
		"target_user_id": memberId,
		"enterprise_id":  enterpriseId,
		"groups":         summariseLimits(groupLimits),
		"models":         summariseLimits(modelLimits),
	})
	common.ApiSuccess(c, nil)
}

// summariseLimits 把白名单压成审计里能看的一行，nil 落成 "all"（不受限）。
func summariseLimits(limits []string) string {
	if limits == nil {
		return "all"
	}
	if len(limits) == 0 {
		return "none"
	}
	if len(limits) <= 10 {
		return strings.Join(limits, ",")
	}
	return strings.Join(limits[:10], ",") + "..."
}

// TransferEnterpriseMemberQuota 从企业余额里划一笔额度给成员。
func TransferEnterpriseMemberQuota(c *gin.Context) {
	enterpriseId := currentEnterpriseId(c)
	memberId, ok := enterpriseMemberIdFromPath(c)
	if !ok {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}
	req := struct {
		Quota int `json:"quota"`
	}{}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}

	if !requireEnterpriseMemberProof(c, memberId, "transfer", req.Quota, 0) {
		return
	}
	transferred, err := model.TransferEnterpriseQuotaToMember(enterpriseId, memberId, req.Quota)
	if err != nil {
		enterpriseApiError(c, err, "划拨额度失败")
		return
	}

	recordManageAuditFor(c, memberId, "enterprise.member_quota", map[string]any{
		"target_user_id": memberId,
		"enterprise_id":  enterpriseId,
		"quota":          transferred,
	})
	common.ApiSuccess(c, gin.H{"transferred_quota": transferred})
}

// ResetEnterpriseMemberPassword 企业管理员重置成员密码。
func ResetEnterpriseMemberPassword(c *gin.Context) {
	enterpriseId := currentEnterpriseId(c)
	memberId, ok := enterpriseMemberIdFromPath(c)
	if !ok {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}
	// 密码长度直接挂校验标签，和注册链路用的是同一条规则（8~128）。
	req := struct {
		Password string `json:"password" validate:"min=8,max=128"`
	}{}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}
	if err := common.Validate.Struct(&req); err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}

	if !requireEnterpriseMemberProof(c, memberId, "password", 0, 0) {
		return
	}
	if err := model.ResetEnterpriseMemberPassword(enterpriseId, memberId, req.Password); err != nil {
		enterpriseApiError(c, err, "重置密码失败")
		return
	}

	recordManageAuditFor(c, memberId, "enterprise.member_password", map[string]any{
		"target_user_id": memberId,
		"enterprise_id":  enterpriseId,
	})
	common.ApiSuccess(c, nil)
}

// GetEnterpriseMemberOptions 返回设置成员可见范围时要用的候选项：
// 该成员当前能用的分组、以及这些分组下现存的模型。
//
// 候选项本身就是「平台允许」的集合，企业只能在其中做减法，所以这里直接把
// 成员当前可用的全集给他挑，不需要另做过滤。
func GetEnterpriseMemberOptions(c *gin.Context) {
	enterpriseId := currentEnterpriseId(c)
	memberId, ok := enterpriseMemberIdFromPath(c)
	if !ok {
		common.ApiErrorMsg(c, "无效的参数")
		return
	}
	member, err := model.GetEnterpriseMember(enterpriseId, memberId)
	if err != nil {
		enterpriseApiError(c, err, "读取成员失败")
		return
	}

	usableGroups := service.GetUserUsableGroups(member.Group, nil)
	groups := make([]gin.H, 0, len(usableGroups))
	groupNames := make([]string, 0, len(usableGroups))
	for name := range usableGroups {
		if !ratio_setting.ContainsGroupRatio(name) {
			continue
		}
		groupNames = append(groupNames, name)
	}
	sort.Strings(groupNames)
	for _, name := range groupNames {
		groups = append(groups, gin.H{
			"name": name,
			"desc": setting.GetUsableGroupDescription(name),
		})
	}

	modelsByGroup := make(map[string][]string, len(groupNames))
	for _, name := range groupNames {
		modelsByGroup[name] = service.GetGroupsEnabledModels([]string{name})
		sort.Strings(modelsByGroup[name])
	}
	models := service.GetGroupsEnabledModels(groupNames)
	sort.Strings(models)

	common.ApiSuccess(c, gin.H{
		"groups":          groups,
		"models":          models,
		"models_by_group": modelsByGroup,
		"group_limits":    jsonLimitsOrNull(member.EnterpriseGroupLimits),
		"model_limits":    jsonLimitsOrNull(member.EnterpriseModelLimits),
		"member_group":    member.Group,
		"member_enabled":  member.Status == common.UserStatusEnabled,
	})
}

// jsonLimitsOrNull 把库里的白名单文本回给前端：空列回 null（不受限），
// 前端据此把「不限」和「限到空集」区分开。
func jsonLimitsOrNull(raw string) any {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var limits []string
	if err := common.UnmarshalJsonStr(raw, &limits); err != nil {
		return nil
	}
	return limits
}

// RemoveEnterpriseMember is shared by the enterprise and platform-admin routes.
// Administrators resolve ownership from the database rather than a client id.
func RemoveEnterpriseMember(c *gin.Context) {
	memberId, ok := enterpriseMemberIdFromPath(c)
	if !ok {
		common.ApiErrorMsg(c, "Invalid parameters")
		return
	}
	ownerId := currentEnterpriseId(c)
	if c.GetInt("role") >= common.RoleAdminUser {
		member, err := model.GetUserById(memberId, false)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		if member.Role >= c.GetInt("role") {
			common.ApiErrorMsg(c, "Permission denied")
			return
		}
		ownerId = member.EnterpriseOwnerId
	}
	if !requireEnterpriseMemberProof(c, memberId, "remove", 0, 0) {
		return
	}
	var returned int
	var err error
	if c.GetInt("role") >= common.RoleAdminUser {
		returned, err = model.RemoveEnterpriseMemberByAdmin(ownerId, memberId, c.GetInt("role"))
	} else {
		returned, err = model.RemoveEnterpriseMember(ownerId, memberId)
	}
	if err != nil {
		enterpriseApiError(c, err, "Failed to remove member")
		return
	}
	recordManageAuditFor(c, memberId, "enterprise.member_remove", map[string]any{"enterprise_id": ownerId, "returned_quota": returned})
	common.ApiSuccess(c, gin.H{"returned_quota": returned})
}

func ClassifyEnterpriseBalance(c *gin.Context) {
	memberId, ok := enterpriseMemberIdFromPath(c)
	req := struct {
		Frozen int `json:"frozen"`
		Quota  int `json:"quota"`
	}{}
	if !ok || common.DecodeJson(c.Request.Body, &req) != nil {
		common.ApiErrorMsg(c, "Invalid parameters")
		return
	}
	user, err := model.GetUserById(memberId, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if c.GetInt("role") <= user.Role {
		common.ApiErrorMsg(c, "Permission denied")
		return
	}
	if !requireEnterpriseMemberProof(c, memberId, "classify", req.Quota, req.Frozen) {
		return
	}
	if err := model.ClassifyEnterpriseBalance(memberId, req.Frozen, req.Quota); err != nil {
		enterpriseApiError(c, err, "Failed to classify balance")
		return
	}
	recordManageAuditFor(c, memberId, "enterprise.balance_classify", map[string]any{"frozen": req.Frozen, "enterprise_quota": req.Quota, "personal_quota": req.Frozen - req.Quota})
	common.ApiSuccess(c, nil)
}
