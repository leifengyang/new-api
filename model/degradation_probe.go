package model

import (
	"strings"
	"unicode/utf8"

	"gorm.io/gorm"
)

func getDegradationProbeActivity() (*SystemTask, []*DegradationWatchRecord, error) {
	tasks, err := GetLatestSystemTasks([]string{SystemTaskTypeDegradationWatch, "degradation_probe_text", "degradation_probe_followup"})
	if err != nil {
		return nil, nil, err
	}
	var selected *SystemTask
	ids := []string{}
	for _, task := range tasks {
		ids = append(ids, task.TaskID)
		active := task.Status == SystemTaskStatusPending || task.Status == SystemTaskStatusRunning
		if selected == nil || active || (selected.Status != SystemTaskStatusRunning && selected.Status != SystemTaskStatusPending && task.ID > selected.ID) {
			selected = task
		}
	}
	var records []*DegradationWatchRecord
	if len(ids) > 0 {
		err = DB.Select(degradationWatchListColumns).Where("run_id IN ? OR (trigger_record_id IS NOT NULL AND status = ?)", ids, "queued").Order("id desc").Limit(200).Find(&records).Error
	}
	return selected, records, err
}

type DegradationProbeSeries struct {
	GroupName string
	ChannelID int
	Model     string
	ProbeID   string
	Legacy    bool
}

func degradationProbeQuery(series DegradationProbeSeries) *gorm.DB {
	query := DB.Model(&DegradationWatchRecord{}).Where("channel_id = ? AND model_name = ?", series.ChannelID, series.Model)
	if series.Legacy {
		return query.Where("((group_name = ? AND probe_id = ?) OR (group_name = '' AND probe_id = ''))", series.GroupName, series.ProbeID)
	}
	return query.Where("group_name = ? AND probe_id = ?", series.GroupName, series.ProbeID)
}

func LastDegradationProbeAttempt(series DegradationProbeSeries) (int64, error) {
	var latest int64
	err := degradationProbeQuery(series).Where("trigger_record_id IS NULL").Select("COALESCE(MAX(created_at), 0)").Scan(&latest).Error
	return latest, err
}

type DegradationProbeStats struct {
	Passed       int64   `json:"passed"`
	Intermediate int64   `json:"intermediate"`
	Mismatched   int64   `json:"mismatched"`
	Errors       int64   `json:"errors"`
	AvgElapsedMs float64 `json:"avg_elapsed_ms"`
	LastRecordAt int64   `json:"last_record_at"`
}

func GetDegradationProbeHistory(series DegradationProbeSeries, since int64, before, limit int, admin bool) ([]*DegradationWatchRecord, DegradationProbeStats, *DegradationWatchRecord, error) {
	return GetDegradationProbeHistoryForSeries([]DegradationProbeSeries{series}, since, before, limit, admin)
}

// GetDegradationProbeHistoryForSeries aggregates only explicitly selected
// channel/group/model/probe combinations, with one shared pagination cursor.
func GetDegradationProbeHistoryForSeries(series []DegradationProbeSeries, since int64, before, limit int, admin bool) ([]*DegradationWatchRecord, DegradationProbeStats, *DegradationWatchRecord, error) {
	scope := DB.Where("1 = 0")
	for _, item := range series {
		scope = scope.Or(degradationProbeQuery(item))
	}
	query := DB.Model(&DegradationWatchRecord{}).Where(scope).Where("(created_at >= ? OR status IN ?)", since, []string{"queued", "running"})
	if !admin {
		query = query.Where("hidden = ?", false)
	}
	var stats DegradationProbeStats
	// Legacy drawing validation failures are mismatches; transport failures are exceptions.
	err := query.Session(&gorm.Session{}).Where("status NOT IN ?", []string{"queued", "running"}).Select(
		"COALESCE(SUM(CASE WHEN success = ? THEN 1 ELSE 0 END), 0) AS passed, "+
			"COALESCE(SUM(CASE WHEN verdict = 'intermediate' THEN 1 ELSE 0 END), 0) AS intermediate, "+
			"COALESCE(SUM(CASE WHEN success = ? AND (verdict = 'mismatch' OR failure_reason IN ?) THEN 1 ELSE 0 END), 0) AS mismatched, "+
			"COALESCE(SUM(CASE WHEN success = ? AND verdict NOT IN ('mismatch', 'intermediate') AND failure_reason NOT IN ? THEN 1 ELSE 0 END), 0) AS errors, "+
			"COALESCE(AVG(CASE WHEN success = ? THEN elapsed_ms ELSE NULL END), 0) AS avg_elapsed_ms, COALESCE(MAX(created_at), 0) AS last_record_at",
		true, false, []string{"no_html", "no_svg", "empty_content"}, false, []string{"no_html", "no_svg", "empty_content"}, true).Scan(&stats).Error
	if err != nil {
		return nil, stats, nil, err
	}
	var artwork []*DegradationWatchRecord
	err = query.Session(&gorm.Session{}).Select(degradationWatchListColumns).Where("success = ? AND (probe_kind = 'drawing' OR probe_kind = '')", true).Order("id desc").Limit(1).Find(&artwork).Error
	if err != nil {
		return nil, stats, nil, err
	}
	var latest *DegradationWatchRecord
	if len(artwork) > 0 {
		latest = artwork[0]
	}
	if before > 0 {
		query = query.Where("id < ?", before)
	}
	// Full diagnostics and prompts are fetched only when a status block is opened.
	columns := []string{"id", "channel_id", "group_name", "model_name", "probe_id", "probe_name", "probe_kind", "verdict", "success", "status", "failure_reason", "elapsed_ms", "created_at", "prompt_tokens", "completion_tokens", "reasoning_tokens", "tokens_estimated", "reasoning_effort", "hidden"}
	// Read answers in the same bounded query, without fetching drawing output.
	// CASE is supported by all three databases. Only the final character survives
	// in the returned summary; full content remains available through details.
	columns = append(columns, "CASE WHEN probe_kind = 'text' AND status NOT IN ('queued', 'running') AND (success = ? OR verdict = 'mismatch') THEN output_text ELSE '' END AS output_text")
	var records []*DegradationWatchRecord
	err = query.Select(strings.Join(columns, ", "), true).Order("id desc").Limit(limit).Find(&records).Error
	for _, record := range records {
		answer := strings.TrimSpace(string(record.OutputText))
		if answer != "" {
			last, _ := utf8.DecodeLastRuneInString(answer)
			record.AnswerLastCharacter = string(last)
		}
		record.OutputText = ""
	}
	return records, stats, latest, err
}

func GetDegradationProbeContent(id int) (*DegradationWatchRecord, error) {
	var record DegradationWatchRecord
	err := DB.Select("id", "prompt_snapshot", "expected_snapshot", "intermediate_expected_snapshot", "match_snapshot", "output_text", "error_details").First(&record, id).Error
	return &record, err
}
