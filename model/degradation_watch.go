package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// DegradationWatchRecord 是「降智检测」的一次作答：同一句提示词在某个渠道上
// 跑一遍，把画出来的 HTML、耗时和用量原样存下来。失败也落一条，失败本身就是
// 要看的信号之一。这张表只做展示，不参与计费，也不写使用日志。
type DegradationWatchRecord struct {
	Id              int    `json:"id"`
	ChannelId       int    `json:"channel_id" gorm:"index;not null"`
	ModelName       string `json:"model_name" gorm:"type:varchar(128);not null;default:''"`
	ReasoningEffort string `json:"reasoning_effort" gorm:"type:varchar(32);not null;default:''"`
	Success         bool   `json:"success" gorm:"not null;default:false"`
	// FailureReason 截断到 maxDegradationWatchFailureReasonRunes，上游偶尔把整页
	// HTML 错误页塞进报错里。
	FailureReason string `json:"failure_reason" gorm:"type:varchar(512);not null;default:''"`
	// Html 是抽出来的作品本体，动辄几十 KB，所以用 LongText；列表接口不查这一列。
	Html             LongText `json:"-"`
	ElapsedMs        int64    `json:"elapsed_ms" gorm:"not null;default:0"`
	PromptTokens     int      `json:"prompt_tokens" gorm:"not null;default:0"`
	CompletionTokens int      `json:"completion_tokens" gorm:"not null;default:0"`
	ReasoningTokens  int      `json:"reasoning_tokens" gorm:"not null;default:0"`
	// Hidden 只影响展示：被管理员藏起来的作品照样计入成功率。
	Hidden    bool  `json:"hidden" gorm:"not null;default:false"`
	CreatedAt int64 `json:"created_at" gorm:"bigint;index"`
}

const maxDegradationWatchFailureReasonRunes = 500

// degradationWatchListColumns 是列表查询要的列，刻意不含 html。
var degradationWatchListColumns = []string{
	"id", "channel_id", "model_name", "reasoning_effort", "success", "failure_reason",
	"elapsed_ms", "prompt_tokens", "completion_tokens", "reasoning_tokens", "hidden", "created_at",
}

// DegradationWatchChannelStats 是一个渠道在保留窗口内的统计。Total / Succeeded
// 含被隐藏的作品，Visible 是检测墙上实际能看到的张数。
type DegradationWatchChannelStats struct {
	ChannelId    int   `json:"channel_id"`
	Total        int64 `json:"total"`
	Succeeded    int64 `json:"succeeded"`
	Visible      int64 `json:"visible"`
	LastRecordAt int64 `json:"last_record_at"`
}

func CreateDegradationWatchRecord(record *DegradationWatchRecord) error {
	if record == nil {
		return errors.New("degradation watch record is nil")
	}
	if runes := []rune(record.FailureReason); len(runes) > maxDegradationWatchFailureReasonRunes {
		record.FailureReason = string(runes[:maxDegradationWatchFailureReasonRunes])
	}
	if record.CreatedAt == 0 {
		record.CreatedAt = common.GetTimestamp()
	}
	return DB.Create(record).Error
}

// ListDegradationWatchRecords 按时间倒序返回某个渠道的记录（不含 html）。
// beforeId > 0 时只返回比它更早的记录，用于「查看更多」。
func ListDegradationWatchRecords(channelId int, beforeId int, limit int, includeHidden bool) ([]*DegradationWatchRecord, error) {
	query := DB.Model(&DegradationWatchRecord{}).
		Select(degradationWatchListColumns).
		Where("channel_id = ?", channelId)
	if beforeId > 0 {
		query = query.Where("id < ?", beforeId)
	}
	if !includeHidden {
		query = query.Where("hidden = ?", false)
	}
	var records []*DegradationWatchRecord
	err := query.Order("id desc").Limit(limit).Find(&records).Error
	return records, err
}

// GetDegradationWatchRecordMeta 取一条记录的元数据（不含 html）。
func GetDegradationWatchRecordMeta(id int) (*DegradationWatchRecord, error) {
	var record DegradationWatchRecord
	err := DB.Select(degradationWatchListColumns).Where("id = ?", id).First(&record).Error
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func GetDegradationWatchRecordHtml(id int) (string, error) {
	var record DegradationWatchRecord
	if err := DB.Select("id", "html").Where("id = ?", id).First(&record).Error; err != nil {
		return "", err
	}
	return string(record.Html), nil
}

func SetDegradationWatchRecordHidden(id int, hidden bool) error {
	result := DB.Model(&DegradationWatchRecord{}).Where("id = ?", id).Update("hidden", hidden)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		// MySQL 在值没变时也报 0 行，再确认一次记录是否存在。
		var count int64
		if err := DB.Model(&DegradationWatchRecord{}).Where("id = ?", id).Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			return gorm.ErrRecordNotFound
		}
	}
	return nil
}

// GetDegradationWatchChannelStats 按渠道汇总。布尔列用参数绑定比较而不是
// SUM(success)，PostgreSQL 的 boolean 不能直接求和。
func GetDegradationWatchChannelStats(channelIds []int) (map[int]*DegradationWatchChannelStats, error) {
	stats := make(map[int]*DegradationWatchChannelStats, len(channelIds))
	if len(channelIds) == 0 {
		return stats, nil
	}
	var rows []DegradationWatchChannelStats
	err := DB.Model(&DegradationWatchRecord{}).
		Select("channel_id, COUNT(*) AS total, "+
			"SUM(CASE WHEN success = ? THEN 1 ELSE 0 END) AS succeeded, "+
			"SUM(CASE WHEN hidden = ? THEN 1 ELSE 0 END) AS visible, "+
			"MAX(created_at) AS last_record_at", true, false).
		Where("channel_id IN ?", channelIds).
		Group("channel_id").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	for i := range rows {
		row := rows[i]
		stats[row.ChannelId] = &row
	}
	return stats, nil
}

// PruneDegradationWatchRecords 只保留该渠道最新的 keep 条（隐藏的也算在内），
// 返回删掉的条数。先找出第 keep 新的那条的 id 再按 id 删，三种数据库都支持，
// 不依赖 DELETE ... ORDER BY ... LIMIT 或子查询里引用同表。
func PruneDegradationWatchRecords(channelId int, keep int) (int64, error) {
	if keep < 1 {
		return 0, errors.New("keep must be positive")
	}
	var boundary []int
	err := DB.Model(&DegradationWatchRecord{}).
		Where("channel_id = ?", channelId).
		Order("id desc").
		Offset(keep-1).
		Limit(1).
		Pluck("id", &boundary).Error
	if err != nil {
		return 0, err
	}
	if len(boundary) == 0 {
		return 0, nil
	}
	result := DB.Where("channel_id = ? AND id < ?", channelId, boundary[0]).Delete(&DegradationWatchRecord{})
	return result.RowsAffected, result.Error
}

// GetDegradationWatchRecordedChannelIds 列出表里出现过的渠道，用于裁剪已经
// 移出检测分组的渠道的旧记录。
func GetDegradationWatchRecordedChannelIds() ([]int, error) {
	var ids []int
	err := DB.Model(&DegradationWatchRecord{}).Distinct("channel_id").Pluck("channel_id", &ids).Error
	return ids, err
}
