package operation_setting

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"
)

// DegradationWatchSetting 控制「降智检测」：每隔一段时间拿同一句提示词去问
// 指定分组里的模型，把模型画出来的 HTML 动画整批收上来对比。同一句提示词、
// 同一个思考强度，同一代模型在不同渠道上的输出质量差异肉眼可见——这就是要
// 看的东西，所以这里不做任何评分，只负责把作品和用量记下来。
type DegradationWatchSetting struct {
	Enabled bool `json:"enabled"`
	// Targets 是被测模型列表，每个模型一条泳道。顺序即前台泳道顺序。
	Targets []DegradationWatchTarget `json:"targets"`
	// Group / Model / ReasoningEffort 是只支持单模型时的旧配置。Targets 为空时
	// 自动当成一条目标使用；保留它们是为了回滚到旧版本时配置仍然有效。
	Group           string `json:"group"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
	// Concurrency 是整轮所有目标、所有渠道共用的并发请求数。
	Concurrency int `json:"concurrency"`
	// IntervalMinutes 是调度间隔；实际节拍由系统任务框架按上一次运行时间判定。
	IntervalMinutes int `json:"interval_minutes"`
	// TimeoutSeconds 是单次请求的超时上限。动画类请求动辄跑一两分钟，给足
	// 预算，避免截断出「假失败」。按单次请求计时，目标再多也不会让排在后面
	// 的请求被整轮时限误杀。
	TimeoutSeconds int `json:"timeout_seconds"`
	// RetentionPerChannel 是每个「渠道 + 模型」保留的作品数，超出部分由同一
	// 个任务裁剪，手动隐藏的作品一起裁。字段名沿用旧配置。
	RetentionPerChannel int `json:"retention_per_channel"`
	// Prompt 是后台可改的提示词。默认值把「单文件 HTML + 内联 SVG + 鹈鹕骑车」
	// 说死，是为了让不同渠道的作品可以直接并排比较。
	Prompt string `json:"prompt"`
	// ChannelAliases 是渠道 ID → 展示名，所有目标共用。只有配了别名的渠道才
	// 出现在前台检测墙上，用别名而不是渠道名，避免把上游渠道信息漏给普通用户。
	ChannelAliases map[string]string `json:"channel_aliases"`
}

// DegradationWatchTarget 是一个被测模型。同一模型只能出现一次：泳道按模型
// 名区分，重复配置会让两条泳道混在一起。
type DegradationWatchTarget struct {
	Model string `json:"model"`
	// Group 限定只测这个分组里、且渠道自身 Models 含 Model 的渠道。
	Group string `json:"group"`
	// ReasoningEffort 固定传入，检测期间不改，否则同一渠道前后两次不是同一
	// 个问题。留空表示不传该参数。
	ReasoningEffort string `json:"reasoning_effort"`
	// Enabled 为 false 时定时任务跳过它，泳道和历史作品照常展示。
	Enabled bool `json:"enabled"`
}

// DefaultDegradationWatchPrompt 是默认提示词。要点：单文件、内联 SVG、不要
// 外部资源、必须真的在骑车，且明确要求不要模仿已有作品——否则模型会稳定
// 复现同一张「标准答案图」，反而看不出差异。
const DefaultDegradationWatchPrompt = `用一个完整的单文件 HTML，以内联 SVG 为主体，绘制「鹈鹕骑自行车」的动画。
要求：
1. 只输出 HTML 代码本身，从 <!doctype html> 开始，到 </html> 结束，不要任何解释或 Markdown 代码块标记。
2. 图形必须用 SVG 绘制（可以用 CSS 或 SMIL / JavaScript 驱动动画），不要用 canvas，也不要用位图。
3. 所有 CSS 和 JavaScript 必须内联，不得引用任何外部资源（字体、图片、脚本、CDN 都不行）。
4. 画面要能看出鹈鹕的特征（大长喙、喉囊）和自行车的完整结构（两个轮子、车架、脚踏），鹈鹕要真的在骑车：腿随踏板转动、车轮在转。
5. SVG 用 viewBox 自适应容器，在 16:10 的画框里完整显示。
6. 自由发挥构图和配色，不要模仿任何已有作品。`

const (
	DegradationWatchConfigName = "degradation_watch_setting"

	DegradationWatchEnabledKey     = DegradationWatchConfigName + ".enabled"
	DegradationWatchGroupKey       = DegradationWatchConfigName + ".group"
	DegradationWatchModelKey       = DegradationWatchConfigName + ".model"
	DegradationWatchEffortKey      = DegradationWatchConfigName + ".reasoning_effort"
	DegradationWatchIntervalKey    = DegradationWatchConfigName + ".interval_minutes"
	DegradationWatchTimeoutKey     = DegradationWatchConfigName + ".timeout_seconds"
	DegradationWatchRetentionKey   = DegradationWatchConfigName + ".retention_per_channel"
	DegradationWatchPromptKey      = DegradationWatchConfigName + ".prompt"
	DegradationWatchAliasKey       = DegradationWatchConfigName + ".channel_aliases"
	DegradationWatchTargetsKey     = DegradationWatchConfigName + ".targets"
	DegradationWatchConcurrencyKey = DegradationWatchConfigName + ".concurrency"
	DegradationWatchDefaultGroup   = "GPT-企业"
	DegradationWatchDefaultModel   = "gpt-6-astra"
	DegradationWatchDefaultEffort  = "medium"

	MinDegradationWatchIntervalMinutes  = 1
	MaxDegradationWatchIntervalMinutes  = 24 * 60
	MinDegradationWatchTimeoutSeconds   = 30
	MaxDegradationWatchTimeoutSeconds   = 3600
	MinDegradationWatchRetentionPerChan = 1
	MaxDegradationWatchRetentionPerChan = 2000
	MinDegradationWatchConcurrency      = 1
	MaxDegradationWatchConcurrency      = 32
	DefaultDegradationWatchConcurrency  = 4
	// MaxDegradationWatchTargets 只是防误操作的上限，每个目标每轮都要打一遍
	// 分组里所有渠道。
	MaxDegradationWatchTargets = 20
	// MaxDegradationWatchPromptLength 挡的是「把整份文档粘进提示词」这类误操作，
	// 不是模型上下文的上限。
	MaxDegradationWatchPromptLength = 20000
)

// 默认关闭：这是一个会持续打上游额度的功能，必须由管理员显式打开。
var degradationWatchSetting = DegradationWatchSetting{
	Enabled:             false,
	Group:               DegradationWatchDefaultGroup,
	Model:               DegradationWatchDefaultModel,
	ReasoningEffort:     DegradationWatchDefaultEffort,
	Targets:             []DegradationWatchTarget{},
	Concurrency:         DefaultDegradationWatchConcurrency,
	IntervalMinutes:     30,
	TimeoutSeconds:      600,
	RetentionPerChannel: 200,
	Prompt:              DefaultDegradationWatchPrompt,
	ChannelAliases:      map[string]string{},
}

func init() {
	config.GlobalConfig.Register(DegradationWatchConfigName, &degradationWatchSetting)
}

func GetDegradationWatchSetting() *DegradationWatchSetting {
	return &degradationWatchSetting
}

// GetDegradationWatchPrompt 在提示词被清空时回落到默认值：空提示词会让模型
// 自由发挥，那批作品和别的渠道没有可比性，等于白跑一轮。
func GetDegradationWatchPrompt() string {
	prompt := strings.TrimSpace(degradationWatchSetting.Prompt)
	if prompt == "" {
		return DefaultDegradationWatchPrompt
	}
	return prompt
}

// GetDegradationWatchChannelAliases 返回一份副本，调用方按渠道 ID 查展示名。
func GetDegradationWatchChannelAliases() map[string]string {
	aliases := make(map[string]string, len(degradationWatchSetting.ChannelAliases))
	for id, alias := range degradationWatchSetting.ChannelAliases {
		if trimmed := strings.TrimSpace(alias); trimmed != "" {
			aliases[id] = trimmed
		}
	}
	return aliases
}

// DegradationWatchParams 是收敛后可直接使用的全局参数。
type DegradationWatchParams struct {
	IntervalMinutes int
	TimeoutSeconds  int
	Retention       int
	Concurrency     int
}

// ResolveDegradationWatchParams 把配置收敛成可直接使用的值：任何一项越界都
// 回落到默认值，避免一条脏配置把定时任务卡死（例如间隔 0 会变成每轮都跑，
// 超时 0 会立刻取消）。
func ResolveDegradationWatchParams() DegradationWatchParams {
	params := DegradationWatchParams{
		IntervalMinutes: degradationWatchSetting.IntervalMinutes,
		TimeoutSeconds:  degradationWatchSetting.TimeoutSeconds,
		Retention:       degradationWatchSetting.RetentionPerChannel,
		Concurrency:     degradationWatchSetting.Concurrency,
	}
	if !IsValidDegradationWatchIntervalMinutes(params.IntervalMinutes) {
		params.IntervalMinutes = 30
	}
	if !IsValidDegradationWatchTimeoutSeconds(params.TimeoutSeconds) {
		params.TimeoutSeconds = 600
	}
	if !IsValidDegradationWatchRetentionPerChannel(params.Retention) {
		params.Retention = 200
	}
	if !IsValidDegradationWatchConcurrency(params.Concurrency) {
		params.Concurrency = DefaultDegradationWatchConcurrency
	}
	return params
}

// ResolveDegradationWatchTargets 返回清洗后的目标列表（含停用的），顺序与配置
// 一致。模型名为空的条目丢弃，重复模型只留第一条，分组留空回落到默认分组。
// 目标列表为空时，把旧的单模型配置当成一条启用的目标，老配置升级后照常运行。
func ResolveDegradationWatchTargets() []DegradationWatchTarget {
	source := degradationWatchSetting.Targets
	if len(source) == 0 {
		source = []DegradationWatchTarget{{
			Model:           degradationWatchSetting.Model,
			Group:           degradationWatchSetting.Group,
			ReasoningEffort: degradationWatchSetting.ReasoningEffort,
			Enabled:         true,
		}}
		if strings.TrimSpace(source[0].Model) == "" {
			source[0].Model = DegradationWatchDefaultModel
		}
	}
	targets := make([]DegradationWatchTarget, 0, len(source))
	seen := make(map[string]bool, len(source))
	for _, target := range source {
		target.Model = strings.TrimSpace(target.Model)
		target.Group = strings.TrimSpace(target.Group)
		target.ReasoningEffort = strings.TrimSpace(target.ReasoningEffort)
		if target.Model == "" || seen[target.Model] {
			continue
		}
		seen[target.Model] = true
		if target.Group == "" {
			target.Group = DegradationWatchDefaultGroup
		}
		targets = append(targets, target)
	}
	return targets
}

// ValidateDegradationWatchTargets 给后台设置接口用：配置加载器遇到坏 JSON 会
// 静默跳过，这里当场拒收，免得「保存成功」却没生效。
func ValidateDegradationWatchTargets(raw string) error {
	var targets []DegradationWatchTarget
	if err := common.UnmarshalJsonStr(raw, &targets); err != nil {
		return errors.New("检测目标必须是 JSON 数组")
	}
	if len(targets) > MaxDegradationWatchTargets {
		return fmt.Errorf("检测目标最多 %d 个", MaxDegradationWatchTargets)
	}
	seen := make(map[string]bool, len(targets))
	for _, target := range targets {
		modelName := strings.TrimSpace(target.Model)
		if modelName == "" {
			return errors.New("检测目标的模型不能为空")
		}
		if seen[modelName] {
			return fmt.Errorf("检测目标的模型 %s 重复", modelName)
		}
		seen[modelName] = true
	}
	return nil
}

// IsValidDegradationWatchIntervalMinutes 等三个校验给后台设置接口用，越界直接
// 拒收，而不是静默回落——管理员填错数字时应该当场知道。
func IsValidDegradationWatchIntervalMinutes(minutes int) bool {
	return minutes >= MinDegradationWatchIntervalMinutes && minutes <= MaxDegradationWatchIntervalMinutes
}

func IsValidDegradationWatchTimeoutSeconds(seconds int) bool {
	return seconds >= MinDegradationWatchTimeoutSeconds && seconds <= MaxDegradationWatchTimeoutSeconds
}

func IsValidDegradationWatchRetentionPerChannel(retention int) bool {
	return retention >= MinDegradationWatchRetentionPerChan && retention <= MaxDegradationWatchRetentionPerChan
}

func IsValidDegradationWatchConcurrency(concurrency int) bool {
	return concurrency >= MinDegradationWatchConcurrency && concurrency <= MaxDegradationWatchConcurrency
}
