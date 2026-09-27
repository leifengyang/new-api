package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"

	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

// 企业账号不是第三个角色：它是普通用户身上的一枚标记，用来决定这个人能不能打开
// 企业控制台，以及哪些账号算他的成员。平台管理员之外的任何入口都改不了这枚标记。
// 用 int 而不是 bool，理由同 MemberLevel：GORM 的布尔默认值标签在 MySQL 和
// PostgreSQL 上会因为默认值表达差异反复触发 ALTER TABLE。
const (
	EnterpriseFlagNo  = 0
	EnterpriseFlagYes = 1
)

const (
	defaultEnterpriseMemberLimit = 100
	// maxEnterpriseMemberLimit 是后台可调上限的天花板。成员数直接决定列表查询和
	// 逐个划额度的循环规模，留一个硬上限，免得后台一个手滑把单次请求拖垮。
	maxEnterpriseMemberLimit = 10000
	// enterpriseLimitsMaxEntries 单个成员的白名单条目上限。平台上的分组和模型
	// 总量远小于这个数，它只用来挡住构造出来的超长请求体。
	enterpriseLimitsMaxEntries = 1000
)

var (
	// ErrEnterpriseTargetNotCommonUser 企业账号必须是普通用户，管理员和 root 不能打这枚标记。
	ErrEnterpriseTargetNotCommonUser = errors.New("only a common user can be an enterprise account")
	// ErrEnterpriseTargetIsMember 已经归属某个企业的成员不能再被标成企业账号。
	ErrEnterpriseTargetIsMember = errors.New("a user who belongs to an enterprise cannot become one")
	ErrEnterpriseNotFound       = errors.New("enterprise account not found")
	// ErrEnterpriseNotAMember 目标用户不在这家企业名下——企业控制台的每个入口都靠它兜底。
	ErrEnterpriseNotAMember         = errors.New("the target user does not belong to this enterprise")
	ErrEnterpriseMemberLimitReached = errors.New("the enterprise has reached its member limit")
	ErrEnterpriseMemberNotEnabled   = errors.New("the member is disabled")
	ErrEnterpriseQuotaNotPositive   = errors.New("the transfer amount must be positive")
	ErrInsufficientEnterpriseQuota  = errors.New("the enterprise does not have enough balance")
	// ErrEnterpriseMemberExists 企业自己建号时用户名已被占用。
	ErrEnterpriseMemberExists = errors.New("the username is already taken")
	// ErrEnterpriseWalletChanged 条件更新没命中，说明余额在同一时刻被别人改过。
	ErrEnterpriseWalletChanged = errors.New("the wallet balance changed during the operation")
	// ErrInvalidEnterpriseLimits 企业提交的白名单不合法（空白项、超量，或不是平台上的分组）。
	ErrInvalidEnterpriseLimits = errors.New("invalid enterprise limits")
	// ErrEnterpriseMemberStatusUnchanged 目标状态与当前状态一致，不需要改动。
	ErrEnterpriseMemberStatusUnchanged = errors.New("the member status is already the requested one")
)

// EnterpriseMemberSummary 是企业控制台列表里的一行。只带控制台需要的字段，
// 不复用 User 结构体，免得把密码哈希之类的字段顺手带出去。
type EnterpriseMemberSummary struct {
	Id                    int    `json:"id"`
	Username              string `json:"username"`
	DisplayName           string `json:"display_name"`
	Status                int    `json:"status"`
	Quota                 int    `json:"quota"`
	UsedQuota             int    `json:"used_quota"`
	RequestCount          int    `json:"request_count"`
	Group                 string `json:"group"`
	EnterpriseGroupLimits string `json:"enterprise_group_limits"`
	EnterpriseModelLimits string `json:"enterprise_model_limits"`
	CreatedAt             int64  `json:"created_at"`
	LastLoginAt           int64  `json:"last_login_at"`
}

