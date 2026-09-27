package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

// 触发返现的入账来源。所有把额度加进用户钱包的入口都必须在这里登记一个值，
// 否则 InviteRebate.SourceRef 无法保证唯一，返现的防重也就失去依据。
const (
	InviteRebateSourceEpay         = "epay"
	InviteRebateSourceStripe       = "stripe"
	InviteRebateSourceCreem        = "creem"
	InviteRebateSourceWaffo        = "waffo"
	InviteRebateSourceWaffoPancake = "waffo_pancake"
	InviteRebateSourceRedemption   = "redemption"
	InviteRebateSourceManual       = "manual"
)

const (
	InviteRebateStatusCredited = "credited"
	InviteRebateStatusSkipped  = "skipped"
)

// 返现的腿。一笔充值最多产生两条腿，各自对应一个独立比例、可以发给不同的人：
//
//	direct —— 直属下线充值，返给直接邀请人（内部学员按比例①，外部用户按比例②）
//	upline —— 外部用户的直属下线充值，再返给该外部用户邀请链上第一个内部学员（比例③）
//
// 存下来是为了让台账自己说得清「这笔钱是按哪条规则发的」，也免得后台要反推。
const (
	InviteRebateLegDirect = "direct"
	InviteRebateLegUpline = "upline"
)

// inviteRebateSavePoint 圈住一次返现尝试。理由见 creditInviteRebateTx。
// 每条腿各开一个保存点（名字带腿名）：同名的保存点会互相遮蔽，回滚内层会把
// 外层已经落库的那条腿一起带走，而两条腿必须各成败各的。
const inviteRebateSavePoint = "invite_rebate_attempt"

// maxInviterChainDepth 限制向上追溯邀请人的层数。正常邀请链只有个位数层，
// 这个上限是给脏数据准备的：自环或互相邀请的环会让追溯变成死循环。
const maxInviterChainDepth = 32

// rollbackToSavepoint 放弃保存点内的写入，并把外层充值事务救回可提交状态。
// 只能在保存点已经开好之后调用。
func rollbackToSavepoint(tx *gorm.DB, name string) {
	if err := tx.RollbackTo(name).Error; err != nil {
		common.SysError(fmt.Sprintf("invite rebate: failed to roll back to savepoint %s: %s", name, err.Error()))
	}
}

// InviteRebateSkipWalletLimit 表示邀请人钱包已到 common.MaxWalletQuota 上限，
// 返现无法入账。这种情况不影响付款人的充值。
const InviteRebateSkipWalletLimit = "inviter_wallet_limit"

var (
	ErrInviteRebateNotCredited = errors.New("该返现记录当前不可撤销")

	// ErrInviteRebateBalanceChanged 表示邀请人余额在撤销过程中被并发修改，
	// 本次撤销已整体回滚（流水与余额都没变），重试即可。
	ErrInviteRebateBalanceChanged = errors.New("邀请人余额已变化，请重试")
)

// 返现台账的唯一索引名。(Source, SourceRef, InviterId) 上的唯一索引是防重的
// 硬约束：上游的订单状态检查已经保证一笔充值只入账一次，但 webhook 重放、并发
// 回调仍可能让返现逻辑被二次触发。发放路径因此先写这条流水再动钱包——插入失败
// 即代表「这笔来源已经给这个人发过」，直接放弃，绝不会重复给同一个人加钱。
//
// 索引带 InviterId 而不是只带 SourceRef，是因为一笔充值现在可能发出两条腿、
// 落到两个不同的人头上：同一笔充值、同一个收款人只能有一条流水，不同收款人
// 各记各的。只按 (Source, SourceRef) 唯一会直接挡掉第二条腿。
//
// 早先的 idx_invite_rebate_source 只覆盖前两列，由 migrateInviteRebateGrantUniqueness
// 在 AutoMigrate 之前换掉，见那里的说明。
const inviteRebateGrantIndex = "idx_invite_rebate_grant"

// legacyInviteRebateSourceIndex 是上一版台账的唯一索引名，升级时会被丢弃。
const legacyInviteRebateSourceIndex = "idx_invite_rebate_source"

