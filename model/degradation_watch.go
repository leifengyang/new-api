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
	Id        int `json:"id"`
	ChannelId int `json:"channel_id" gorm:"index;not null"`
	// RunId ties each model/channel attempt to its background batch. Legacy records may be empty.
	RunId           string `json:"run_id" gorm:"type:varchar(64);not null;default:'';index"`
	ModelName       string `json:"model_name" gorm:"type:varchar(128);not null;default:''"`
	ReasoningEffort string `json:"reasoning_effort" gorm:"type:varchar(32);not null;default:''"`
	Success         bool   `json:"success" gorm:"not null;default:false"`
	// FailureReason 截断到 maxDegradationWatchFailureReasonRunes，上游偶尔把整页
	// HTML 错误页塞进报错里。
	FailureReason string `json:"failure_reason" gorm:"type:varchar(512);not null;default:''"`
	// Empty status denotes a completed legacy record.
	Status          string   `json:"status" gorm:"type:varchar(16);not null;default:'';index"`
	ErrorDetails    LongText `json:"error_details"`
	OutputText      LongText `json:"-"`
	TokensEstimated bool     `json:"tokens_estimated" gorm:"not null;default:false"`
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
	"id", "channel_id", "run_id", "model_name", "reasoning_effort", "success", "failure_reason",
	"elapsed_ms", "prompt_tokens", "completion_tokens", "reasoning_tokens", "hidden", "created_at",
	"status", "error_details", "tokens_estimated",
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
		if record.ErrorDetails == "" {
			record.ErrorDetails = LongText(record.FailureReason)
		}
		record.FailureReason = string(runes[:maxDegradationWatchFailureReasonRunes])
	}
	if record.CreatedAt == 0 {
		record.CreatedAt = common.GetTimestamp()
	}
	return DB.Create(record).Error
}

// UpdateDegradationWatchProgress never overwrites a terminal result or visibility.
func UpdateDegradationWatchProgress(record *DegradationWatchRecord) error {
	return DB.Model(&DegradationWatchRecord{}).Where("id = ? AND status IN ?", record.Id, []string{"queued", "running"}).Updates(map[string]any{
		"status": record.Status, "elapsed_ms": record.ElapsedMs, "prompt_tokens": record.PromptTokens,
		"completion_tokens": record.CompletionTokens, "reasoning_tokens": record.ReasoningTokens,
		"tokens_estimated": record.TokensEstimated, "output_text": record.OutputText,
	}).Error
}

func FinishDegradationWatchRecord(record *DegradationWatchRecord) error {
	if record.Success {
		record.Status = "succeeded"
	} else {
		record.Status = "failed"
	}
	if record.ErrorDetails == "" {
		record.ErrorDetails = LongText(record.FailureReason)
	}
	if runes := []rune(record.FailureReason); len(runes) > maxDegradationWatchFailureReasonRunes {
		record.FailureReason = string(runes[:maxDegradationWatchFailureReasonRunes])
	}
	return DB.Model(&DegradationWatchRecord{}).Where("id = ? AND status IN ?", record.Id, []string{"queued", "running"}).Updates(map[string]any{
		"status": record.Status, "success": record.Success, "failure_reason": record.FailureReason, "error_details": record.ErrorDetails,
		"html": record.Html, "output_text": record.OutputText, "elapsed_ms": record.ElapsedMs,
		"prompt_tokens": record.PromptTokens, "completion_tokens": record.CompletionTokens, "reasoning_tokens": record.ReasoningTokens, "tokens_estimated": record.TokensEstimated,
	}).Error
}

func GetDegradationWatchOutput(id int) (string, error) {
	var record DegradationWatchRecord
	err := DB.Select("id", "output_text").Where("id = ?", id).First(&record).Error
	return string(record.OutputText), err
}

func GetDegradationWatchActivity() (*SystemTask, []*DegradationWatchRecord, error) {
	var task SystemTask
	if err := DB.Where("type = ?", SystemTaskTypeDegradationWatch).Order("id desc").First(&task).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, []*DegradationWatchRecord{}, nil
		}
		return nil, nil, err
	}
	var records []*DegradationWatchRecord
	err := DB.Select(degradationWatchListColumns).Where("run_id = ?", task.TaskID).Order("id desc").Find(&records).Error
	return &task, records, err
}

