package model

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const ChampionEventTaskType = "champion_event_awards"

// This campaign has a fixed, reviewed contract. Reusing it for another event
// requires a new campaign ID, never rewriting an already issued award.
type ChampionEvent struct {
	ID           int    `json:"id" gorm:"primaryKey;autoIncrement:false"`
	Status       string `json:"status" gorm:"type:varchar(24)"`
	Published    bool   `json:"published"`
	ExcludedIDs  string `json:"excluded_ids" gorm:"type:text"`
	Revision     int64  `json:"revision"`
	SnapshotAt   int64  `json:"snapshot_at"`
	SnapshotEnd  int64  `json:"snapshot_end"`
	TotalQuota   int64  `json:"total_quota"`
	Participants int    `json:"participants"`
	UnknownLogs  int    `json:"unknown_logs"`
	ConfirmedBy  int    `json:"confirmed_by"`
	ConfirmedAt  int64  `json:"confirmed_at"`
}

// A single primary-database row is the immutable ranking snapshot, reward
// ledger, permanent badge entitlement and durable inbox item for this campaign.
type ChampionAward struct {
	ID           int64  `json:"id" gorm:"primaryKey"`
	EventID      int    `json:"event_id" gorm:"uniqueIndex:idx_champion_award,priority:1"`
	UserID       int    `json:"user_id" gorm:"uniqueIndex:idx_champion_award,priority:2"`
	Username     string `json:"username" gorm:"type:varchar(255)"`
	Spend        int64  `json:"spend"`
	ReachedAt    int64  `json:"reached_at"`
	Position     int    `json:"position"`
	Reason       string `json:"reason" gorm:"type:varchar(32)"`
	Quota        int    `json:"quota"`
	Status       string `json:"status" gorm:"type:varchar(24);index"`
	CreditedAt   int64  `json:"credited_at"`
	ReadAt       int64  `json:"read_at"`
	NoticeSeenAt int64  `json:"notice_seen_at"`
	Equipped     int    `json:"equipped"` // 0 hidden, 1..7 champion, 8 memorial
}

func ChampionWindow() (int64, int64) {
	start := time.Date(2026, 11, 14, 0, 0, 0, 0, time.FixedZone("Asia/Shanghai", 8*3600))
	return start.Unix(), start.AddDate(0, 0, 2).Unix()
}

func GetChampionEvent(ctx context.Context) (ChampionEvent, error) {
	event := ChampionEvent{ID: 1, Status: "draft", ExcludedIDs: "[]"}
	if err := DB.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&event).Error; err != nil {
		return event, err
	}
	err := DB.WithContext(ctx).First(&event, 1).Error
	return event, err
}

func SaveChampionEvent(ctx context.Context, revision int64, published bool, excluded []int) error {
	if len(excluded) > 10000 {
		return errors.New("Too many excluded users")
	}
	for _, id := range excluded {
		if id <= 0 {
			return errors.New("Invalid user ID")
		}
	}
	slices.Sort(excluded)
	excluded = slices.Compact(excluded)
	raw, err := common.Marshal(excluded)
	if err != nil {
		return err
	}
	return DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var event ChampionEvent
		if err := lockForUpdate(tx).First(&event, 1).Error; err != nil {
			return err
		}
		if event.Revision != revision {
			return errors.New("The activity changed. Refresh and try again.")
		}
		if event.Status != "draft" && event.ExcludedIDs != string(raw) {
			return errors.New("The award list is frozen")
		}
		updates := map[string]any{"published": published, "revision": event.Revision + 1}
		if event.ExcludedIDs != string(raw) {
			updates["excluded_ids"] = string(raw)
			updates["snapshot_at"] = 0
			updates["snapshot_end"] = 0
		}
		return tx.Model(&event).Updates(updates).Error
	})
}

