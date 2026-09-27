package service

import (
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
)

// NarrowGroupsByEnterprise 把企业给成员下的分组白名单套到平台允许的分组集合上。
//
// 结果永远是平台集合的子集，企业加不出平台没有的分组——这正是「企业限制只能收紧
// 不能放宽」这条不变量的落点。enterpriseLimits 为 nil 表示企业没做限制，原样返回。
func NarrowGroupsByEnterprise(groups map[string]string, enterpriseLimits []string) map[string]string {
	if enterpriseLimits == nil {
		return groups
	}
	narrowed := make(map[string]string, len(enterpriseLimits)+1)
	for _, groupName := range enterpriseLimits {
		if desc, ok := groups[groupName]; ok {
			narrowed[groupName] = desc
		}
	}
	// auto 不是真实分组，它按 Auto 列表展开，而那个列表本身也过同一份白名单
	// （见 FilterUserTokenAutoGroups）。留着它不会让成员碰到被划掉的分组，
	// 去掉它反而会让成员手上的 auto 令牌整体失效。
	if desc, ok := groups["auto"]; ok {
		narrowed["auto"] = desc
	}
	return narrowed
}

// EnterpriseGroupLimitsFromContext 取当前请求用户被企业限定的分组白名单。
// 上下文里没有这个键（普通用户，或该入口没走 UserBase.WriteContext）时返回 nil，
// 也就是不受限。成员的请求一律经过中间件写入，因此不存在「成员拿不到限制」的入口。
func EnterpriseGroupLimitsFromContext(c *gin.Context) []string {
	limits, ok := common.GetContextKeyType[[]string](c, constant.ContextKeyEnterpriseGroupLimits)
	if !ok {
		return nil
	}
	return limits
}

// EnterpriseModelLimitsFromContext 取当前请求用户被企业限定的模型白名单，
// 语义与 EnterpriseGroupLimitsFromContext 一致。
func EnterpriseModelLimitsFromContext(c *gin.Context) []string {
	limits, ok := common.GetContextKeyType[[]string](c, constant.ContextKeyEnterpriseModelLimits)
	if !ok {
		return nil
	}
	return limits
}

// GetUserUsableGroups 返回用户在平台上可用的分组。enterpriseLimits 是企业额外
// 施加的白名单（nil 表示不受企业限制），只能是平台集合的子集。
func GetUserUsableGroups(userGroup string, enterpriseLimits []string) map[string]string {
	groupsCopy := setting.GetUserUsableGroupsCopy()
	if userGroup != "" {
		specialSettings, b := ratio_setting.GetGroupRatioSetting().GroupSpecialUsableGroup.Get(userGroup)
		if b {
			// 处理特殊可用分组
			for specialGroup, desc := range specialSettings {
				if after, ok := strings.CutPrefix(specialGroup, "-:"); ok {
					// 移除分组
					groupToRemove := after
					delete(groupsCopy, groupToRemove)
				} else if after, ok := strings.CutPrefix(specialGroup, "+:"); ok {
					// 添加分组
					groupToAdd := after
					groupsCopy[groupToAdd] = desc
				} else {
					// 直接添加分组
					groupsCopy[specialGroup] = desc
				}
			}
		}
		// 如果userGroup不在UserUsableGroups中，返回UserUsableGroups + userGroup
		if _, ok := groupsCopy[userGroup]; !ok {
			groupsCopy[userGroup] = "用户分组"
		}
	}
	return NarrowGroupsByEnterprise(groupsCopy, enterpriseLimits)
}

func GroupInUserUsableGroups(userGroup string, enterpriseLimits []string, groupName string) bool {
	_, ok := GetUserUsableGroups(userGroup, enterpriseLimits)[groupName]
	return ok
}

func IsUserSelectableGroup(userGroup string, enterpriseLimits []string, groupName string) bool {
	if groupName == "" || groupName == "auto" {
		return false
	}
	return GroupInUserUsableGroups(userGroup, enterpriseLimits, groupName) && ratio_setting.ContainsGroupRatio(groupName)
}

// GetUserAutoGroup 根据用户分组获取自动分组设置
func GetUserAutoGroup(userGroup string, enterpriseLimits []string) []string {
	autoGroups := make([]string, 0)
	seen := make(map[string]struct{})
	for _, group := range setting.GetAutoGroups() {
		if !IsUserSelectableGroup(userGroup, enterpriseLimits, group) {
			continue
		}
		if _, ok := seen[group]; ok {
			continue
		}
		seen[group] = struct{}{}
		autoGroups = append(autoGroups, group)
	}
	return autoGroups
}

// FilterUserTokenAutoGroups applies current permissions before the current
// per-token limit. It intentionally does not fall back to the global Auto list.
func FilterUserTokenAutoGroups(userGroup string, enterpriseLimits []string, groups []string) []string {
	maxCount := setting.GetMaxTokenAutoGroups()
	filtered := make([]string, 0, min(len(groups), maxCount))
	seen := make(map[string]struct{})
	for _, group := range groups {
		if !IsUserSelectableGroup(userGroup, enterpriseLimits, group) {
			continue
		}
		if _, ok := seen[group]; ok {
			continue
		}
		seen[group] = struct{}{}
		filtered = append(filtered, group)
		if len(filtered) == maxCount {
			break
		}
	}
	return filtered
}

// GetRequestAutoGroups resolves the ordered Auto groups for the current token.
// The absence of the context value means that the token inherits the complete
// global Auto list; a present (even empty) value is an explicit token snapshot.
func GetRequestAutoGroups(c *gin.Context, userGroup string) []string {
	enterpriseLimits := EnterpriseGroupLimitsFromContext(c)
	value, ok := common.GetContextKey(c, constant.ContextKeyTokenAutoGroups)
	if !ok {
		return GetUserAutoGroup(userGroup, enterpriseLimits)
	}
	groups, ok := value.([]string)
	if !ok {
		return []string{}
	}
	return FilterUserTokenAutoGroups(userGroup, enterpriseLimits, groups)
}

// GetGroupsEnabledModels 按 groups 顺序获取各分组启用的模型并去重
func GetGroupsEnabledModels(groups []string) []string {
	seen := make(map[string]struct{})
	models := make([]string, 0)
	for _, group := range groups {
		for _, modelName := range model.GetGroupEnabledModels(group) {
			if _, ok := seen[modelName]; !ok {
				seen[modelName] = struct{}{}
				models = append(models, modelName)
			}
		}
	}
	return models
}

// GetUserGroupRatio 获取用户使用某个分组的倍率
// userGroup 用户分组
// group 需要获取倍率的分组
func GetUserGroupRatio(userGroup, group string) float64 {
	ratio, ok := ratio_setting.GetGroupGroupRatio(userGroup, group)
	if ok {
		return ratio
	}
	return ratio_setting.GetGroupRatio(group)
}