// InviteRebate 是邀请返现流水，也是返现的唯一事实来源。
//
// RateBasisPoints 是发放当时的比例快照，后台改比例只影响之后的返现。
// Leg 记录这笔钱是按哪条规则发的（direct / upline），见上面的腿常量。
type InviteRebate struct {
	Id        int    `json:"id" gorm:"primaryKey"`
	InviterId int    `json:"inviter_id" gorm:"index;not null;uniqueIndex:idx_invite_rebate_grant,priority:3"`
	InviteeId int    `json:"invitee_id" gorm:"index;not null"`
	Source    string `json:"source" gorm:"type:varchar(32);not null;uniqueIndex:idx_invite_rebate_grant,priority:1"`
	SourceRef string `json:"source_ref" gorm:"type:varchar(255);not null;uniqueIndex:idx_invite_rebate_grant,priority:2"`
	// Leg 的默认值同时承担存量行的回填：老台账只有「直属下线」这一条腿，
	// 加列时数据库会用默认值把已有行填成 direct，不需要额外的数据迁移。
	Leg             string `json:"leg" gorm:"type:varchar(16);not null;default:direct"`
	BaseQuota       int    `json:"base_quota" gorm:"type:bigint;not null;default:0"`
	RateBasisPoints int    `json:"rate_basis_points" gorm:"not null;default:0"`
	RebateQuota     int    `json:"rebate_quota" gorm:"type:bigint;not null;default:0"`
	Status          string `json:"status" gorm:"type:varchar(16);not null"`
	SkipReason      string `json:"skip_reason" gorm:"type:varchar(64);not null;default:''"`
	ReversedQuota   int    `json:"reversed_quota" gorm:"type:bigint;not null;default:0"`
	ReversedAt      int64  `json:"reversed_at" gorm:"type:bigint;not null;default:0"`
	ReversedBy      int    `json:"reversed_by" gorm:"not null;default:0"`
	ReverseReason   string `json:"reverse_reason" gorm:"type:varchar(255);not null;default:''"`
	CreatedAt       int64  `json:"created_at" gorm:"autoCreateTime;column:created_at"`
}

// OutstandingQuota 是这条腿还没被收回的额度。冲正按「能扣多少扣多少」处理，
// 扣不满的部分留在这里，既是对外展示的口径，也是「还要不要再冲一次」的依据。
func (rebate *InviteRebate) OutstandingQuota() int {
	return rebate.RebateQuota - rebate.ReversedQuota
}

// inviteRebateCredit 携带事务提交后需要落地的邀请人入账信息。余额缓存
// （Redis 存在时）是预扣费的权威值，授信必须在提交后补增量；日志同理，
// 它走独立连接，放进事务里既会拖长持锁时间，也会在单连接池下与事务争用
// 同一条连接而死锁。因此返现事务只碰 tx，收尾动作一律交给
// finalizeInviteRebate 在提交后执行。
type inviteRebateCredit struct {
	RebateId        int
	InviterId       int
	InviteeId       int
	BaseQuota       int
	RateBasisPoints int
	Quota           int
}

// inviteRebateLeg 是一条待发放的返现腿：发给谁、按哪条规则、比例多少。
type inviteRebateLeg struct {
	Inviter User
	Leg     string
	Rate    int
}