// Read logs through the configured log connection, classify funding in Go and
// save only aggregates in the main DB. No JSON SQL or cross-DB joins are used.
func PreviewChampionEvent(ctx context.Context, now time.Time, revision int64) error {
	event, err := GetChampionEvent(ctx)
	if err != nil {
		return err
	}
	if event.Status != "draft" || event.Revision != revision {
		return errors.New("The activity changed. Refresh and try again.")
	}
	var excluded []int
	if err := common.UnmarshalJsonStr(event.ExcludedIDs, &excluded); err != nil {
		return err
	}
	start, end := ChampionWindow()
	end = min(end, now.Unix())
	users := []User{}
	if err := DB.WithContext(ctx).Unscoped().Select("id", "username", "role", "status", "deleted_at", "enterprise_wallet_version").Find(&users).Error; err != nil {
		return err
	}
	byID := make(map[int]User, len(users))
	for _, user := range users {
		byID[user.Id] = user
	}
	// Fetch bounded log pages and their allocations only. Historical enterprise
	// charges outside this two-day campaign must not be loaded into memory.
	aggregates := map[int]*ChampionAward{}
	unknown := 0
	for offset := 0; ; offset += 500 {
		var logs []Log
		order := "created_at, id"
		if common.UsingLogDatabase(common.DatabaseTypeClickHouse) {
			order = "created_at, request_id"
		}
		if err := LOG_DB.WithContext(ctx).Model(&Log{}).Select("user_id", "created_at", "quota", "request_id", "other").Where("type = ? AND created_at >= ? AND created_at < ? AND quota > 0", LogTypeConsume, start, end).Order(order).Offset(offset).Limit(500).Find(&logs).Error; err != nil {
			return err
		}
		if len(logs) == 0 {
			break
		}
		type logMetadata struct {
			Source string `json:"billing_source"`
			IsTask bool   `json:"is_task"`
			TaskID string `json:"task_id"`
		}
		type chargeKey struct {
			user    int
			request string
		}
		metadata := make([]logMetadata, len(logs))
		valid := make([]bool, len(logs))
		requests := make([]string, 0, len(logs))
		userIDs := make([]int, 0, len(logs))
		taskIDs := []string{}
		for i, log := range logs {
			userIDs = append(userIDs, log.UserId)
			if log.RequestId != "" {
				requests = append(requests, log.RequestId)
			}
			valid[i] = common.UnmarshalJsonStr(log.Other, &metadata[i]) == nil
			if valid[i] && metadata[i].Source == "" && metadata[i].IsTask && metadata[i].TaskID != "" {
				taskIDs = append(taskIDs, metadata[i].TaskID)
			}
		}
		// Task consumption and settlement logs historically omit billing_source.
		// Recover it only from a unique task owned by the same user; duplicated
		// upstream task IDs or missing durable context remain explicitly unknown.
		taskSources := map[chargeKey]string{}
		if len(taskIDs) > 0 {
			var tasks []Task
			if err := DB.WithContext(ctx).Select("user_id", "task_id", "private_data").Where("user_id IN ? AND task_id IN ?", userIDs, taskIDs).Find(&tasks).Error; err != nil {
				return err
			}
			for _, task := range tasks {
				key := chargeKey{task.UserId, task.TaskID}
				if _, exists := taskSources[key]; exists {
					taskSources[key] = ""
					continue
				}
				taskSources[key] = task.PrivateData.BillingSource
			}
		}
		var charges []EnterpriseWalletCharge
		if len(requests) > 0 {
			if err := DB.WithContext(ctx).Where("user_id IN ? AND request_id IN ?", userIDs, requests).Find(&charges).Error; err != nil {
				return err
			}
		}
		allocations := make(map[chargeKey]EnterpriseWalletCharge, len(charges))
		for _, charge := range charges {
			allocations[chargeKey{charge.UserId, charge.RequestId}] = charge
		}
		for i, log := range logs {
			source := metadata[i].Source
			if valid[i] && source == "" && metadata[i].IsTask {
				source = taskSources[chargeKey{log.UserId, metadata[i].TaskID}]
			}
			if !valid[i] || source != "wallet" {
				if source != "subscription" {
					unknown++
				}
				continue
			}
			personal := log.Quota
			user, exists := byID[log.UserId]
			if charge, ok := allocations[chargeKey{log.UserId, log.RequestId}]; ok {
				// Refunds can mutate allocations: do not guess an original split.
				if charge.Legacy != 0 || charge.Personal < 0 || charge.Enterprise < 0 || int64(charge.Personal)+int64(charge.Enterprise) != int64(log.Quota) {
					unknown++
					continue
				}
				personal = charge.Personal
			} else if exists && user.EnterpriseWalletVersion > 0 {
				unknown++
				continue
			}
			if personal <= 0 {
				continue
			}
			award := aggregates[log.UserId]
			if award == nil {
				award = &ChampionAward{EventID: 1, UserID: log.UserId, Username: user.Username, Status: "preview"}
				switch {
				case !exists || user.DeletedAt.Valid:
					award.Reason = "deleted"
				case user.Role >= common.RoleAdminUser:
					award.Reason = "administrator"
				case user.Status != common.UserStatusEnabled:
					award.Reason = "disabled"
				case slices.Contains(excluded, user.Id):
					award.Reason = "excluded"
				}
				aggregates[log.UserId] = award
			}
			if award.Spend > int64(common.MaxWalletQuota)-int64(personal) {
				return ErrWalletQuotaLimitExceeded
			}
			award.Spend += int64(personal)
			award.ReachedAt = max(award.ReachedAt, log.CreatedAt)
		}
	}
	awards := make([]ChampionAward, 0, len(aggregates))
	for _, award := range aggregates {
		awards = append(awards, *award)
	}
	slices.SortFunc(awards, func(a, b ChampionAward) int {
		if a.Spend != b.Spend {
			if a.Spend > b.Spend {
				return -1
			}
			return 1
		}
		if a.ReachedAt != b.ReachedAt {
			if a.ReachedAt < b.ReachedAt {
				return -1
			}
			return 1
		}
		return a.UserID - b.UserID
	})
	winner, err := common.WalletQuotaFromDecimalStrict(decimal.RequireFromString("66.6").Mul(decimal.NewFromFloat(common.QuotaPerUnit)))
	if err != nil {
		return err
	}
	memorial, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromFloat(common.QuotaPerUnit))
	if err != nil {
		return err
	}
	var total int64
	count := 0
	for i := range awards {
		if awards[i].Reason != "" {
			continue
		}
		count++
		awards[i].Position = count
		awards[i].Quota = memorial
		if count <= 7 {
			awards[i].Quota = winner
		}
		if total > int64(common.MaxWalletQuota)-int64(awards[i].Quota) {
			return ErrWalletQuotaLimitExceeded
		}
		total += int64(awards[i].Quota)
	}
	return DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current ChampionEvent
		if err := lockForUpdate(tx).First(&current, 1).Error; err != nil {
			return err
		}
		if current.Status != "draft" || current.Revision != revision {
			return errors.New("The activity changed. Refresh and try again.")
		}
		if err := tx.Where("event_id = ?", 1).Delete(&ChampionAward{}).Error; err != nil {
			return err
		}
		if len(awards) > 0 {
			if err := tx.CreateInBatches(awards, 100).Error; err != nil {
				return err
			}
		}
		return tx.Model(&current).Updates(map[string]any{"revision": current.Revision + 1, "snapshot_at": now.Unix(), "snapshot_end": end, "participants": count, "total_quota": total, "unknown_logs": unknown}).Error
	})
}

