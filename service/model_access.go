package service

import (
	"errors"
	"strings"

	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
)

// enterpriseModelNameMaxLength 与 token.model_limits 的列宽保持一致。
const enterpriseModelNameMaxLength = 255

var ErrEnterpriseModelNameTooLong = errors.New("enterprise model name is too long")

// ModelLimitSet 把模型白名单切片转成匹配用的集合。
//
// nil 表示这份白名单不存在（不限制），空集合表示什么都不放行——两者必须区分开，
// 因为「企业没做限制」和「企业把成员限制到了一个空集」的后果完全不同。
func ModelLimitSet(limits []string) map[string]bool {
	if limits == nil {
		return nil
	}
	set := make(map[string]bool, len(limits))
	for _, name := range limits {
		if name != "" {
			set[name] = true
		}
	}
	return set
}

// ModelNameMatchesLimit 判断模型名是否命中一份模型白名单。limit 为 nil 表示不限制。
//
// 精确名、通配归一化名和路由归一化名都算命中。令牌的「可用模型限制」和企业的
// 模型白名单共用这一条规则：两张白名单都按同名语义收窄模型可见性，规则不一致
// 会让成员看到的模型和实际能调的模型对不上。
func ModelNameMatchesLimit(limit map[string]bool, model string) bool {
	if limit == nil {
		return true
	}
	if limit[model] {
		return true
	}
	if formatted := ratio_setting.FormatMatchingModelName(model); limit[formatted] {
		return true
	}
	return limit[ratio_setting.RoutingMatchModelName(model)]
}

// EnterpriseModelLimitSet 取当前请求用户被企业限定的模型白名单集合。
// 上下文里没有这个键（普通用户）时返回 nil，也就是不受限。
func EnterpriseModelLimitSet(c *gin.Context) map[string]bool {
	return ModelLimitSet(EnterpriseModelLimitsFromContext(c))
}

// FilterModelsByEnterpriseLimits 按企业的模型白名单过滤模型名列表，保持原顺序。
func FilterModelsByEnterpriseLimits(models []string, c *gin.Context) []string {
	limit := EnterpriseModelLimitSet(c)
	if limit == nil {
		return models
	}
	filtered := make([]string, 0, len(models))
	for _, name := range models {
		if ModelNameMatchesLimit(limit, name) {
			filtered = append(filtered, name)
		}
	}
	return filtered
}

// NormalizeEnterpriseModelLimits 清洗企业提交的模型白名单：去空白、去重、限长。
//
// 刻意不校验「这个名字现在是不是真的有渠道在提供」——模型随渠道上下线进出，
// 白名单里留着一个暂时下线的名字是正常状态，不该在保存时被判非法。真正的可见性
// 仍然由 abilities 表决定，这里只挡住空白、超长和重复项。
// 返回 nil 表示不受限，返回空切片表示限制到空集，两者调用方必须区别对待。
func NormalizeEnterpriseModelLimits(limits []string) ([]string, error) {
	if limits == nil {
		return nil, nil
	}
	seen := make(map[string]struct{}, len(limits))
	normalized := make([]string, 0, len(limits))
	for _, raw := range limits {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		if len(name) > enterpriseModelNameMaxLength {
			return nil, ErrEnterpriseModelNameTooLong
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		normalized = append(normalized, name)
	}
	return normalized, nil
}
