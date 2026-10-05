package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm/clause"
)

// PaymentGuideProgress is independent of editable user preferences. A value of
// three also exempts users who had already topped up before entering the guide.
type PaymentGuideProgress struct {
	UserId     int `gorm:"primaryKey;autoIncrement:false"`
	ShownCount int `gorm:"not null"`
}

type PaymentGuideStatus struct {
	ShownCount int  `json:"shown_count"`
	ShowGuide  bool `json:"show_guide"`
}

func GetPaymentGuideStatus(userId int) (PaymentGuideStatus, error) {
	if userId <= 0 {
		return PaymentGuideStatus{}, errors.New("invalid user")
	}
	var progress PaymentGuideProgress
	result := DB.Where("user_id = ?", userId).Limit(1).Find(&progress)
	if result.Error != nil {
		return PaymentGuideStatus{}, result.Error
	}
	if result.RowsAffected > 0 {
		return PaymentGuideStatus{progress.ShownCount, progress.ShownCount < 3}, nil
	}
	var topup TopUp
	result = DB.Select("id").Where("user_id = ? AND status = ?", userId, common.TopUpStatusSuccess).Limit(1).Find(&topup)
	if result.Error != nil {
		return PaymentGuideStatus{}, result.Error
	}
	if result.RowsAffected > 0 {
		return PaymentGuideStatus{ShownCount: 3}, nil
	}
	// Deleted redemption codes still prove that this account has redeemed before.
	var redemption Redemption
	result = DB.Unscoped().Select("id").Where("used_user_id = ? AND redeemed_time > 0", userId).Limit(1).Find(&redemption)
	if result.Error != nil {
		return PaymentGuideStatus{}, result.Error
	}
	if result.RowsAffected > 0 {
		return PaymentGuideStatus{ShownCount: 3}, nil
	}
	return PaymentGuideStatus{ShowGuide: true}, nil
}

func RecordPaymentGuideView(userId int) (PaymentGuideStatus, error) {
	status, err := GetPaymentGuideStatus(userId)
	if err != nil {
		return PaymentGuideStatus{}, err
	}
	progress := PaymentGuideProgress{UserId: userId, ShownCount: status.ShownCount}
	if err = DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&progress).Error; err != nil {
		return PaymentGuideStatus{}, err
	}
	// Compare-and-swap caps the counter across devices without dialect-specific
	// JSON updates or lost increments. At most three successful changes exist.
	for range 4 {
		if err = DB.Where("user_id = ?", userId).First(&progress).Error; err != nil {
			return PaymentGuideStatus{}, err
		}
		if progress.ShownCount >= 3 {
			return PaymentGuideStatus{ShownCount: 3}, nil
		}
		next := progress.ShownCount + 1
		result := DB.Model(&PaymentGuideProgress{}).Where("user_id = ? AND shown_count = ?", userId, progress.ShownCount).Update("shown_count", next)
		if result.Error != nil {
			return PaymentGuideStatus{}, result.Error
		}
		if result.RowsAffected == 1 {
			return PaymentGuideStatus{ShownCount: next, ShowGuide: true}, nil
		}
	}
	return PaymentGuideStatus{}, errors.New("payment guide changed; please retry")
}