// EnterpriseMemberFilter 是企业控制台成员列表的查询条件。
type EnterpriseMemberFilter struct {
	Keyword string
	// Status 为 0 表示不过滤。
	Status int
}

// walletSyncEntry 记录一笔已提交的余额变动，供事务外同步额度缓存。
type walletSyncEntry struct {
	userId int
	before int
	after  int
}

// lockTwoUsersForUpdate 按 id 升序锁定两个用户行。
//
// 跨账号搬余额的地方一律先锁小 id：企业与成员之间既有「划过去」也有「退回来」，
// 两个方向如果按各自视角的先后顺序加锁就会互相死锁。SQLite 上 lockForUpdate
// 是空操作，真正的兜底是下面每条 UPDATE 里的 CAS 条件。
func lockTwoUsersForUpdate(tx *gorm.DB, firstId, secondId int) (User, User, error) {
	low, high := firstId, secondId
	if low > high {
		low, high = high, low
	}
	var lowUser, highUser User
	if err := lockForUpdate(tx).First(&lowUser, low).Error; err != nil {
		return User{}, User{}, err
	}
	if err := lockForUpdate(tx).First(&highUser, high).Error; err != nil {
		return User{}, User{}, err
	}
	if firstId <= secondId {
		return lowUser, highUser, nil
	}
	return highUser, lowUser, nil
}

// applyWalletDeltaTx 把一笔带符号的余额变动写回用户行，返回变动后的余额。
//
// 先用调用方在锁内读到的余额算出结果，再把「原余额」当版本号写进 WHERE：SQLite
// 拿不到行锁，条件不成立就说明并发改过，直接失败让上层重来，不能盲目覆盖。
func applyWalletDeltaTx(tx *gorm.DB, user *User, delta int64) (int, error) {
	if delta == 0 {
		return user.Quota, nil
	}
	after := decimal.NewFromInt(int64(user.Quota)).Add(decimal.NewFromInt(delta))
	quota, err := common.WalletQuotaFromDecimalStrict(after)
	if err != nil {
		return 0, ErrWalletQuotaLimitExceeded
	}
	result := tx.Model(&User{}).Where("id = ? AND quota = ?", user.Id, user.Quota).Update("quota", quota)
	if result.Error != nil {
		return 0, result.Error
	}
	if result.RowsAffected != 1 {
		return 0, ErrEnterpriseWalletChanged
	}
	user.Quota = quota
	return quota, nil
}

// syncWalletCache 把已提交的余额变动同步进额度缓存，只补差额，不动尚未结算的预扣。
func syncWalletCache(userId int, before, after int) {
	delta := int64(after) - int64(before)
	if delta == 0 {
		return
	}
	if err := cacheIncrUserQuota(userId, delta); err != nil {
		common.SysError(fmt.Sprintf("failed to sync enterprise quota for user %d: %s", userId, err.Error()))
	}
}

func invalidateUserCacheBestEffort(userId int, what string) {
	if err := invalidateUserCache(userId); err != nil {
		common.SysError(fmt.Sprintf("failed to invalidate %s cache for user %d: %s", what, userId, err.Error()))
	}
}

// isDuplicateEntryError 判断底层错误是不是唯一索引冲突。
//
// 三家驱动的报错文本不同（MySQL 1062 / PostgreSQL "duplicate key value" /
// SQLite "UNIQUE constraint failed"），这里只做宽松的文本匹配。它只影响错误
// 提示的措辞，不影响正确性：冲突本身已经被数据库的唯一索引拦下了。
func isDuplicateEntryError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "duplicate") || strings.Contains(message, "unique constraint")
}

