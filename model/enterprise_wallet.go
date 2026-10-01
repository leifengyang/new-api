package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

var (
	ErrEnterpriseMembersRemain     = errors.New("remove all enterprise members before changing or deleting this account")
	ErrEnterpriseMemberMustExit    = errors.New("remove this member from the enterprise before promotion or deletion")
	ErrEnterpriseFrozenQuota       = errors.New("historical balance must be classified by a platform administrator first")
	ErrEnterpriseInsufficientQuota = errors.New("wallet quota insufficient")
)

// Quota is spendable balance. EnterpriseQuota is its enterprise-funded part;
// EnterpriseFrozenQuota is held separately and cannot be spent or reclaimed.
// A durable request allocation lets asynchronous refunds retain their source,
// even when the member has since been disabled or removed from the enterprise.
type EnterpriseWalletCharge struct {
	Id         int    `gorm:"primaryKey"`
	UserId     int    `gorm:"uniqueIndex:idx_enterprise_wallet_request,priority:1"`
	RequestId  string `gorm:"type:varchar(128);uniqueIndex:idx_enterprise_wallet_request,priority:2"`
	Epoch      int64
	OwnerId    int
	Enterprise int
	Personal   int
	Legacy     int
}

// InitializeEnterpriseWallets deliberately does not infer ownership from audit
// logs: old transfers and log writes were not committed in the same transaction.
// Zero balances are unambiguous; positive legacy balances are quarantined intact.
func InitializeEnterpriseWallets() error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Unscoped().Model(&User{}).
			Where("enterprise_owner_id > 0 AND enterprise_wallet_version = 0 AND quota > 0").
			Updates(map[string]any{"enterprise_frozen_quota": gorm.Expr("quota"), "quota": 0}).Error; err != nil {
			return err
		}
		return tx.Unscoped().Model(&User{}).Where("(enterprise_owner_id > 0 OR is_enterprise = ?) AND enterprise_wallet_version = 0", EnterpriseFlagYes).
			Update("enterprise_wallet_version", 1).Error
	})
}

// SetEnterpriseWalletCharge sets an absolute charge, making retries idempotent.
// handled=false retains the existing fast path for accounts never in an enterprise.
func SetEnterpriseWalletCharge(userId int, requestId string, target int, requireAvailable bool) (handled bool, err error) {
	return setEnterpriseWalletCharge(userId, requestId, target, 0, requireAvailable)
}

func SetEnterpriseTaskWalletCharge(userId int, requestId string, previous, target int) (bool, error) {
	return setEnterpriseWalletCharge(userId, requestId, target, previous, false)
}

func setEnterpriseWalletCharge(userId int, requestId string, target, previous int, requireAvailable bool) (handled bool, err error) {
	var snapshot User
	if err = DB.Select("id", "enterprise_owner_id", "enterprise_wallet_version").First(&snapshot, userId).Error; err != nil {
		return true, err
	}
	if snapshot.EnterpriseOwnerId == 0 && snapshot.EnterpriseWalletVersion == 0 {
		return false, nil
	}
	if requestId == "" || len(requestId) > 128 || target < 0 || target > common.MaxWalletQuota || previous < 0 || previous > common.MaxWalletQuota {
		return true, ErrInvalidUserQuotaAdjustment
	}
	var syncs []walletSyncEntry
	err = DB.Transaction(func(tx *gorm.DB) error {
		var charge EnterpriseWalletCharge
		findErr := tx.Where("user_id = ? AND request_id = ?", userId, requestId).First(&charge).Error
		if findErr != nil && !errors.Is(findErr, gorm.ErrRecordNotFound) {
			return findErr
		}
		ownerId := snapshot.EnterpriseOwnerId
		if charge.Id != 0 {
			ownerId = charge.OwnerId
		}
		var user, owner User
		var err error
		if ownerId > 0 {
			owner, user, err = lockTwoUsersForUpdate(tx, ownerId, userId)
			if errors.Is(err, gorm.ErrRecordNotFound) && snapshot.EnterpriseOwnerId == 0 {
				err = lockForUpdate(tx).First(&user, userId).Error
			}
		} else {
			err = lockForUpdate(tx).First(&user, userId).Error
		}
		if err != nil {
			return err
		}
		if user.EnterpriseOwnerId != snapshot.EnterpriseOwnerId {
			return ErrEnterpriseWalletChanged
		}
		// Re-read after the user lock, serializing duplicate requests as well as
		// requests with different ids spending the same grant.
		findErr = lockForUpdate(tx).Where("user_id = ? AND request_id = ?", userId, requestId).First(&charge).Error
		if findErr != nil && !errors.Is(findErr, gorm.ErrRecordNotFound) {
			return findErr
		}
		if charge.Id == 0 {
			charge = EnterpriseWalletCharge{UserId: userId, RequestId: requestId, OwnerId: ownerId, Epoch: user.EnterpriseWalletEpoch, Legacy: previous}
		}
		delta := target - charge.Enterprise - charge.Personal - charge.Legacy
		before, ownerBefore := user.Quota, owner.Quota
		if delta > 0 {
			if requireAvailable && (user.Status != common.UserStatusEnabled || user.Quota < delta) {
				return ErrEnterpriseInsufficientQuota
			}
			grant := 0
			if user.EnterpriseOwnerId == charge.OwnerId && user.EnterpriseWalletEpoch == charge.Epoch && user.Status == common.UserStatusEnabled {
				grant = min(user.EnterpriseQuota, delta)
			}
			user.EnterpriseQuota -= grant
			charge.Enterprise += grant
			charge.Personal += delta - grant
			if _, err := applyWalletDeltaTx(tx, &user, -int64(delta)); err != nil {
				return err
			}
		} else if delta < 0 {
			legacy := min(charge.Legacy, -delta)
			charge.Legacy -= legacy
			if user.EnterpriseFrozenQuota > common.MaxWalletQuota-legacy {
				return ErrWalletQuotaLimitExceeded
			}
			user.EnterpriseFrozenQuota += legacy
			personal := min(charge.Personal, -delta-legacy)
			grant := -delta - legacy - personal
			charge.Personal -= personal
			charge.Enterprise -= grant
			credit := personal
			if grant > 0 {
				if user.EnterpriseOwnerId == charge.OwnerId && user.EnterpriseWalletEpoch == charge.Epoch && user.Status == common.UserStatusEnabled {
					user.EnterpriseQuota += grant
					credit += grant
				} else if owner.Id == 0 {
					if user.EnterpriseFrozenQuota > common.MaxWalletQuota-grant {
						return ErrWalletQuotaLimitExceeded
					}
					user.EnterpriseFrozenQuota += grant
				} else if _, err := applyWalletDeltaTx(tx, &owner, int64(grant)); err != nil {
					return err
				}
			}
			if _, err := applyWalletDeltaTx(tx, &user, int64(credit)); err != nil {
				return err
			}
		}
		if int64(user.Quota)+int64(user.EnterpriseFrozenQuota) > int64(common.MaxWalletQuota) {
			return ErrWalletQuotaLimitExceeded
		}
		if err := tx.Model(&User{}).Where("id = ?", userId).Updates(map[string]any{"enterprise_quota": user.EnterpriseQuota, "enterprise_frozen_quota": user.EnterpriseFrozenQuota}).Error; err != nil {
			return err
		}
		if err := tx.Save(&charge).Error; err != nil {
			return err
		}
		syncs = []walletSyncEntry{{userId, before, user.Quota}, {ownerId, ownerBefore, owner.Quota}}
		return nil
	})
	if err == nil {
		for _, entry := range syncs {
			syncWalletCache(entry.userId, entry.before, entry.after)
		}
	}
	return true, err
}

