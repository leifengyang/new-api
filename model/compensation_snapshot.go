package model

import (
	"context"
	"errors"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

func CaptureCompensationDimensions(ctx context.Context, log *Log) (CompensationDimensions, error) {
	d := CompensationDimensions{Username: log.Username, ChannelID: log.ChannelId, UseGroup: log.Group}
	if log.ChannelId > 0 {
		var channel Channel
		err := DB.WithContext(ctx).Select("name").Where("id = ?", log.ChannelId).First(&channel).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return d, err
		}
		d.ChannelName = channel.Name
	}
	var metadata struct {
		Source string `json:"billing_source"`
	}
	if err := common.UnmarshalJsonStr(log.Other, &metadata); err != nil {
		return d, nil
	}
	if metadata.Source == "subscription" {
		d.Funding = "subscription"
		return d, nil
	}
	if log.RequestId != "" {
		var charge EnterpriseWalletCharge
		err := DB.WithContext(ctx).Where("user_id = ? AND request_id = ?", log.UserId, log.RequestId).First(&charge).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return d, err
		}
		if err == nil {
			// Refunds or legacy balances may make a retained allocation differ
			// from the original charge. Never infer a split in that situation.
			if charge.Legacy != 0 || charge.Enterprise < 0 || charge.Personal < 0 || int64(charge.Enterprise)+int64(charge.Personal) != int64(log.Quota) {
				return d, nil
			}
			d.EnterpriseQuota, d.PersonalQuota = charge.Enterprise, charge.Personal
			switch {
			case charge.Enterprise > 0 && charge.Personal > 0:
				d.Funding = "mixed"
			case charge.Enterprise > 0:
				d.Funding = "enterprise"
			default:
				d.Funding = "personal"
			}
			return d, nil
		}
	}
	if metadata.Source == "wallet" {
		d.Funding = "personal"
		d.PersonalQuota = log.Quota
	}
	return d, nil
}

// Bounded, restartable backfill runs in the existing leased background job,
// independent of whether automatic monetary compensation is enabled.
func BackfillCompensationDimensions(ctx context.Context) error {
	var records []StreamCompensation
	if err := DB.WithContext(ctx).Where("COALESCE(snapshot_version, 0) = 0").Order("id").Limit(200).Find(&records).Error; err != nil {
		return err
	}
	for _, record := range records {
		q := LOG_DB.WithContext(ctx).Where("user_id = ? AND type = ?", record.UserID, LogTypeConsume)
		if record.RequestID != "" {
			q = q.Where("request_id = ?", record.RequestID)
		} else {
			q = q.Where("created_at = ? AND model_name = ? AND quota = ?", record.ConsumedAt, record.ModelName, record.OriginalQuota)
		}
		var logs []Log
		if err := q.Find(&logs).Error; err != nil {
			return err
		}
		var source *Log
		for i := range logs {
			if CompensationSourceKey(&logs[i]) != record.SourceKey {
				continue
			}
			if source != nil {
				source = nil
				break
			} // ambiguous source: preserve unknown
			source = &logs[i]
		}
		var d CompensationDimensions
		if source != nil {
			var err error
			d, err = CaptureCompensationDimensions(ctx, source)
			if err != nil {
				return err
			}
		}
		if err := DB.WithContext(ctx).Model(&StreamCompensation{}).Where("id = ? AND COALESCE(snapshot_version, 0) = 0", record.ID).Updates(map[string]any{
			"snapshot_version": 1, "dimension_username": d.Username, "dimension_channel_id": d.ChannelID,
			"dimension_channel_name": d.ChannelName, "dimension_use_group": d.UseGroup, "dimension_funding": d.Funding,
			"dimension_enterprise_quota": d.EnterpriseQuota, "dimension_personal_quota": d.PersonalQuota,
		}).Error; err != nil {
			return err
		}
	}
	return nil
}
