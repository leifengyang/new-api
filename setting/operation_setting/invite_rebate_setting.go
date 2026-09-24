package operation_setting

import "github.com/QuantumNous/new-api/setting/config"

// InviteRebateSetting 控制内部学员的邀请返现。
//
// RateBasisPoints 用万分比存储（1000 = 10.00%），避免浮点数在「数据库 →
// 配置串 → 配置结构」往返中产生精度误差，比例本身也只需要两位小数。
type InviteRebateSetting struct {
	Enabled         bool `json:"enabled"`
	RateBasisPoints int  `json:"rate_basis_points"`
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
)

// 默认开启并按产品约定返现 10%。
var inviteRebateSetting = InviteRebateSetting{
	Enabled:         true,
	RateBasisPoints: 1000,
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