// SetUserEnterpriseFlag 由平台管理员打上或取消「企业账号」标记。
//
// 取消标记会连带把名下成员全部移出企业，并把各成员钱包里的余额退回企业账号——
// 这一步与标记本身在同一笔事务里完成，避免出现「已经不再是企业，成员却还挂在
// 它名下」的中间状态。返回被移出的成员数，供审计记录。
func SetUserEnterpriseFlag(userId int, enabled bool) (releasedMembers int, err error) {
	if userId <= 0 {
		return 0, gorm.ErrRecordNotFound
	}
	var syncs []walletSyncEntry

	err = DB.Transaction(func(tx *gorm.DB) error {
		syncs = syncs[:0]
		var target User
		if err := lockForUpdate(tx).First(&target, userId).Error; err != nil {
			return err
		}
		if target.Role != common.RoleCommonUser {
			return ErrEnterpriseTargetNotCommonUser
		}
		if enabled {
			if target.EnterpriseOwnerId != 0 {
				return ErrEnterpriseTargetIsMember
			}
			if target.IsEnterprise == EnterpriseFlagYes {
				return nil
			}
			return tx.Model(&User{}).Where("id = ?", userId).
				Update("is_enterprise", EnterpriseFlagYes).Error
		}
		if target.IsEnterprise != EnterpriseFlagYes {
			return nil
		}
		released, wallets, err := releaseEnterpriseMembersTx(tx, &target)
		if err != nil {
			return err
		}
		releasedMembers = released
		syncs = append(syncs, wallets...)
		result := tx.Model(&User{}).Where("id = ?", userId).
			Update("is_enterprise", EnterpriseFlagNo)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrEnterpriseWalletChanged
		}
		return nil
	})
	if err != nil {
		return 0, err
	}

	for _, sync := range syncs {
		syncWalletCache(sync.userId, sync.before, sync.after)
	}
	invalidateUserCacheBestEffort(userId, "enterprise")
	return releasedMembers, nil
}

// releaseEnterpriseMembersTx 把企业名下的成员全部移出：余额退回企业账号，归属清空，
// 企业限制一并撤销。返回移出的成员数和需要在提交后同步的额度缓存条目。
//
// 成员的启用状态不动：企业停用过的成员在移出后仍然保持停用。谁停用的谁负责，
// 这里不替平台管理员做「顺手放行」的决定。
func releaseEnterpriseMembersTx(tx *gorm.DB, enterprise *User) (int, []walletSyncEntry, error) {
	var members []User
	if err := lockForUpdate(tx).Where("enterprise_owner_id = ?", enterprise.Id).
		Find(&members).Error; err != nil {
		return 0, nil, err
	}
	if len(members) == 0 {
		return 0, nil, nil
	}

	// 企业余额在企业行上一次性收紧，而不是逐个成员累加：少一轮读写，也少一次越界判断。
	var total int64
	for i := range members {
		total += int64(members[i].Quota)
	}
	enterpriseBefore := enterprise.Quota
	enterpriseAfter := enterpriseBefore

	if total != 0 {
		merged := decimal.NewFromInt(int64(enterpriseBefore)).Add(decimal.NewFromInt(total))
		quota, err := common.WalletQuotaFromDecimalStrict(merged)
		if err != nil {
			// 成员的余额合起来把企业钱包顶过了上限。这里只能截断并留痕，
			// 不能因此让「取消企业标记」这个操作直接失败。
			common.SysError(fmt.Sprintf(
				"enterprise %d wallet clamped while releasing members: %s", enterprise.Id, err.Error()))
			quota = common.MaxWalletQuota
		}
		result := tx.Model(&User{}).Where("id = ? AND quota = ?", enterprise.Id, enterpriseBefore).
			Update("quota", quota)
		if result.Error != nil {
			return 0, nil, result.Error
		}
		if result.RowsAffected != 1 {
			return 0, nil, ErrEnterpriseWalletChanged
		}
		enterpriseAfter = quota
	}

	syncs := make([]walletSyncEntry, 0, len(members)+1)
	if enterpriseAfter != enterpriseBefore {
		syncs = append(syncs, walletSyncEntry{enterprise.Id, enterpriseBefore, enterpriseAfter})
	}

	for i := range members {
		member := &members[i]
		before := member.Quota
		result := tx.Model(&User{}).Where("id = ?", member.Id).Updates(map[string]any{
			"quota":                   0,
			"enterprise_owner_id":     0,
			"enterprise_group_limits": "",
			"enterprise_model_limits": "",
		})
		if result.Error != nil {
			return 0, nil, result.Error
		}
		if result.RowsAffected != 1 {
			return 0, nil, ErrEnterpriseWalletChanged
		}
		if before != 0 {
			syncs = append(syncs, walletSyncEntry{member.Id, before, 0})
		}
	}
	return len(members), syncs, nil
}