func ConfirmChampionEvent(ctx context.Context, revision int64, adminID int, now time.Time) error {
	_, end := ChampionWindow()
	if now.Unix() < end {
		return errors.New("Awards can only be confirmed after the activity ends")
	}
	return DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var event ChampionEvent
		if err := lockForUpdate(tx).First(&event, 1).Error; err != nil {
			return err
		}
		if event.Status != "draft" {
			return nil
		}
		if event.Revision != revision || event.SnapshotEnd != end || event.SnapshotAt == 0 {
			return errors.New("Generate a new award preview before confirming")
		}
		var awards []ChampionAward
		if err := tx.Where("event_id = ? AND position > 0", 1).Find(&awards).Error; err != nil {
			return err
		}
		// Eligibility is checked again at confirmation. A changed account requires
		// a new preview so the operator never approves one list and credits another.
		for _, award := range awards {
			var user User
			if err := tx.First(&user, award.UserID).Error; err != nil {
				return errors.New("Eligibility changed. Generate a new award preview.")
			}
			if user.Status != common.UserStatusEnabled || user.Role >= common.RoleAdminUser {
				return errors.New("Eligibility changed. Generate a new award preview.")
			}
		}
		if err := tx.Model(&ChampionAward{}).Where("event_id = ? AND position > 0", 1).Updates(map[string]any{"status": "claimable", "equipped": gorm.Expr("CASE WHEN position <= 7 THEN position ELSE 8 END")}).Error; err != nil {
			return err
		}
		return tx.Model(&event).Updates(map[string]any{"status": "claiming", "published": true, "confirmed_by": adminID, "confirmed_at": now.Unix(), "revision": event.Revision + 1}).Error
	})
}