// creditInviteRebateTx 在充值事务内给邀请人发放返现，返回本次实际入账的腿。
//
// 一笔充值最多发两条腿，每条腿的比例各自独立（后台三个输入框）：
//
//	直属下线充值 → 直接邀请人拿一条 direct 腿：
//	    内部学员按比例①，外部用户按比例②
//	外部用户的直属下线充值 → 再发一条 upline 腿：
//	    从该外部用户的邀请人往上找，第一个「内部学员且非管理员」按比例③
//
// 两条腿互不依赖：比例填 0 就只是那条腿不发，另一条照常。
//
// 它刻意不返回错误：返现是充值的附带结果，任何失败（邀请人不存在、钱包触顶、
// 流水写入失败）都只能影响返现本身，绝不能让付款人的充值失败。无法入账的
// 情况会落库成 skipped 流水或写进错误日志，不会静默丢弃。
//
// 「不返回错误」还不够：写入部分必须跑在 SAVEPOINT 里。PostgreSQL 上一条语句
// 失败会把整个事务置为 aborted，此后连 COMMIT 都会变成 ROLLBACK——而「插入撞上
// (source, source_ref, inviter_id) 唯一索引」正是这里预期内的重放结果，只忽略
// 错误继续走的话，付款人的充值会被这笔返现一起回滚（钱收了、额度没到）。
// SQLite / MySQL 的失败语句不会污染事务，保存点在那里只是多一次往返；三个库
// 走同一条路径，行为不随方言分叉。
func creditInviteRebateTx(tx *gorm.DB, inviteeId int, baseQuota int, source string, sourceRef string) []*inviteRebateCredit {
	setting := operation_setting.GetInviteRebateSetting()
	if !setting.Enabled || baseQuota <= 0 || sourceRef == "" {
		return nil
	}

	var invitee User
	if err := tx.Select("inviter_id").First(&invitee, inviteeId).Error; err != nil {
		common.SysError(fmt.Sprintf("invite rebate: failed to load invitee %d: %s", inviteeId, err.Error()))
		return nil
	}
	if invitee.InviterId == 0 || invitee.InviterId == inviteeId {
		return nil
	}

	var inviter User
	if err := tx.Select("id", "inviter_id", "role", "member_level").First(&inviter, invitee.InviterId).Error; err != nil {
		common.SysError(fmt.Sprintf("invite rebate: inviter %d of user %d not found: %s", invitee.InviterId, inviteeId, err.Error()))
		return nil
	}
	// 管理员不参与：管理员名下的用户充值属于自己的业务收入，再返到管理账号
	// 只是同一个人内部的账目搬运。管理员的下线因此既不触发直属腿，也不往上
	// 追溯第三腿。
	if inviter.Role >= common.RoleAdminUser {
		return nil
	}

	legs := make([]inviteRebateLeg, 0, 2)
	if inviter.MemberLevel == MemberLevelInternal {
		legs = append(legs, inviteRebateLeg{Inviter: inviter, Leg: InviteRebateLegDirect, Rate: setting.RateBasisPoints})
	} else {
		legs = append(legs, inviteRebateLeg{Inviter: inviter, Leg: InviteRebateLegDirect, Rate: setting.ExternalRateBasisPoints})
		// 第三腿只认「外部用户的下线充值」：往上找到的第一个内部学员拿钱，
		// 中间隔着的其他外部用户不参与。
		if upline, ok := findUplineInternalInviter(tx, inviter.Id); ok {
			legs = append(legs, inviteRebateLeg{Inviter: upline, Leg: InviteRebateLegUpline, Rate: setting.InternalReferrerRateBasisPoints})
		}
	}

	credits := make([]*inviteRebateCredit, 0, len(legs))
	for _, leg := range legs {
		if credit := creditInviteRebateLegTx(tx, inviteeId, baseQuota, source, sourceRef, leg); credit != nil {
			credits = append(credits, credit)
		}
	}
	// 一条腿都没发出去时回 nil 而不是空切片：调用方与用例都按「什么都没发生」
	// 判断，空切片非 nil，会让 assert.Nil 这类判断悄悄变成假阳性。
	if len(credits) == 0 {
		return nil
	}
	return credits
}

// findUplineInternalInviter 从 fromUserId 的邀请人开始向上找，返回第一个
// 「内部学员且非管理员」。
//
// 走到管理员就停：管理员是邀请树的根，再往上是另一个人的关系网，不该为这批
// 用户付钱。管理员是邀请返现里唯一的身份例外，停在这里与 creditInviteRebateTx
// 里「管理员不参与」是同一个口径。
func findUplineInternalInviter(tx *gorm.DB, fromUserId int) (User, bool) {
	current := fromUserId
	for depth := 0; depth < maxInviterChainDepth; depth++ {
		var node User
		if err := tx.Select("id", "inviter_id").First(&node, current).Error; err != nil {
			common.SysError(fmt.Sprintf("invite rebate: failed to walk inviter chain at user %d: %s", current, err.Error()))
			return User{}, false
		}
		parentId := node.InviterId
		// parentId == current 是自环，0 是链到头，两者都说明没有更上层的内部学员。
		if parentId <= 0 || parentId == current {
			return User{}, false
		}
		var parent User
		if err := tx.Select("id", "role", "member_level").First(&parent, parentId).Error; err != nil {
			common.SysError(fmt.Sprintf("invite rebate: upline inviter %d not found: %s", parentId, err.Error()))
			return User{}, false
		}
		if parent.Role >= common.RoleAdminUser {
			return User{}, false
		}
		if parent.MemberLevel == MemberLevelInternal {
			return parent, true
		}
		current = parent.Id
	}
	common.SysError(fmt.Sprintf("invite rebate: inviter chain from user %d exceeds %d levels, stopped", fromUserId, maxInviterChainDepth))
	return User{}, false
}

