package controller

import (
	"cmp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

// 企业用量与日志是只读接口，同样以 currentEnterpriseId(c) 开头，并把范围在服务端
// 收窄到「本企业名下的成员」。用量口径把企业账号自己也算进去（它自己的请求也是这家
// 企业的花费），日志口径只含成员 —— 企业账号看自己的日志走普通的 /api/log/self。

const (
	enterpriseUsageDefaultSpanSeconds = 7 * 24 * 3600
	enterpriseUsageMaxSpanSeconds     = 366 * 24 * 3600
)

// parseEnterpriseUsageRange 读取并校验时间窗：缺省为最近 7 天，跨度上限一年。
func parseEnterpriseUsageRange(c *gin.Context) (startTime, endTime int64, ok bool) {
	endTime, _ = strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	startTime, _ = strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	if endTime <= 0 {
		endTime = time.Now().Unix()
	}
	if startTime <= 0 {
		startTime = endTime - enterpriseUsageDefaultSpanSeconds
	}
	if startTime >= endTime {
		common.ApiErrorMsg(c, "时间范围不合法")
		return 0, 0, false
	}
	if endTime-startTime > enterpriseUsageMaxSpanSeconds {
		common.ApiErrorMsg(c, "时间跨度不能超过一年")
		return 0, 0, false
	}
	return startTime, endTime, true
}

// enterpriseUsageScopeUserIds 解析这次查询看得见谁。带 member_id 时必须是本企业
// 名下的成员（不是就拒绝，不静默忽略）；不带就是全部成员。includeSelf 决定要不要
// 把企业账号自己也算进来。
func enterpriseUsageScopeUserIds(c *gin.Context, enterpriseId int, includeSelf bool) ([]int, bool) {
	memberIds, err := model.ListEnterpriseMemberIds(enterpriseId)
	if err != nil {
		common.ApiErrorMsg(c, "获取成员列表失败")
		return nil, false
	}
	memberId, _ := strconv.Atoi(c.Query("member_id"))
	if memberId > 0 {
		if includeSelf && memberId == enterpriseId {
			return []int{enterpriseId}, true
		}
		if _, err := model.GetEnterpriseMember(enterpriseId, memberId); err != nil {
			enterpriseApiError(c, err, "该用户不在你的企业名下")
			return nil, false
		}
		return []int{memberId}, true
	}
	if !includeSelf {
		return memberIds, true
	}
	return append(memberIds, enterpriseId), true
}

// mergeEnterpriseUsageByMember 合并同一成员的行。quota_data 里的 username 是写入
// 时的快照，成员改过名字就会被拆成两行。
func mergeEnterpriseUsageByMember(rows []*model.QuotaData) []*model.QuotaData {
	merged := make([]*model.QuotaData, 0, len(rows))
	position := make(map[int]int, len(rows))
	for _, row := range rows {
		if at, ok := position[row.UserID]; ok {
			target := merged[at]
			target.Count += row.Count
			target.Quota += row.Quota
			target.TokenUsed += row.TokenUsed
			if target.Username == "" {
				target.Username = row.Username
			}
			continue
		}
		position[row.UserID] = len(merged)
		merged = append(merged, row)
	}
	slices.SortFunc(merged, func(a, b *model.QuotaData) int {
		return cmp.Compare(b.Quota, a.Quota)
	})
	return merged
}

// GetEnterpriseUsage 企业用量聚合：按模型、按成员、按小时（前端再折算成天）。
func GetEnterpriseUsage(c *gin.Context) {
	enterpriseId := currentEnterpriseId(c)
	startTime, endTime, ok := parseEnterpriseUsageRange(c)
	if !ok {
		return
	}
	userIds, ok := enterpriseUsageScopeUserIds(c, enterpriseId, true)
	if !ok {
		return
	}

	byModel, err := model.GetEnterpriseQuotaDataByModel(userIds, startTime, endTime)
	if err != nil {
		common.ApiErrorMsg(c, "获取用量数据失败")
		return
	}
	byMember, err := model.GetEnterpriseQuotaDataByMember(userIds, startTime, endTime)
	if err != nil {
		common.ApiErrorMsg(c, "获取用量数据失败")
		return
	}
	trend, err := model.GetEnterpriseQuotaDataTrend(userIds, startTime, endTime)
	if err != nil {
		common.ApiErrorMsg(c, "获取用量数据失败")
		return
	}

	common.ApiSuccess(c, gin.H{
		// 平台的用量看板被关掉时 quota_data 根本不落库，界面要说「统计已关闭」，
		// 而不是显示一排 0。
		"data_export_enabled": common.DataExportEnabled,
		"by_model":            byModel,
		"by_member":           mergeEnterpriseUsageByMember(byMember),
		"trend":               trend,
	})
}

// enterpriseLogsPage 在标准分页字段之外带上本次筛选的消费总额。
type enterpriseLogsPage struct {
	*common.PageInfo
	QuotaTotal int64 `json:"quota_total"`
}

// GetEnterpriseLogs 本企业成员的原始日志。渠道与 IP 在 model 层就已脱敏，
// 这里只是把范围收窄后原样返回。
func GetEnterpriseLogs(c *gin.Context) {
	enterpriseId := currentEnterpriseId(c)
	startTime, endTime, ok := parseEnterpriseUsageRange(c)
	if !ok {
		return
	}
	memberIds, ok := enterpriseUsageScopeUserIds(c, enterpriseId, false)
	if !ok {
		return
	}

	logType, _ := strconv.Atoi(c.Query("type"))
	modelName := strings.TrimSpace(c.Query("model_name"))
	group := strings.TrimSpace(c.Query("group"))
	pageInfo := common.GetPageQuery(c)

	logs, total, err := model.GetEnterpriseMemberLogs(
		memberIds, logType, startTime, endTime, modelName, group,
		pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiErrorMsg(c, "获取日志失败")
		return
	}
	model.FormatEnterpriseMemberLogs(logs)
	if logs == nil {
		logs = []*model.Log{}
	}
	quotaTotal, err := model.SumEnterpriseMemberQuota(memberIds, startTime, endTime, modelName, group)
	if err != nil {
		common.ApiErrorMsg(c, "获取日志统计失败")
		return
	}

	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(logs)
	common.ApiSuccess(c, &enterpriseLogsPage{PageInfo: pageInfo, QuotaTotal: quotaTotal})
}
