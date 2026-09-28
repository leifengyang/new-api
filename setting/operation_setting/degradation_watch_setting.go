package operation_setting

import (
	"strings"

	"github.com/QuantumNous/new-api/setting/config"
)

// DegradationWatchSetting 控制「降智检测」：每隔一段时间拿同一句提示词去问
// 指定分组里的模型，把模型画出来的 HTML 动画整批收上来对比。同一句提示词、
// 同一个思考强度，同一代模型在不同渠道上的输出质量差异肉眼可见——这就是要
// 看的东西，所以这里不做任何评分，只负责把作品和用量记下来。
type DegradationWatchSetting struct {
	Enabled bool `json:"enabled"`
	// Group 是唯一的内容选择条件：只测这个分组里的渠道。渠道自身的 Models
	// 里没有 Model 的直接跳过。
	Group string `json:"group"`
	// Model 是唯一被测模型。换模型等于换了一把尺子，历史作品不再可比。
	Model string `json:"model"`
	// ReasoningEffort 固定传入，检测期间不改，否则同一渠道前后两次不是同一
	// 个问题。留空表示不传该参数。
	ReasoningEffort string `json:"reasoning_effort"`
	// IntervalMinutes 是调度间隔；实际节拍由系统任务框架按上一次运行时间判定。
	IntervalMinutes int `json:"interval_minutes"`
	// TimeoutSeconds 是单次运行（整批渠道）的超时上限。动画类请求动辄跑一两
	// 分钟，给足预算，避免截断出「假失败」。
	TimeoutSeconds int `json:"timeout_seconds"`
	// RetentionPerChannel 是每个渠道保留的作品数，超出部分由同一个任务裁剪，
	// 手动隐藏的作品一起裁。
	RetentionPerChannel int `json:"retention_per_channel"`
	// Prompt 是后台可改的提示词。默认值把「单文件 HTML + 内联 SVG + 鹈鹕骑车」
	// 说死，是为了让不同渠道的作品可以直接并排比较。
	Prompt string `json:"prompt"`
	// ChannelAliases 是渠道 ID → 展示名。只有配了别名的渠道才出现在前台检测墙
	// 上，用别名而不是渠道名，避免把上游渠道信息漏给普通用户。
	ChannelAliases map[string]string `json:"channel_aliases"`
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

	DegradationWatchEnabledKey    = DegradationWatchConfigName + ".enabled"
	DegradationWatchGroupKey      = DegradationWatchConfigName + ".group"
	DegradationWatchModelKey      = DegradationWatchConfigName + ".model"
	DegradationWatchEffortKey     = DegradationWatchConfigName + ".reasoning_effort"
	DegradationWatchIntervalKey   = DegradationWatchConfigName + ".interval_minutes"
	DegradationWatchTimeoutKey    = DegradationWatchConfigName + ".timeout_seconds"
	DegradationWatchRetentionKey  = DegradationWatchConfigName + ".retention_per_channel"
	DegradationWatchPromptKey     = DegradationWatchConfigName + ".prompt"
	DegradationWatchAliasKey      = DegradationWatchConfigName + ".channel_aliases"
	DegradationWatchDefaultGroup  = "GPT-企业"
	DegradationWatchDefaultModel  = "gpt-6-astra"
	DegradationWatchDefaultEffort = "medium"

	MinDegradationWatchIntervalMinutes  = 1
	MaxDegradationWatchIntervalMinutes  = 24 * 60
	MinDegradationWatchTimeoutSeconds   = 30
	MaxDegradationWatchTimeoutSeconds   = 3600
	MinDegradationWatchRetentionPerChan = 1
	MaxDegradationWatchRetentionPerChan = 2000
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

// ResolveDegradationWatchParams 把配置收敛成可直接使用的值：任何一项越界或
// 空白都回落到默认值，避免一条脏配置把定时任务卡死（例如间隔 0 会变成每轮
// 都跑，超时 0 会立刻取消）。
func ResolveDegradationWatchParams() (group string, model string, effort string, intervalMinutes int, timeoutSeconds int, retention int) {
	group = strings.TrimSpace(degradationWatchSetting.Group)
	if group == "" {
		group = DegradationWatchDefaultGroup
	}
	model = strings.TrimSpace(degradationWatchSetting.Model)
	if model == "" {
		model = DegradationWatchDefaultModel
	}
	effort = strings.TrimSpace(degradationWatchSetting.ReasoningEffort)

	intervalMinutes = degradationWatchSetting.IntervalMinutes
	if intervalMinutes < MinDegradationWatchIntervalMinutes || intervalMinutes > MaxDegradationWatchIntervalMinutes {
		intervalMinutes = 30
	}
	timeoutSeconds = degradationWatchSetting.TimeoutSeconds
	if timeoutSeconds < MinDegradationWatchTimeoutSeconds || timeoutSeconds > MaxDegradationWatchTimeoutSeconds {
		timeoutSeconds = 600
	}
	retention = degradationWatchSetting.RetentionPerChannel
	if retention < MinDegradationWatchRetentionPerChan || retention > MaxDegradationWatchRetentionPerChan {
		retention = 200
	}
	return
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