// creditInviteRebateLegTx 发放一条腿：写流水、加余额，全程在自己的保存点内。
func creditInviteRebateLegTx(tx *gorm.DB, inviteeId int, baseQuota int, source string, sourceRef string, leg inviteRebateLeg) *inviteRebateCredit {
	if leg.Rate <= 0 {
		return nil
	}

	// 比例是整数万分比，乘除在 decimal 下都是精确的（结果最多 4 位小数），
	// 因此用 decimal 而不是 float。
	//
	// 必须走钱包域的 WalletQuotaFromDecimalStrict：QuotaFromFloatChecked 那类
	// 辅助函数把结果截断在 int32（单请求）边界上，一次大额充值的返现会被
	// 悄悄压到 21 亿以下，对不上账。
	rebateQuota, err := common.WalletQuotaFromDecimalStrict(
		decimal.NewFromInt(int64(baseQuota)).
			Mul(decimal.NewFromInt(int64(leg.Rate))).
			Div(decimal.NewFromInt(10000)),
	)
	if err != nil {
		// 溢出只可能来自被改坏的比例值。宁可放弃这笔返现，也不写一个被截断的金额。
		common.SysError(fmt.Sprintf("invite rebate: refuses saturated amount for invitee %d: %s", inviteeId, err.Error()))
		return nil
	}
	if rebateQuota <= 0 {
		return nil
	}

	record := InviteRebate{
		InviterId:       leg.Inviter.Id,
		InviteeId:       inviteeId,
		Source:          source,
		SourceRef:       sourceRef,
		Leg:             leg.Leg,
		BaseQuota:       baseQuota,
		RateBasisPoints: leg.Rate,
		RebateQuota:     rebateQuota,
		Status:          InviteRebateStatusCredited,
	}

	savePoint := inviteRebateSavePoint + "_" + leg.Leg
	// 前面的分支都还没写过库，保存点因此开在第一次写入之前。
	if err := tx.SavePoint(savePoint).Error; err != nil {
		common.SysError(fmt.Sprintf("invite rebate: failed to open savepoint for %s/%s: %s", source, sourceRef, err.Error()))
		return nil
	}

	// 先落流水再加钱，顺序不能反：唯一索引是防重的唯一硬约束，如果先加钱，
	// 重放的流水会被索引拦下但钱已经进了邀请人钱包，重放一次就多送一次。
	// 插入失败即代表这笔来源已经发过（或返现侧本身出问题），直接放弃。
	if err := tx.Create(&record).Error; err != nil {
		common.SysError(fmt.Sprintf("invite rebate: failed to record %s rebate for %s/%s: %s", leg.Leg, source, sourceRef, err.Error()))
		rollbackToSavepoint(tx, savePoint)
		return nil
	}

	if err := creditInviterWalletTx(tx, leg.Inviter.Id, rebateQuota); err != nil {
		if !errors.Is(err, ErrInviteRebateWalletLimit) {
			common.SysError(fmt.Sprintf("invite rebate: failed to credit inviter %d: %s", leg.Inviter.Id, err.Error()))
			rollbackToSavepoint(tx, savePoint)
			return nil
		}
		// 钱包触顶时改写成 skipped 留档，基数与比例保留，管理员能看到本该返多少。
		record.Status = InviteRebateStatusSkipped
		record.SkipReason = InviteRebateSkipWalletLimit
		record.RebateQuota = 0
		if saveErr := tx.Save(&record).Error; saveErr != nil {
			common.SysError(fmt.Sprintf("invite rebate: failed to mark rebate %d skipped: %s", record.Id, saveErr.Error()))
			rollbackToSavepoint(tx, savePoint)
			return nil
		}
		common.SysError(fmt.Sprintf("invite rebate: inviter %d wallet at limit, %s rebate of %d skipped", leg.Inviter.Id, leg.Leg, rebateQuota))
		return nil
	}

	return &inviteRebateCredit{
		RebateId:        record.Id,
		InviterId:       leg.Inviter.Id,
		InviteeId:       inviteeId,
		BaseQuota:       baseQuota,
		RateBasisPoints: record.RateBasisPoints,
		Quota:           rebateQuota,
	}
}

// ErrInviteRebateWalletLimit 表示邀请人钱包余额已达上限，本次返现未入账。
var ErrInviteRebateWalletLimit = errors.New("邀请人钱包额度已达上限")

// creditInviterWalletTx 复刻 creditTopUpQuota 的上限守卫：把上限判断和自增放在
// 同一条 UPDATE 里，避免并发回调各自读到旧余额后一起越过上限。
func creditInviterWalletTx(tx *gorm.DB, inviterId int, quota int) error {
	maxCurrentQuota, err := topUpQuotaMaxCurrent(quota)
	if err != nil {
		return err
	}
	result := tx.Model(&User{}).
		Where("id = ? AND quota <= ?", inviterId, maxCurrentQuota).
		Update("quota", gorm.Expr("quota + ?", quota))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrInviteRebateWalletLimit
	}
	return nil
}

