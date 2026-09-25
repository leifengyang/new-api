package model

import "fmt"

// InitializeInviteCounts 按 users.inviter_id 重算每个邀请人的 aff_count。
//
// 旧版本只在发放「注册即送」的邀请奖励时顺带累加 aff_count，奖励退役后（见
// updateOptionMap 把 QuotaForInviter 归零）存量部署的计数就再也没写过，用户页面
// 的「邀请人数」全部停在 0。这里以邀请关系为准回填一次：少记的补上，下线被删后
// 多记的也一并归零。只对与统计值不一致的行发 UPDATE，重复执行是空操作。
func InitializeInviteCounts() error {
	// 有效下线数：未删除且 inviter_id 指向该用户的记录。GORM 的软删除条件会自动
	// 加在这里，和 inviteUser 记账时的可见性保持一致。
	var invited []struct {
		InviterId int
		Total     int
	}
	if err := DB.Model(&User{}).
		Select("inviter_id, COUNT(*) AS total").
		Where("inviter_id <> 0").
		Group("inviter_id").
		Scan(&invited).Error; err != nil {
		return fmt.Errorf("count invited users per inviter: %w", err)
	}
	totals := make(map[int]int, len(invited))
	for _, row := range invited {
		totals[row.InviterId] = row.Total
	}

	// 聚合结果里只有「还有下线」的人；已经把下线全删掉的邀请人不会出现在其中，
	// 必须单独找出来归零，否则他们会一直挂着过期的计数。
	var counted []int
	if err := DB.Model(&User{}).Where("aff_count <> 0").Pluck("id", &counted).Error; err != nil {
		return fmt.Errorf("list users with a recorded invite count: %w", err)
	}

	targets := make(map[int]struct{}, len(totals)+len(counted))
	for inviterId := range totals {
		targets[inviterId] = struct{}{}
	}
	for _, userId := range counted {
		targets[userId] = struct{}{}
	}
	for userId := range targets {
		wanted := totals[userId]
		if err := DB.Model(&User{}).
			Where("id = ? AND aff_count <> ?", userId, wanted).
			Update("aff_count", wanted).Error; err != nil {
			return fmt.Errorf("backfill invite count for user %d: %w", userId, err)
		}
	}
	return nil
}