// ResolveChampionAward only resolves the authenticated user's own reward. The
// terminal transition and wallet credit share a transaction, so concurrent claims
// or a claim racing a decline cannot pay twice or undo the user's decision.
func ResolveChampionAward(ctx context.Context, userID int, decision string) error {
	if decision != "claim" && decision != "decline" {
		return errors.New("Invalid reward decision")
	}
	var quota int
	err := DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var award ChampionAward
		if err := lockForUpdate(tx).Where("event_id = ? AND user_id = ?", 1, userID).First(&award).Error; err != nil {
			return err
		}
		status := "credited"
		if decision == "decline" {
			status = "declined"
		}
		if award.Status == status {
			return nil
		}
		if award.Status != "claimable" {
			return errors.New("This reward is no longer available to claim")
		}
		var user User
		if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
			return err
		}
		if user.Status != common.UserStatusEnabled || user.Role >= common.RoleAdminUser {
			return errors.New("This account is not eligible for the reward")
		}
		updates := map[string]any{"status": status}
		if decision == "claim" {
			if award.Quota <= 0 || common.ValidateWalletQuota(award.Quota) != nil {
				return errors.New("Invalid reward amount")
			}
			updates["credited_at"] = time.Now().Unix()
		}
		result := tx.Model(&award).Where("status = ?", "claimable").Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errors.New("This reward is no longer available to claim")
		}
		if decision == "decline" {
			return nil
		}
		result = tx.Model(&User{}).Where("id = ? AND quota + enterprise_frozen_quota <= ?", user.Id, common.MaxWalletQuota-award.Quota).Update("quota", gorm.Expr("quota + ?", award.Quota))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrWalletQuotaLimitExceeded
		}
		quota = award.Quota
		return nil
	})
	if err == nil && quota > 0 {
		syncCreditUserQuotaCache(userID, quota, "championship activity")
	}
	return err
}

// The scheduler only freezes entitlements. It must never credit a wallet: the
// recipient explicitly claims the reward through the authenticated self API.
func RunChampionCampaign(ctx context.Context, now time.Time) error {
	_, end := ChampionWindow()
	if now.Unix() < end {
		return nil
	}
	event, err := GetChampionEvent(ctx)
	if err != nil {
		return err
	}
	if event.Status == "completed" || event.Status == "claiming" {
		return nil
	}
	if event.Status == "draft" {
		if err := PreviewChampionEvent(ctx, now, event.Revision); err != nil {
			return err
		}
		// 0 records automatic confirmation, not an administrator's identity.
		return ConfirmChampionEvent(ctx, event.Revision+1, 0, now)
	}
	if event.Status == "awarding" {
		// Preserve issued awards when upgrading an earlier preview deployment;
		// undelivered rewards now require the recipient's explicit claim.
		return DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := lockForUpdate(tx).First(&event, 1).Error; err != nil {
				return err
			}
			if event.Status != "awarding" {
				return nil
			}
			if err := tx.Model(&ChampionAward{}).Where("event_id = ? AND status = ?", 1, "pending").Updates(map[string]any{"status": "claimable", "equipped": gorm.Expr("CASE WHEN position <= 7 THEN position ELSE 8 END")}).Error; err != nil {
				return err
			}
			return tx.Model(&event).Updates(map[string]any{"status": "claiming", "published": true}).Error
		})
	}
	return fmt.Errorf("unexpected championship status: %s", event.Status)
}