// finalizeInviteRebate 是返现的唯一收尾入口，必须在充值事务提交后调用：
// 把每条腿的增量补进余额缓存，并各写一条归属邀请人的流水日志。
// 一笔充值可能同时给两个人发钱，因此入参是腿的集合。
func finalizeInviteRebate(credits []*inviteRebateCredit) {
	for _, credit := range credits {
		if credit == nil || credit.Quota <= 0 {
			continue
		}
		syncCreditUserQuotaCache(credit.InviterId, credit.Quota, "invite rebate")
		// 带上流水号，便于从用户日志直接定位到后台的返现记录。
		RecordLog(credit.InviterId, LogTypeSystem, fmt.Sprintf("邀请返现 #%d：下线用户 %d 充值 %s，按 %.2f%% 返现 %s",
			credit.RebateId, credit.InviteeId, logger.LogQuota(credit.BaseQuota),
			float64(credit.RateBasisPoints)/100, logger.LogQuota(credit.Quota)))
	}
}

// ReverseInviteRebate 撤销一笔返现。入参是台账里任意一条腿的 id，实际撤销的是
// 它所属的那一整笔充值：一笔充值可能同时给直属邀请人和上层内部学员发过钱，
// 冲正时两条腿必须一起走，否则会留下一半收不回的返现。
//
// 返现已经变成邀请人的可用余额，可能已被消费，因此这里按「能扣多少扣多少」
// 处理：最多扣到余额为 0，未收回的部分留在流水的 RebateQuota 与 ReversedQuota
// 差额里，不产生负余额。余额缓存同步在事务提交后按实际扣减量递减。
//
// 整笔是一个事务：任何一条腿扣款失败（余额被并发改动）都会全部回滚，让管理员
// 看到「请重试」而不是一个只冲了一半的账。
func ReverseInviteRebate(rebateId int, operatorId int, reason string) ([]ReversedInviteRebate, error) {
	if rebateId <= 0 {
		return nil, errors.New("返现记录 id 无效")
	}
	anchor := &InviteRebate{}
	reversed := make([]ReversedInviteRebate, 0, 2)
	err := DB.Transaction(func(tx *gorm.DB) error {
		reversed = reversed[:0]
		if err := lockForUpdate(tx).First(anchor, rebateId).Error; err != nil {
			return err
		}
		if anchor.Status != InviteRebateStatusCredited || anchor.OutstandingQuota() <= 0 {
			return ErrInviteRebateNotCredited
		}

		var legs []*InviteRebate
		if err := lockForUpdate(tx).
			Where("source = ? AND source_ref = ?", anchor.Source, anchor.SourceRef).
			Order("id asc").
			Find(&legs).Error; err != nil {
			return err
		}

		for _, leg := range legs {
			if leg.Status != InviteRebateStatusCredited {
				continue
			}
			outstanding := leg.OutstandingQuota()
			if outstanding <= 0 {
				continue
			}
			deducted, err := reverseInviteRebateLegTx(tx, leg, outstanding, operatorId, reason)
			if err != nil {
				return err
			}
			reversed = append(reversed, ReversedInviteRebate{Rebate: leg, Deducted: deducted})
		}
		if len(reversed) == 0 {
			return ErrInviteRebateNotCredited
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	for _, leg := range reversed {
		if leg.Deducted <= 0 {
			continue
		}
		if err := cacheDecrUserQuota(leg.Rebate.InviterId, int64(leg.Deducted)); err != nil {
			common.SysLog(fmt.Sprintf("failed to sync invite rebate reversal to user quota cache: %s", err.Error()))
		}
		RecordLog(leg.Rebate.InviterId, LogTypeSystem, fmt.Sprintf("邀请返现被撤销：应扣 %s，实扣 %s，原因：%s",
			logger.LogQuota(leg.Rebate.RebateQuota-leg.Rebate.ReversedQuota+leg.Deducted),
			logger.LogQuota(leg.Deducted), reason))
	}
	return reversed, nil
}

// ReversedInviteRebate 是一次冲正里的一条腿：冲正后的流水，以及实际收回的额度。
// 两者都要给审计日志用——「该扣多少」和「真扣到多少」在返现被花掉后并不相等。
type ReversedInviteRebate struct {
	Rebate   *InviteRebate
	Deducted int
}

// reverseInviteRebateLegTx 扣掉一条腿能扣的部分，返回实际收回的额度。
// outstanding 是调用方在同一个事务里读到的未收回金额。
func reverseInviteRebateLegTx(tx *gorm.DB, leg *InviteRebate, outstanding int, operatorId int, reason string) (int, error) {
	var inviter User
	if err := lockForUpdate(tx).Select("id", "quota").First(&inviter, leg.InviterId).Error; err != nil {
		return 0, err
	}
	deducted := min(outstanding, max(inviter.Quota, 0))
	previousReversed := leg.ReversedQuota

	// 先占坑再扣钱：以读到的 reversed_quota 作比较并交换。并发的第二次撤销
	// 会在这里拿到 0 行并放弃，不会去动钱包。SQLite 上 lockForUpdate 是空
	// 操作，如果没有这道 CAS，两次并发撤销会各自读到同一份旧值并重复扣款。
	ledger := tx.Model(&InviteRebate{}).
		Where("id = ? AND reversed_quota = ?", leg.Id, previousReversed).
		Updates(map[string]any{
			"reversed_quota": gorm.Expr("reversed_quota + ?", deducted),
			"reversed_at":    common.GetTimestamp(),
			"reversed_by":    operatorId,
			"reverse_reason": reason,
		})
	if ledger.Error != nil {
		return 0, ledger.Error
	}
	if ledger.RowsAffected == 0 {
		return 0, ErrInviteRebateNotCredited
	}

	if deducted > 0 {
		// 条件更新兜底：即使余额在读取之后被别的并发事务動过，也扣不到负数。
		// 影响到 0 行说明余额已不足本次扣减，整笔回滚让管理员重试。
		result := tx.Model(&User{}).Where("id = ? AND quota >= ?", inviter.Id, deducted).
			Update("quota", gorm.Expr("quota - ?", deducted))
		if result.Error != nil {
			return 0, result.Error
		}
		if result.RowsAffected == 0 {
			return 0, ErrInviteRebateBalanceChanged
		}
	}

	leg.ReversedQuota = previousReversed + deducted
	leg.ReversedAt = common.GetTimestamp()
	leg.ReversedBy = operatorId
	leg.ReverseReason = reason
	return deducted, nil
}

// InviteRebateFilter 描述返现流水的查询条件，零值表示不限制该维度。
type InviteRebateFilter struct {
	InviterId int
	InviteeId int
	Keyword   string
	Source    string
	Status    string
	StartTime int64
	EndTime   int64
}

func buildInviteRebateQuery(filter InviteRebateFilter) *gorm.DB {
	query := DB.Model(&InviteRebate{})
	if filter.InviterId != 0 {
		query = query.Where("inviter_id = ?", filter.InviterId)
	}
	if filter.InviteeId != 0 {
		query = query.Where("invitee_id = ?", filter.InviteeId)
	}
	if filter.Keyword != "" {
		// 按用户名查账：管理员手上只有学员名字，没有 id。! 作为 ESCAPE 字符，
		// 兼容 SQLite / MySQL / PostgreSQL（与 model/log.go 同一约定）。
		keyword := strings.ReplaceAll(filter.Keyword, "!", "!!")
		keyword = strings.ReplaceAll(keyword, "_", "!_")
		pattern := "%" + keyword + "%"
		// Unscoped：已注销学员留下的历史返现仍要能被搜到，与 GetUsernamesByIds 一致。
		query = query.Where(
			"inviter_id IN (?) OR invitee_id IN (?)",
			DB.Unscoped().Model(&User{}).Select("id").Where("username LIKE ? ESCAPE '!'", pattern),
			DB.Unscoped().Model(&User{}).Select("id").Where("username LIKE ? ESCAPE '!'", pattern),
		)
	}
	if filter.Source != "" {
		query = query.Where("source = ?", filter.Source)
	}
	if filter.Status != "" {
		query = query.Where("status = ?", filter.Status)
	}
	if filter.StartTime != 0 {
		query = query.Where("created_at >= ?", filter.StartTime)
	}
	if filter.EndTime != 0 {
		query = query.Where("created_at <= ?", filter.EndTime)
	}
	return query
}

// GetInviteRebates 按时间倒序分页返回返现流水。
func GetInviteRebates(filter InviteRebateFilter, offset int, limit int) ([]*InviteRebate, int64, error) {
	var total int64
	if err := buildInviteRebateQuery(filter).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	rebates := make([]*InviteRebate, 0)
	err := buildInviteRebateQuery(filter).
		Order("id desc").
		Offset(offset).
		Limit(limit).
		Find(&rebates).Error
	return rebates, total, err
}

// InviteRebateSummary 是某个邀请人的累计返现，供用户端汇总展示。
type InviteRebateSummary struct {
	TotalQuota    int   `json:"total_quota"`
	ReversedQuota int   `json:"reversed_quota"`
	RebateCount   int64 `json:"rebate_count"`
}

func GetInviteRebateSummary(inviterId int) (*InviteRebateSummary, error) {
	summary := &InviteRebateSummary{}
	err := DB.Model(&InviteRebate{}).
		Select("COALESCE(SUM(rebate_quota), 0) AS total_quota, COALESCE(SUM(reversed_quota), 0) AS reversed_quota, COUNT(*) AS rebate_count").
		Where("inviter_id = ? AND status = ?", inviterId, InviteRebateStatusCredited).
		Scan(summary).Error
	if err != nil {
		return nil, err
	}
	return summary, nil
}

// fillInviteRebateTotals 给一页用户填上各自的累计返现，供管理端用户列表展示。
//
// 口径与用户端钱包里的「累计返现」一致（GetInviteRebateSummary）：只算已入账的
// 流水，按返现原额累计。冲正只是把这笔钱收回去，不代表当初没发过，后台流水页
// 会单独呈现，这里不重复扣减——否则管理员看到的数字会和学员自己看到的对不上。
//
// 列表是一页 User，逐行调用汇总会变成 N+1 次查询，所以用一次 GROUP BY 取回整页。
func fillInviteRebateTotals(users []*User) error {
	if len(users) == 0 {
		return nil
	}
	ids := make([]int, 0, len(users))
	for _, user := range users {
		ids = append(ids, user.Id)
	}
	var totals []struct {
		InviterId int
		Total     int
	}
	if err := DB.Model(&InviteRebate{}).
		Select("inviter_id, SUM(rebate_quota) AS total").
		Where("inviter_id IN ? AND status = ?", ids, InviteRebateStatusCredited).
		Group("inviter_id").
		Scan(&totals).Error; err != nil {
		return err
	}
	byInviter := make(map[int]int, len(totals))
	for _, row := range totals {
		byInviter[row.InviterId] = row.Total
	}
	for _, user := range users {
		user.InviteRebateQuota = byInviter[user.Id]
	}
	return nil
}

// ErrInvitationRequired 表示站点开启了仅邀请注册，而这次自助注册没有携带有效的
// 邀请码。调用方负责把它翻译成用户可见的提示。
var ErrInvitationRequired = errors.New("a valid invitation code is required for registration")

// ResolveRegistrationInviter 解析自助注册携带的邀请码，并执行「仅邀请注册」准入。
//
// 邀请码是邀请人的推广码（aff_code）。站点开启仅邀请注册后，没有携带或携带了无效
// 推广码的注册一律拒绝；判定只认服务端解析出的邀请人，前端是否渲染注册表单不构成
// 任何准入依据。关闭该开关时保持历史行为：邀请码只是归属信息，解析不出邀请人时
// 照样建号。
func ResolveRegistrationInviter(affCode string) (int, error) {
	admission, err := ResolveRegistrationAdmission(affCode)
	if err != nil {
		return 0, err
	}
	return admission.InviterId, nil
}

// RegistrationAdmission 是一次自助注册的准入结果。
type RegistrationAdmission struct {
	// InviterId 是邀请返现关系里的邀请人。企业成员恒为 0：企业管理员是在履行
	// 管理职责，不是在发展下线，用他的链接注册进来的人不该给他带来返现。
	InviterId int
	// EnterpriseOwnerId 非 0 时，新用户归属到这家企业名下。
	EnterpriseOwnerId int
}

// ResolveRegistrationAdmission 解析自助注册携带的邀请码，并执行「仅邀请注册」准入。
//
// 邀请码是企业 / 用户的推广码（aff_code）。企业账号的推广链接同时就是它的成员
// 邀请链接：用这个码注册进来的新用户直接挂到该企业名下，且不与企业账号建立
// 邀请返现关系。判定只认服务端解析出的账号，前端是否渲染注册表单不构成准入依据。
func ResolveRegistrationAdmission(affCode string) (RegistrationAdmission, error) {
	inviterId, _ := GetUserIdByAffCode(affCode)
	if inviterId <= 0 {
		if common.InviteOnlyRegistrationEnabled {
			return RegistrationAdmission{}, ErrInvitationRequired
		}
		return RegistrationAdmission{}, nil
	}
	enterpriseOwnerId, err := enterpriseOwnerForInviter(inviterId)
	if err != nil {
		return RegistrationAdmission{}, err
	}
	if enterpriseOwnerId > 0 {
		return RegistrationAdmission{EnterpriseOwnerId: enterpriseOwnerId}, nil
	}
	return RegistrationAdmission{InviterId: inviterId}, nil
}

// enterpriseOwnerForInviter 判断邀请人是不是企业账号，是则返回它的 id。
//
// 读失败直接把错误往上抛，不退回「当成普通邀请人」：那等于把一次数据库故障
// 变成一条不该存在的返现关系，而注册本来就要连库，失败一次不会更糟。
func enterpriseOwnerForInviter(inviterId int) (int, error) {
	var inviter User
	if err := DB.Select("id", "is_enterprise", "role").First(&inviter, inviterId).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil
		}
		return 0, err
	}
	if inviter.IsEnterprise == EnterpriseFlagYes && inviter.Role == common.RoleCommonUser {
		return inviter.Id, nil
	}
	return 0, nil
}

// resolveMemberLevelForNewUser 决定新注册用户的会员等级，必须在建号事务内调用。
//
// 只有通过管理员邀请链接进来的用户才是内部学员。内部学员自己发出的链接拉进来
// 的人仍然是外部用户——内部身份是训练营的准入资格，不该顺着邀请链路无限扩散。
func resolveMemberLevelForNewUser(tx *gorm.DB, inviterId int) int {
	if inviterId <= 0 {
		return MemberLevelNormal
	}
	var inviter User
	if err := tx.Select("id", "role").First(&inviter, inviterId).Error; err != nil {
		// 邀请人不存在（如已注销）不应阻断注册，按外部用户处理。
		common.SysError(fmt.Sprintf("failed to resolve inviter %d for member level: %s", inviterId, err.Error()))
		return MemberLevelNormal
	}
	if inviter.Role >= common.RoleAdminUser {
		return MemberLevelInternal
	}
	return MemberLevelNormal
}

// IsInviteRebateEligible 判断某个用户是否有资格拿邀请返现。内部学员拿比例①，
// 外部用户拿比例②，两条腿都是每笔充值都发，因此除管理员外人人都有资格；管理员
// 不参与（返到自己账号只是同一个人内部的账目搬运）。与 creditInviteRebateTx 里的
// 判定保持一致，前端的展示开关也走这里。
func IsInviteRebateEligible(userId int) bool {
	var user User
	if err := DB.Select("id", "role").First(&user, userId).Error; err != nil {
		return false
	}
	return user.Role < common.RoleAdminUser
}

// GetUserMemberLevel 单独读取会员等级，避免为了一次展示把整个用户行取出来。
func GetUserMemberLevel(userId int) int {
	var user User
	if err := DB.Select("member_level").First(&user, userId).Error; err != nil {
		return MemberLevelNormal
	}
	return user.MemberLevel
}

// GetUsernamesByIds 批量取用户名，供返现流水展示。用 Unscoped 是为了让已注销
// 用户的历史返现仍能显示名称，而不是留下一片无从解释的空行。
func GetUsernamesByIds(ids []int) (map[int]string, error) {
	unique := make([]int, 0, len(ids))
	seen := make(map[int]struct{}, len(ids))
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	usernames := make(map[int]string, len(unique))
	if len(unique) == 0 {
		return usernames, nil
	}
	var users []User
	if err := DB.Unscoped().Model(&User{}).
		Select("id", "username").
		Where("id IN ?", unique).
		Find(&users).Error; err != nil {
		return nil, err
	}
	for _, user := range users {
		usernames[user.Id] = user.Username
	}
	return usernames, nil
}

// maxMemberLevelBatchSize 限制一次批量设置身份的用户数，避免超长 IN 子句。
const maxMemberLevelBatchSize = 500

// UpdateUserMemberLevel 手动调整单个用户的会员等级。存量学员和历史特例靠它纠正。
func UpdateUserMemberLevel(userId int, level int) error {
	if userId <= 0 {
		return errors.New("用户 id 无效")
	}
	if !IsValidMemberLevel(level) {
		return errors.New("会员等级取值无效")
	}
	result := DB.Model(&User{}).Where("id = ?", userId).Update("member_level", level)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// UpdateUsersMemberLevelByBatch 批量设置会员等级，返回实际更新的用户数。
func UpdateUsersMemberLevelByBatch(userIds []int, level int) (int64, error) {
	if len(userIds) == 0 {
		return 0, errors.New("请选择用户")
	}
	if len(userIds) > maxMemberLevelBatchSize {
		return 0, fmt.Errorf("一次最多设置 %d 个用户", maxMemberLevelBatchSize)
	}
	if !IsValidMemberLevel(level) {
		return 0, errors.New("会员等级取值无效")
	}
	result := DB.Model(&User{}).Where("id IN ?", userIds).Update("member_level", level)
	return result.RowsAffected, result.Error
}
