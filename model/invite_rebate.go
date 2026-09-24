package model

import (
	"errors"
	"fmt"

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

// InviteRebateSkipWalletLimit 表示邀请人钱包已到 common.MaxWalletQuota 上限，
// 返现无法入账。这种情况不影响付款人的充值。
const InviteRebateSkipWalletLimit = "inviter_wallet_limit"

var (
	ErrInviteRebateNotCredited = errors.New("该返现记录当前不可撤销")

	// ErrInviteRebateBalanceChanged 表示邀请人余额在撤销过程中被并发修改，
	// 本次撤销已整体回滚（流水与余额都没变），重试即可。
	ErrInviteRebateBalanceChanged = errors.New("邀请人余额已变化，请重试")
)

// InviteRebate 是邀请返现流水，也是返现的唯一事实来源。
//
// (Source, SourceRef) 上的唯一索引是防重的硬约束：上游的订单状态检查已经保证
// 一笔充值只入账一次，但 webhook 重放、并发回调仍可能让返现逻辑被二次触发。
// 发放路径因此先写这条流水再动钱包——插入失败即代表这笔来源已经发过，直接
// 放弃，绝不会重复给邀请人加钱。
//
// RateBasisPoints 是发放当时的比例快照，后台改比例只影响之后的返现。
type InviteRebate struct {
	Id              int    `json:"id" gorm:"primaryKey"`
	InviterId       int    `json:"inviter_id" gorm:"index;not null"`
	InviteeId       int    `json:"invitee_id" gorm:"index;not null"`
	Source          string `json:"source" gorm:"type:varchar(32);not null;uniqueIndex:idx_invite_rebate_source,priority:1"`
	SourceRef       string `json:"source_ref" gorm:"type:varchar(255);not null;uniqueIndex:idx_invite_rebate_source,priority:2"`
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

// creditInviteRebateTx 在充值事务内给邀请人发放返现。
//
// 它刻意不返回错误：返现是充值的附带结果，任何失败（邀请人不存在、钱包触顶、
// 流水写入失败）都只能影响返现本身，绝不能让付款人的充值失败。无法入账的
// 情况会落库成 skipped 流水或写进错误日志，不会静默丢弃。
func creditInviteRebateTx(tx *gorm.DB, inviteeId int, baseQuota int, source string, sourceRef string) *inviteRebateCredit {
	setting := operation_setting.GetInviteRebateSetting()
	if !setting.Enabled || setting.RateBasisPoints <= 0 || baseQuota <= 0 || sourceRef == "" {
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
	if err := tx.Select("id", "role", "member_level").First(&inviter, invitee.InviterId).Error; err != nil {
		common.SysError(fmt.Sprintf("invite rebate: inviter %d of user %d not found: %s", invitee.InviterId, inviteeId, err.Error()))
		return nil
	}
	// 只有内部学员能拿返现。管理员不参与：管理员名下的用户充值属于自己的
	// 业务收入，再返到管理账号只是同一个人内部的账目搬运。
	if inviter.MemberLevel != MemberLevelInternal || inviter.Role >= common.RoleAdminUser {
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
			Mul(decimal.NewFromInt(int64(setting.RateBasisPoints))).
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
		InviterId:       inviter.Id,
		InviteeId:       inviteeId,
		Source:          source,
		SourceRef:       sourceRef,
		BaseQuota:       baseQuota,
		RateBasisPoints: setting.RateBasisPoints,
		RebateQuota:     rebateQuota,
		Status:          InviteRebateStatusCredited,
	}

	// 先落流水再加钱，顺序不能反：唯一索引是防重的唯一硬约束，如果先加钱，
	// 重放的流水会被索引拦下但钱已经进了邀请人钱包，重放一次就多送一次。
	// 插入失败即代表这笔来源已经发过（或返现侧本身出问题），直接放弃。
	if err := tx.Create(&record).Error; err != nil {
		common.SysError(fmt.Sprintf("invite rebate: failed to record rebate for %s/%s: %s", source, sourceRef, err.Error()))
		return nil
	}

	if err := creditInviterWalletTx(tx, inviter.Id, rebateQuota); err != nil {
		if !errors.Is(err, ErrInviteRebateWalletLimit) {
			common.SysError(fmt.Sprintf("invite rebate: failed to credit inviter %d: %s", inviter.Id, err.Error()))
			return nil
		}
		// 钱包触顶时改写成 skipped 留档，基数与比例保留，管理员能看到本该返多少。
		record.Status = InviteRebateStatusSkipped
		record.SkipReason = InviteRebateSkipWalletLimit
		record.RebateQuota = 0
		if saveErr := tx.Save(&record).Error; saveErr != nil {
			common.SysError(fmt.Sprintf("invite rebate: failed to mark rebate %d skipped: %s", record.Id, saveErr.Error()))
		}
		common.SysError(fmt.Sprintf("invite rebate: inviter %d wallet at limit, rebate of %d skipped", inviter.Id, rebateQuota))
		return nil
	}

	return &inviteRebateCredit{
		RebateId:        record.Id,
		InviterId:       inviter.Id,
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
// 把增量补进余额缓存，并写一条归属邀请人的流水日志。
func finalizeInviteRebate(credit *inviteRebateCredit) {
	if credit == nil || credit.Quota <= 0 {
		return
	}
	syncCreditUserQuotaCache(credit.InviterId, credit.Quota, "invite rebate")
	// 带上流水号，便于从用户日志直接定位到后台的返现记录。
	RecordLog(credit.InviterId, LogTypeSystem, fmt.Sprintf("邀请返现 #%d：下线用户 %d 充值 %s，按 %.2f%% 返现 %s",
		credit.RebateId, credit.InviteeId, logger.LogQuota(credit.BaseQuota),
		float64(credit.RateBasisPoints)/100, logger.LogQuota(credit.Quota)))
}

// ReverseInviteRebate 撤销一笔已入账的返现。
//
// 返现已经变成邀请人的可用余额，可能已被消费，因此这里按「能扣多少扣多少」
// 处理：最多扣到余额为 0，未收回的部分留在流水的 RebateQuota 与 ReversedQuota
// 差额里，不产生负余额。余额缓存同步在事务提交后按实际扣减量递减。
func ReverseInviteRebate(rebateId int, operatorId int, reason string) (*InviteRebate, error) {
	if rebateId <= 0 {
		return nil, errors.New("返现记录 id 无效")
	}
	rebate := &InviteRebate{}
	deducted := 0
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).First(rebate, rebateId).Error; err != nil {
			return err
		}
		if rebate.Status != InviteRebateStatusCredited {
			return ErrInviteRebateNotCredited
		}
		outstanding := rebate.RebateQuota - rebate.ReversedQuota
		if outstanding <= 0 {
			return ErrInviteRebateNotCredited
		}

		var inviter User
		if err := lockForUpdate(tx).Select("id", "quota").First(&inviter, rebate.InviterId).Error; err != nil {
			return err
		}
		deducted = min(outstanding, max(inviter.Quota, 0))
		previousReversed := rebate.ReversedQuota

		// 先占坑再加钱：以读到的 reversed_quota 作比较并交换。并发的第二次撤销
		// 会在这里拿到 0 行并放弃，不会去动钱包。SQLite 上 lockForUpdate 是空
		// 操作，如果没有这道 CAS，两次并发撤销会各自读到同一份旧值并重复扣款。
		ledger := tx.Model(&InviteRebate{}).
			Where("id = ? AND reversed_quota = ?", rebate.Id, previousReversed).
			Updates(map[string]any{
				"reversed_quota": gorm.Expr("reversed_quota + ?", deducted),
				"reversed_at":    common.GetTimestamp(),
				"reversed_by":    operatorId,
				"reverse_reason": reason,
			})
		if ledger.Error != nil {
			return ledger.Error
		}
		if ledger.RowsAffected == 0 {
			return ErrInviteRebateNotCredited
		}

		if deducted > 0 {
			// 条件更新兜底：即使余额在读取之后被别的并发事务動过，也扣不到负数。
			// 影响到 0 行说明余额已不足本次扣减，整笔回滚让管理员重试。
			result := tx.Model(&User{}).Where("id = ? AND quota >= ?", inviter.Id, deducted).
				Update("quota", gorm.Expr("quota - ?", deducted))
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 0 {
				return ErrInviteRebateBalanceChanged
			}
		}

		rebate.ReversedQuota = previousReversed + deducted
		rebate.ReversedAt = common.GetTimestamp()
		rebate.ReversedBy = operatorId
		rebate.ReverseReason = reason
		return nil
	})
	if err != nil {
		return nil, err
	}

	if deducted > 0 {
		if err := cacheDecrUserQuota(rebate.InviterId, int64(deducted)); err != nil {
			common.SysLog(fmt.Sprintf("failed to sync invite rebate reversal to user quota cache: %s", err.Error()))
		}
		RecordLog(rebate.InviterId, LogTypeSystem, fmt.Sprintf("邀请返现被撤销：应扣 %s，实扣 %s，原因：%s",
			logger.LogQuota(rebate.RebateQuota-rebate.ReversedQuota+deducted), logger.LogQuota(deducted), reason))
	}
	return rebate, nil
}

// InviteRebateFilter 描述返现流水的查询条件，零值表示不限制该维度。
type InviteRebateFilter struct {
	InviterId int
	InviteeId int
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

// IsInviteRebateEligible 判断某个用户是否有资格拿邀请返现：必须是内部学员，
// 且不是管理员（管理员的返现是自己给自己记账）。与 creditInviteRebateTx 里的
// 判定保持一致，前端的展示开关也走这里。
func IsInviteRebateEligible(userId int) bool {
	var user User
	if err := DB.Select("id", "role", "member_level").First(&user, userId).Error; err != nil {
		return false
	}
	return user.MemberLevel == MemberLevelInternal && user.Role < common.RoleAdminUser
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