// enterpriseLookupError 只把「确实没有这一行」翻成企业语境的错误，其余错误原样
// 上抛。把数据库故障也说成「企业账号不存在」，会让运维照着错误的线索排查，
// 而且会把一次暂时性故障伪装成一个正常的业务否定。
func enterpriseLookupError(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrEnterpriseNotFound
	}
	return err
}

// memberLookupError 同上，用于成员的读取：不存在即「不归这家企业管」。
func memberLookupError(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrEnterpriseNotAMember
	}
	return err
}

// GetEnterpriseAccount 取企业账号本身，非企业账号一律按不存在处理：
// 控制台的每个入口都从它开始，判定只有这一处。
func GetEnterpriseAccount(userId int) (*User, error) {
	var user User
	if err := DB.First(&user, userId).Error; err != nil {
		return nil, err
	}
	if user.IsEnterprise != EnterpriseFlagYes || user.Role != common.RoleCommonUser {
		return nil, ErrEnterpriseNotFound
	}
	return &user, nil
}

// CountEnterpriseMembers 统计企业名下的成员数。
func CountEnterpriseMembers(enterpriseId int) (int64, error) {
	return CountEnterpriseMembersTx(DB, enterpriseId)
}

// CountEnterpriseMembersTx 在事务内统计成员数，供建号前的上限判断使用。
func CountEnterpriseMembersTx(tx *gorm.DB, enterpriseId int) (int64, error) {
	var count int64
	if err := tx.Model(&User{}).Where("enterprise_owner_id = ?", enterpriseId).Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

// ListEnterpriseMembers 分页列出企业名下的成员。
func ListEnterpriseMembers(enterpriseId int, filter EnterpriseMemberFilter, offset, limit int) ([]EnterpriseMemberSummary, int64, error) {
	query := DB.Model(&User{}).Where("enterprise_owner_id = ?", enterpriseId)
	if keyword := strings.TrimSpace(filter.Keyword); keyword != "" {
		pattern, err := sanitizeLikePattern(keyword)
		if err != nil {
			return nil, 0, err
		}
		pattern = "%" + pattern + "%"
		query = query.Where(
			"username LIKE ? ESCAPE '!' OR display_name LIKE ? ESCAPE '!'", pattern, pattern)
	}
	if filter.Status != 0 {
		query = query.Where("status = ?", filter.Status)
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if limit <= 0 {
		return []EnterpriseMemberSummary{}, total, nil
	}

	members := make([]EnterpriseMemberSummary, 0, limit)
	if err := query.
		Select("id", "username", "display_name", "status", "quota", "used_quota",
			"request_count", "group", "enterprise_group_limits", "enterprise_model_limits",
			"created_at", "last_login_at").
		Order("id ASC").Offset(offset).Limit(limit).Scan(&members).Error; err != nil {
		return nil, 0, err
	}
	return members, total, nil
}

// GetEnterpriseMember 取一个成员，用于控制台的回显与操作前的确认。
func GetEnterpriseMember(enterpriseId, memberId int) (*User, error) {
	var member User
	if err := DB.Where("id = ? AND enterprise_owner_id = ?", memberId, enterpriseId).First(&member).Error; err != nil {
		return nil, memberLookupError(err)
	}
	return &member, nil
}

// lockEnterpriseMemberTx 在事务内锁定一个成员行，并确认它确实属于这家企业。
func lockEnterpriseMemberTx(tx *gorm.DB, enterpriseId, memberId int) (*User, error) {
	if memberId <= 0 || memberId == enterpriseId {
		return nil, ErrEnterpriseNotAMember
	}
	var member User
	if err := lockForUpdate(tx).First(&member, memberId).Error; err != nil {
		return nil, memberLookupError(err)
	}
	// 归属校验必须在取到行之后做，而且只看数据库里的值：企业控制台的每个写操作
	// 都要经过这里，前端传什么 id 都不构成授权依据。
	if member.EnterpriseOwnerId != enterpriseId {
		return nil, ErrEnterpriseNotAMember
	}
	return &member, nil
}

// CreateEnterpriseMember 由企业管理员直接建号：设初始密码，建完即可登录。
//
// 这样建出来的成员不属于任何邀请关系（inviter_id = 0），也就不会给企业账号带来
// 邀请返现——企业管理员是在履行管理职责，不是在发展下线。钱包从 0 开始，
// 额度由企业后续划过去；平台的「新用户赠额」不给这类账号，理由见 insertWithTx。
func CreateEnterpriseMember(enterpriseId int, member *User) error {
	if member == nil {
		return ErrInvalidEnterpriseLimits
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var enterprise User
		if err := lockForUpdate(tx).First(&enterprise, enterpriseId).Error; err != nil {
			return enterpriseLookupError(err)
		}
		if enterprise.IsEnterprise != EnterpriseFlagYes || enterprise.Role != common.RoleCommonUser {
			return ErrEnterpriseNotFound
		}
		// 锁住企业行再数人，同一家企业并发建号时上限才不会被同时越过。
		count, err := CountEnterpriseMembersTx(tx, enterpriseId)
		if err != nil {
			return err
		}
		if count >= int64(common.EnterpriseMemberLimit) {
			return ErrEnterpriseMemberLimitReached
		}
		exists, err := checkUsernameTakenTx(tx, member.Username)
		if err != nil {
			return err
		}
		if exists {
			return ErrEnterpriseMemberExists
		}

		member.Role = common.RoleCommonUser
		member.Status = common.UserStatusEnabled
		member.InviterId = 0
		member.EnterpriseOwnerId = enterpriseId
		if err := member.insertWithTx(tx, 0, 0); err != nil {
			if isDuplicateEntryError(err) {
				return ErrEnterpriseMemberExists
			}
			return err
		}
		return nil
	})
}

// guardEnterpriseMemberCapacityTx 在建号事务内确认企业还有名额。
// 先锁企业行再数人，同一家企业的并发注册才会在这里排成队，而不是同时读到旧计数。
func guardEnterpriseMemberCapacityTx(tx *gorm.DB, enterpriseId int) error {
	var enterprise User
	if err := lockForUpdate(tx).First(&enterprise, enterpriseId).Error; err != nil {
		return enterpriseLookupError(err)
	}
	if enterprise.IsEnterprise != EnterpriseFlagYes || enterprise.Role != common.RoleCommonUser {
		return ErrEnterpriseNotFound
	}
	count, err := CountEnterpriseMembersTx(tx, enterpriseId)
	if err != nil {
		return err
	}
	if count >= int64(common.EnterpriseMemberLimit) {
		return ErrEnterpriseMemberLimitReached
	}
	return nil
}

func checkUsernameTakenTx(tx *gorm.DB, username string) (bool, error) {
	var count int64
	if err := tx.Unscoped().Model(&User{}).Where("username = ?", username).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

// SetEnterpriseMemberStatus 企业管理员停用或启用成员。
//
// 停用会把成员钱包里的余额全部退回企业账号。退的是带符号的真实余额：成员余额
// 可能是负数（平台管理员手工调整过），只退正数会让欠的那部分凭空消失。
func SetEnterpriseMemberStatus(enterpriseId, memberId int, enabled bool) (returned int, err error) {
	var syncs []walletSyncEntry
	err = DB.Transaction(func(tx *gorm.DB) error {
		syncs = syncs[:0]
		member, err := lockEnterpriseMemberTx(tx, enterpriseId, memberId)
		if err != nil {
			return err
		}
		status := common.UserStatusDisabled
		if enabled {
			status = common.UserStatusEnabled
		}
		if member.Status == status {
			return ErrEnterpriseMemberStatusUnchanged
		}

		if !enabled && member.Quota != 0 {
			var enterprise User
			if err := lockForUpdate(tx).First(&enterprise, enterpriseId).Error; err != nil {
				return enterpriseLookupError(err)
			}
			returned = member.Quota
			before := enterprise.Quota
			after, err := applyWalletDeltaTx(tx, &enterprise, int64(member.Quota))
			if err != nil {
				return err
			}
			syncs = append(syncs, walletSyncEntry{enterprise.Id, before, after})
			if err := clearMemberQuotaTx(tx, member); err != nil {
				return err
			}
		}

		// 状态改动走 UpdateWithTx：它会因为 status 变化递增 auth_version，
		// 把成员已经登录的会话一并吊销，停用不只是「下一个请求被拒」。
		member.Status = status
		return member.UpdateWithTx(tx, false)
	})
	if err != nil {
		return 0, err
	}
	for _, sync := range syncs {
		syncWalletCache(sync.userId, sync.before, sync.after)
	}
	invalidateUserCacheBestEffort(memberId, "member")
	return returned, nil
}

func clearMemberQuotaTx(tx *gorm.DB, member *User) error {
	before := member.Quota
	result := tx.Model(&User{}).Where("id = ? AND quota = ?", member.Id, before).
		Update("quota", 0)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrEnterpriseWalletChanged
	}
	member.Quota = 0
	return nil
}

// TransferEnterpriseQuotaToMember 把企业账号自己钱包里的余额划给名下成员。
//
// 钱已经在系统里，只是从一个钱包换到另一个钱包，因此刻意不走 creditTopUpQuota：
// 那条路会触发邀请返现漏斗，把企业内部的钱包搬运当成一笔充值发返现。
// 口径与 AdjustUserQuota 一致，只同步额度缓存。
func TransferEnterpriseQuotaToMember(enterpriseId, memberId, quota int) (returned int, err error) {
	if quota <= 0 {
		return 0, ErrEnterpriseQuotaNotPositive
	}
	if quota > common.MaxWalletQuota {
		return 0, ErrWalletQuotaLimitExceeded
	}

	var enterpriseBefore, memberBefore, memberAfter int
	err = DB.Transaction(func(tx *gorm.DB) error {
		// 返回顺序与入参一致：第一个是企业，第二个是成员。
		enterprise, member, err := lockTwoUsersForUpdate(tx, enterpriseId, memberId)
		if err != nil {
			return err
		}
		if enterprise.Id != enterpriseId || enterprise.IsEnterprise != EnterpriseFlagYes {
			return ErrEnterpriseNotFound
		}
		if member.EnterpriseOwnerId != enterpriseId {
			return ErrEnterpriseNotAMember
		}
		if member.Status != common.UserStatusEnabled {
			return ErrEnterpriseMemberNotEnabled
		}
		if enterprise.Quota < quota {
			return ErrInsufficientEnterpriseQuota
		}

		enterpriseBefore, memberBefore = enterprise.Quota, member.Quota
		if _, err := applyWalletDeltaTx(tx, &enterprise, -int64(quota)); err != nil {
			return err
		}
		after, err := applyWalletDeltaTx(tx, &member, int64(quota))
		if err != nil {
			return err
		}
		memberAfter = after
		return nil
	})
	if err != nil {
		return 0, err
	}

	syncWalletCache(enterpriseId, enterpriseBefore, enterpriseBefore-quota)
	syncWalletCache(memberId, memberBefore, memberAfter)
	return quota, nil
}

// UpdateEnterpriseMemberLimits 设置成员的可用分组 / 可用模型白名单。
// groupLimits 与 modelLimits 为 nil 表示撤销限制。
func UpdateEnterpriseMemberLimits(enterpriseId, memberId int, groupLimits, modelLimits []string) error {
	groupJSON, err := encodeEnterpriseLimits(groupLimits)
	if err != nil {
		return err
	}
	modelJSON, err := encodeEnterpriseLimits(modelLimits)
	if err != nil {
		return err
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockEnterpriseMemberTx(tx, enterpriseId, memberId); err != nil {
			return err
		}
		result := tx.Model(&User{}).Where("id = ?", memberId).Updates(map[string]any{
			"enterprise_group_limits": groupJSON,
			"enterprise_model_limits": modelJSON,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrEnterpriseWalletChanged
		}
		return nil
	})
}

// encodeEnterpriseLimits 把白名单编码成库里的文本。nil 落成空串（不受限），
// 空切片落成 []（限制到空集），两者在读取侧靠 parseEnterpriseLimits 区分。
func encodeEnterpriseLimits(limits []string) (string, error) {
	if limits == nil {
		return "", nil
	}
	if len(limits) > enterpriseLimitsMaxEntries {
		return "", ErrInvalidEnterpriseLimits
	}
	encoded, err := common.Marshal(limits)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// NormalizeEnterpriseGroupLimits 校验企业提交的分组白名单：每一项都必须落在
// allowed 里（平台侧已经算好的「该成员本来就能用的分组」）。交出来的结果因此
// 永远是平台集合的子集，企业造不出新分组，也放不进平台没开的分组。
// limits 为 nil 表示撤销限制。
func NormalizeEnterpriseGroupLimits(limits []string, allowed map[string]string) ([]string, error) {
	if limits == nil {
		return nil, nil
	}
	if len(limits) > enterpriseLimitsMaxEntries {
		return nil, ErrInvalidEnterpriseLimits
	}
	seen := make(map[string]struct{}, len(limits))
	normalized := make([]string, 0, len(limits))
	for _, raw := range limits {
		name := strings.TrimSpace(raw)
		if name == "" {
			return nil, ErrInvalidEnterpriseLimits
		}
		if _, ok := allowed[name]; !ok {
			return nil, fmt.Errorf("%w: %s", ErrInvalidEnterpriseLimits, name)
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		normalized = append(normalized, name)
	}
	if len(normalized) == 0 {
		return nil, ErrInvalidEnterpriseLimits
	}
	return normalized, nil
}

// ResetEnterpriseMemberPassword 企业管理员重置成员密码。走的就是自助改密那条
// 路径，因此同样会递增 auth_version，把成员手上已有的会话踢掉。
func ResetEnterpriseMemberPassword(enterpriseId, memberId int, newPassword string) error {
	var member User
	err := DB.Transaction(func(tx *gorm.DB) error {
		locked, err := lockEnterpriseMemberTx(tx, enterpriseId, memberId)
		if err != nil {
			return err
		}
		member = *locked
		member.Password = newPassword
		return member.EditWithTx(tx, true)
	})
	if err != nil {
		return err
	}
	if err := updateUserCache(member); err != nil {
		common.SysError(fmt.Sprintf("failed to update member cache for user %d: %s", member.Id, err.Error()))
	}
	if _, err := RevokeAllUserSessions(member.Id, "enterprise_password_reset"); err != nil {
		common.SysError(fmt.Sprintf("failed to revoke sessions for user %d: %s", member.Id, err.Error()))
	}
	return nil
}