// Recover records left behind by a crashed or cancelled system-task runner.
func FailInterruptedDegradationWatchRecords() error {
	activeRuns := DB.Model(&SystemTask{}).Select("task_id").Where("type = ? AND status IN ?", SystemTaskTypeDegradationWatch, activeSystemTaskStatuses())
	return DB.Model(&DegradationWatchRecord{}).Where("status IN ? AND run_id NOT IN (?)", []string{"queued", "running"}, activeRuns).Updates(map[string]any{
		"status": "failed", "failure_reason": "interrupted", "error_details": "Detection interrupted: its background task stopped or lost its execution lease.",
	}).Error
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
		Where("status NOT IN ?", []string{"queued", "running"}).
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

// DegradationWatchModelStats 是一个模型（一条泳道）在保留窗口内的统计，口径
// 同 DegradationWatchChannelStats。耗时只平均成功的作答：超时和秒失败会把
// 平均值拉得没有意义。
type DegradationWatchModelStats struct {
	ModelName        string `json:"model_name"`
	Total            int64  `json:"total"`
	Succeeded        int64  `json:"succeeded"`
	Visible          int64  `json:"visible"`
	SucceededElapsed int64  `json:"-"`
	LastRecordAt     int64  `json:"last_record_at"`
}

// GetDegradationWatchModelStats 按模型汇总。channelIds 非 nil 时只统计这些渠道
// （普通用户只该看到配了别名的渠道），nil 表示全部。
func GetDegradationWatchModelStats(channelIds []int) (map[string]*DegradationWatchModelStats, error) {
	stats := make(map[string]*DegradationWatchModelStats)
	if channelIds != nil && len(channelIds) == 0 {
		return stats, nil
	}
	query := DB.Model(&DegradationWatchRecord{}).
		Where("status NOT IN ?", []string{"queued", "running"}).
		Select("model_name, COUNT(*) AS total, "+
			"SUM(CASE WHEN success = ? THEN 1 ELSE 0 END) AS succeeded, "+
			"SUM(CASE WHEN hidden = ? THEN 1 ELSE 0 END) AS visible, "+
			"SUM(CASE WHEN success = ? THEN elapsed_ms ELSE 0 END) AS succeeded_elapsed, "+
			"MAX(created_at) AS last_record_at", true, false, true)
	if channelIds != nil {
		query = query.Where("channel_id IN ?", channelIds)
	}
	var rows []DegradationWatchModelStats
	if err := query.Group("model_name").Scan(&rows).Error; err != nil {
		return nil, err
	}
	for i := range rows {
		row := rows[i]
		stats[row.ModelName] = &row
	}
	return stats, nil
}

// DegradationWatchRecordFilter 限定检测墙能看到的记录。nil 切片表示不限。
type DegradationWatchRecordFilter struct {
	ChannelIds    []int
	ModelNames    []string
	IncludeHidden bool
}

// ListDegradationWatchRecordsBefore 按 id 倒序返回一页记录（不含 html），跨渠道、
// 跨模型，供检测墙按轮次分组。beforeId > 0 时只返回更早的记录。
func ListDegradationWatchRecordsBefore(filter DegradationWatchRecordFilter, beforeId int, limit int) ([]*DegradationWatchRecord, error) {
	var records []*DegradationWatchRecord
	if (filter.ChannelIds != nil && len(filter.ChannelIds) == 0) || (filter.ModelNames != nil && len(filter.ModelNames) == 0) {
		return records, nil
	}
	query := DB.Model(&DegradationWatchRecord{}).Select(degradationWatchListColumns)
	if filter.ChannelIds != nil {
		query = query.Where("channel_id IN ?", filter.ChannelIds)
	}
	if filter.ModelNames != nil {
		query = query.Where("model_name IN ?", filter.ModelNames)
	}
	if !filter.IncludeHidden {
		query = query.Where("hidden = ?", false)
	}
	if beforeId > 0 {
		query = query.Where("id < ?", beforeId)
	}
	err := query.Order("id desc").Limit(limit).Find(&records).Error
	return records, err
}

// DegradationWatchSeries 是一个「渠道 + 模型」组合，保留条数按它计。
type DegradationWatchSeries struct {
	ChannelId int    `json:"channel_id"`
	ModelName string `json:"model_name"`
}

// GetDegradationWatchRecordedSeries 列出表里出现过的「渠道 + 模型」组合，用于
// 裁剪，包括已经移出配置的模型和渠道。
func GetDegradationWatchRecordedSeries() ([]DegradationWatchSeries, error) {
	var series []DegradationWatchSeries
	err := DB.Model(&DegradationWatchRecord{}).
		Distinct("channel_id", "model_name").
		Scan(&series).Error
	return series, err
}

// PruneDegradationWatchRecords 只保留该「渠道 + 模型」最新的 keep 条（隐藏的也算在内），
// 返回删掉的条数。先找出第 keep 新的那条的 id 再按 id 删，三种数据库都支持，
// 不依赖 DELETE ... ORDER BY ... LIMIT 或子查询里引用同表。
func PruneDegradationWatchRecords(series DegradationWatchSeries, keep int) (int64, error) {
	if keep < 1 {
		return 0, errors.New("keep must be positive")
	}
	var boundary []int
	err := DB.Model(&DegradationWatchRecord{}).
		Where("channel_id = ? AND model_name = ?", series.ChannelId, series.ModelName).
		Where("status NOT IN ?", []string{"queued", "running"}).
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
	result := DB.Where("channel_id = ? AND model_name = ? AND id < ?", series.ChannelId, series.ModelName, boundary[0]).
		Where("status NOT IN ?", []string{"queued", "running"}).
		Delete(&DegradationWatchRecord{})
	return result.RowsAffected, result.Error
}

// GetDegradationWatchRecordedChannelIds 列出表里出现过的渠道，用于裁剪已经
// 移出检测分组的渠道的旧记录。
func GetDegradationWatchRecordedChannelIds() ([]int, error) {
	var ids []int
	err := DB.Model(&DegradationWatchRecord{}).Distinct("channel_id").Pluck("channel_id", &ids).Error
	return ids, err
}