// ClassifyEnterpriseBalance releases exactly the administrator-reviewed frozen
// snapshot. A changed snapshot must be reviewed again, never silently overwritten.
func ClassifyEnterpriseBalance(userId, frozen, enterprise int) error {
	if frozen <= 0 || enterprise < 0 || enterprise > frozen {
		return ErrInvalidUserQuotaAdjustment
	}

	var snapshot User
	if err := DB.Select("id", "enterprise_owner_id").First(&snapshot, userId).Error; err != nil {
		return err
	}
	var syncs []walletSyncEntry
	err := DB.Transaction(func(tx *gorm.DB) error {
		var user, owner User
		var err error
		if snapshot.EnterpriseOwnerId > 0 {
			owner, user, err = lockTwoUsersForUpdate(tx, snapshot.EnterpriseOwnerId, userId)
		} else {
			err = lockForUpdate(tx).First(&user, userId).Error
		}
		if err != nil {
			return err
		}
		if user.EnterpriseOwnerId != snapshot.EnterpriseOwnerId || user.EnterpriseFrozenQuota != frozen {
			return ErrEnterpriseWalletChanged
		}
		if enterprise > 0 && user.EnterpriseOwnerId == 0 {
			return ErrEnterpriseNotAMember
		}
		before, ownerBefore := user.Quota, owner.Quota
		credit := frozen
		if user.Status != common.UserStatusEnabled {
			credit -= enterprise
			if _, err := applyWalletDeltaTx(tx, &owner, int64(enterprise)); err != nil {
				return err
			}
		} else {
			if enterprise > common.MaxWalletQuota-user.EnterpriseQuota {
				return ErrWalletQuotaLimitExceeded
			}
			user.EnterpriseQuota += enterprise
		}
		user.EnterpriseFrozenQuota = 0
		if _, err := applyWalletDeltaTx(tx, &user, int64(credit)); err != nil {
			return err
		}
		if err := tx.Model(&User{}).Where("id = ?", userId).Updates(map[string]any{"enterprise_frozen_quota": 0, "enterprise_quota": user.EnterpriseQuota}).Error; err != nil {
			return err
		}
		syncs = []walletSyncEntry{{userId, before, user.Quota}, {owner.Id, ownerBefore, owner.Quota}}
		return nil
	})
	if err == nil {
		for _, entry := range syncs {
			syncWalletCache(entry.userId, entry.before, entry.after)
		}
	}
	return err
}

func guardEnterpriseAccountRemovalTx(tx *gorm.DB, userId int) error {
	var user User
	if err := lockForUpdate(tx.Unscoped()).First(&user, userId).Error; err != nil {
		return err
	}
	if user.EnterpriseOwnerId != 0 {
		return ErrEnterpriseMemberMustExit
	}
	if user.EnterpriseFrozenQuota != 0 {
		return ErrEnterpriseFrozenQuota
	}
	var count int64
	if err := tx.Unscoped().Model(&User{}).Where("enterprise_owner_id = ?", userId).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrEnterpriseMembersRemain
	}
	return nil
}
