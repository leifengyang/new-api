package operation_setting

import "github.com/QuantumNous/new-api/setting/config"

// InviteRebateSetting 控制邀请返现。
//
// 三个比例各用万分比存储（1000 = 10.00%），避免浮点数在「数据库 → 配置串 →
// 配置结构」往返中产生精度误差，比例本身也只需要两位小数。一笔充值最多触发
// 两条腿，每条腿按自己的比例独立结算，互不影响：某条腿的比例填 0 就是关掉
// 这条腿，另外两条照常发。
type InviteRebateSetting struct {
	Enabled bool `json:"enabled"`
	// RateBasisPoints 是第一条腿：内部学员的直属下线充值，返给该内部学员。
	RateBasisPoints int `json:"rate_basis_points"`
	// ExternalRateBasisPoints 是第二条腿：外部用户的直属下线充值，返给该外部用户。
	ExternalRateBasisPoints int `json:"external_rate_basis_points"`
	// InternalReferrerRateBasisPoints 是第三条腿：外部用户的直属下线充值，再返给
	// 该外部用户邀请链上第一个内部学员（往外走一层，等于奖励把外部用户带进来的人）。
	InternalReferrerRateBasisPoints int `json:"internal_referrer_rate_basis_points"`
}

// MaxInviteRebateRateBasisPoints 限制返现比例不超过 100%，防止后台填入
// 会放大到钱包上限的极端值。
const MaxInviteRebateRateBasisPoints = 10000

// 配置模块名与逐字段的选项 key。后台通过通用设置接口按 key 保存，前端也要用
// 同一组字符串，集中在这里避免两边各写一份字面量。
const (
	InviteRebateConfigName = "invite_rebate_setting"
	InviteRebateEnabledKey = InviteRebateConfigName + ".enabled"
	InviteRebateRateKey    = InviteRebateConfigName + ".rate_basis_points"
	// InviteRebateExternalRateKey / InviteRebateUplineRateKey 是这次新增的两条腿。
	// 存量部署的 options 表里没有这两个 key，配置按 key 读取，缺失即保留下面的
	// 默认值，因此升级后两条新腿会直接按 1% 生效，不需要数据迁移。
	InviteRebateExternalRateKey = InviteRebateConfigName + ".external_rate_basis_points"
	InviteRebateUplineRateKey   = InviteRebateConfigName + ".internal_referrer_rate_basis_points"
)

// 默认开启：内部学员的直属下线返 10%，外部用户的两条腿各返 1%。
var inviteRebateSetting = InviteRebateSetting{
	Enabled:                         true,
	RateBasisPoints:                 1000,
	ExternalRateBasisPoints:         100,
	InternalReferrerRateBasisPoints: 100,
}

func init() {
	config.GlobalConfig.Register(InviteRebateConfigName, &inviteRebateSetting)
}

func GetInviteRebateSetting() *InviteRebateSetting {
	return &inviteRebateSetting
}

// IsValidInviteRebateRateBasisPoints 校验后台填入的返现比例。0 表示关闭返现，
// 上界取 100% 以免单笔充值把邀请人钱包直接顶到 common.MaxWalletQuota。
func IsValidInviteRebateRateBasisPoints(rate int) bool {
	return rate >= 0 && rate <= MaxInviteRebateRateBasisPoints
}
