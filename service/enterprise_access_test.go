package service

import (
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// configureEnterpriseAccessTest 铺一份平台分组配置：三个可用分组 + 三个 auto 分组，
// 并把比例配全（IsUserSelectableGroup 要求目标分组在 GroupRatio 里存在）。
func configureEnterpriseAccessTest(t *testing.T) {
	t.Helper()
	originalAutoGroups := setting.AutoGroups2JsonString()
	originalUsableGroups := setting.UserUsableGroups2JSONString()
	originalRatios := ratio_setting.GroupRatio2JSONString()
	originalMax := setting.GetMaxTokenAutoGroups()
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(
		`{"default":"默认","vip":"VIP","svip":"SVIP"}`))
	require.NoError(t, setting.UpdateAutoGroupsByJsonString(`["vip","default","svip"]`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"vip":1,"svip":1}`))
	require.NoError(t, setting.UpdateMaxTokenAutoGroups("10"))
	t.Cleanup(func() {
		require.NoError(t, setting.UpdateAutoGroupsByJsonString(originalAutoGroups))
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(originalUsableGroups))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalRatios))
		require.NoError(t, setting.UpdateMaxTokenAutoGroups(strconv.Itoa(originalMax)))
	})
}

func newEnterpriseAccessContext() *gin.Context {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	return ctx
}

func TestNarrowGroupsByEnterprise(t *testing.T) {
	platform := map[string]string{"default": "默认", "vip": "VIP", "svip": "SVIP", "auto": "自动"}

	// nil 表示企业没做限制。
	assert.Equal(t, platform, NarrowGroupsByEnterprise(platform, nil))

	narrowed := NarrowGroupsByEnterprise(platform, []string{"vip"})
	// auto 始终保留：它展开时也过同一份白名单，留着不会放宽，去掉反而废掉 auto 令牌。
	assert.Equal(t, map[string]string{"vip": "VIP", "auto": "自动"}, narrowed)

	// 白名单里出现平台没有的分组时静默忽略——企业加不出新分组。
	assert.Equal(t, map[string]string{"auto": "自动"}, NarrowGroupsByEnterprise(platform, []string{"nope"}))

	// 结果必须是一份新 map，不能就地改动调用方的配置副本。
	before := setting.UserUsableGroups2JSONString()
	_ = NarrowGroupsByEnterprise(platform, []string{"vip"})
	assert.Equal(t, before, setting.UserUsableGroups2JSONString())
	assert.Len(t, platform, 4, "入参不能被就地删减")
}

func TestGetUserUsableGroupsIsNarrowedByEnterpriseLimits(t *testing.T) {
	configureEnterpriseAccessTest(t)

	all := GetUserUsableGroups("default", nil)
	assert.Contains(t, all, "default")
	assert.Contains(t, all, "vip")
	assert.Contains(t, all, "svip")

	narrowed := GetUserUsableGroups("default", []string{"vip"})
	assert.Equal(t, []string{"vip"}, keysOf(narrowed))

	// 收窄到空集：什么都不放行，绝不能退回「不受限」。
	assert.Empty(t, GetUserUsableGroups("default", []string{}))
}

func keysOf(groups map[string]string) []string {
	keys := make([]string, 0, len(groups))
	for name := range groups {
		keys = append(keys, name)
	}
	// 定长小集合，排序只为让断言稳定。
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}

func TestIsUserSelectableGroupRespectsEnterpriseLimits(t *testing.T) {
	configureEnterpriseAccessTest(t)

	assert.True(t, IsUserSelectableGroup("default", nil, "vip"))
	assert.False(t, IsUserSelectableGroup("default", []string{"default"}, "vip"))
	assert.True(t, IsUserSelectableGroup("default", []string{"vip"}, "vip"))
	// 空集不是「不受限」。
	assert.False(t, IsUserSelectableGroup("default", []string{}, "vip"))
	// auto 和空串永远不是可选的真实分组。
	assert.False(t, IsUserSelectableGroup("default", nil, "auto"))
	assert.False(t, IsUserSelectableGroup("default", nil, ""))
}

func TestGetUserAutoGroupIsNarrowedByEnterpriseLimits(t *testing.T) {
	configureEnterpriseAccessTest(t)

	assert.Equal(t, []string{"vip", "default", "svip"}, GetUserAutoGroup("default", nil))
	assert.Equal(t, []string{"vip"}, GetUserAutoGroup("default", []string{"vip"}))
	// 白名单里那个平台没有的分组自动落空，剩下的照旧展开。
	assert.Equal(t, []string{"svip"}, GetUserAutoGroup("default", []string{"svip", "nope"}))
	assert.Empty(t, GetUserAutoGroup("default", []string{}))
}

func TestFilterUserTokenAutoGroupsIsNarrowedByEnterpriseLimits(t *testing.T) {
	configureEnterpriseAccessTest(t)
	issued := []string{"svip", "vip", "default"}

	assert.Equal(t, issued, FilterUserTokenAutoGroups("default", nil, issued))
	// 令牌上已经签发的分组也必须被企业白名单过滤掉——收窄发生在读侧，而不是只挡在写入侧。
	assert.Equal(t, []string{"vip"}, FilterUserTokenAutoGroups("default", []string{"vip"}, issued))
	assert.Empty(t, FilterUserTokenAutoGroups("default", []string{}, issued))
}

func TestEnterpriseLimitsFromContext(t *testing.T) {
	ctx := newEnterpriseAccessContext()
	assert.Nil(t, EnterpriseGroupLimitsFromContext(ctx))
	assert.Nil(t, EnterpriseModelLimitsFromContext(ctx))
	assert.Nil(t, EnterpriseModelLimitSet(ctx))

	common.SetContextKey(ctx, constant.ContextKeyEnterpriseGroupLimits, []string{"vip"})
	common.SetContextKey(ctx, constant.ContextKeyEnterpriseModelLimits, []string{"gpt-4o"})
	assert.Equal(t, []string{"vip"}, EnterpriseGroupLimitsFromContext(ctx))
	assert.Equal(t, []string{"gpt-4o"}, EnterpriseModelLimitsFromContext(ctx))

	// 空集合与「没有限制」在上下文里同样必须区分开。
	empty := newEnterpriseAccessContext()
	common.SetContextKey(empty, constant.ContextKeyEnterpriseModelLimits, []string{})
	assert.Empty(t, EnterpriseModelLimitSet(empty))
	assert.NotNil(t, EnterpriseModelLimitSet(empty), "空集是一个「什么都不放行」的白名单，不是 nil")
}

func TestModelLimitSetDistinguishesNilFromEmpty(t *testing.T) {
	assert.Nil(t, ModelLimitSet(nil))
	// 空切片 → 非 nil 的空集合：什么都不放行。
	empty := ModelLimitSet([]string{})
	require.NotNil(t, empty)
	assert.Empty(t, empty)
	// 空白项不构成一条白名单，结果仍是空集合而不是「不受限」。
	assert.Empty(t, ModelLimitSet([]string{"", ""}))
	assert.Equal(t, map[string]bool{"gpt-4o": true}, ModelLimitSet([]string{"gpt-4o", ""}))
}

func TestModelNameMatchesLimit(t *testing.T) {
	// nil = 不受限。
	assert.True(t, ModelNameMatchesLimit(nil, "anything"))

	limit := ModelLimitSet([]string{"gpt-4o", "gpt-4-gizmo-*"})
	assert.True(t, ModelNameMatchesLimit(limit, "gpt-4o"))
	assert.False(t, ModelNameMatchesLimit(limit, "gpt-3.5"))
	// 通配归一化名同样算命中，规则与令牌的模型限制一致：
	// gpt-4-gizmo-<任意后缀> 归一成 gpt-4-gizmo-*，而 gpt-4o-gizmo-… 归一成另一个名字。
	assert.True(t, ModelNameMatchesLimit(limit, "gpt-4-gizmo-some-variant"))
	assert.False(t, ModelNameMatchesLimit(limit, "gpt-4o-gizmo-some-variant"))
	assert.True(t, ModelNameMatchesLimit(ModelLimitSet([]string{"gpt-4o-gizmo-*"}), "gpt-4o-gizmo-some-variant"))

	// 空集合什么都不放行。
	assert.False(t, ModelNameMatchesLimit(ModelLimitSet([]string{}), "gpt-4o"))
}

func TestFilterModelsByEnterpriseLimits(t *testing.T) {
	ctx := newEnterpriseAccessContext()
	models := []string{"gpt-4o", "gpt-3.5", "claude-3"}

	assert.Equal(t, models, FilterModelsByEnterpriseLimits(models, ctx), "没有限制时保持原顺序原样返回")

	common.SetContextKey(ctx, constant.ContextKeyEnterpriseModelLimits, []string{"gpt-4o", "claude-3"})
	assert.Equal(t, []string{"gpt-4o", "claude-3"}, FilterModelsByEnterpriseLimits(models, ctx))

	empty := newEnterpriseAccessContext()
	common.SetContextKey(empty, constant.ContextKeyEnterpriseModelLimits, []string{})
	assert.Empty(t, FilterModelsByEnterpriseLimits(models, empty))
}

func TestNormalizeEnterpriseModelLimits(t *testing.T) {
	limits, err := NormalizeEnterpriseModelLimits(nil)
	require.NoError(t, err)
	assert.Nil(t, limits, "nil 表示撤销限制")

	limits, err = NormalizeEnterpriseModelLimits([]string{" gpt-4o ", "gpt-4o", "", "claude-3"})
	require.NoError(t, err)
	assert.Equal(t, []string{"gpt-4o", "claude-3"}, limits)

	// 空切片 = 限制到空集，与 nil 是两回事。
	limits, err = NormalizeEnterpriseModelLimits([]string{})
	require.NoError(t, err)
	require.NotNil(t, limits)
	assert.Empty(t, limits)

	// 只有空白项时同样是空集，不能退化成「不受限」。
	limits, err = NormalizeEnterpriseModelLimits([]string{"  ", ""})
	require.NoError(t, err)
	require.NotNil(t, limits)
	assert.Empty(t, limits)

	_, err = NormalizeEnterpriseModelLimits([]string{string(make([]byte, 256))})
	assert.ErrorIs(t, err, ErrEnterpriseModelNameTooLong)
}

// 模型名不校验「现在有没有渠道在提供」：模型随渠道上下线进出，白名单里留着一个
// 暂时下线的名字是正常状态。
func TestNormalizeEnterpriseModelLimitsAcceptsUnknownModels(t *testing.T) {
	limits, err := NormalizeEnterpriseModelLimits([]string{"a-model-that-no-channel-serves"})
	require.NoError(t, err)
	assert.Equal(t, []string{"a-model-that-no-channel-serves"}, limits)
}
