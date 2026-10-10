package model

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// Dimensions are private administrative snapshots. They must never be serialized
// through the personal wallet or public consume-log APIs.
type CompensationDimensions struct {
	Username        string `json:"username" gorm:"type:varchar(255)"`
	ChannelID       int    `json:"channel_id"`
	ChannelName     string `json:"channel_name" gorm:"type:varchar(255)"`
	UseGroup        string `json:"use_group" gorm:"type:varchar(255)"`
	Funding         string `json:"funding" gorm:"type:varchar(32)"`
	EnterpriseQuota int    `json:"enterprise_quota"`
	PersonalQuota   int    `json:"personal_quota"`
}

type CompensationReportFilter struct {
	TimeBasis string  `form:"time_basis"`
	Start     int64   `form:"start_at"`
	End       int64   `form:"end_at"`
	User      string  `form:"user"`
	Channel   string  `form:"channel"`
	Group     *string `form:"group"`
	Model     *string `form:"model"`
	Reason    string  `form:"reason"`
	Funding   *string `form:"funding"`
	Day       string  `form:"day"`
}

func (f CompensationReportFilter) Validate() error {
	for _, value := range []string{f.User, f.Channel} {
		if value != "" {
			id, err := strconv.Atoi(value)
			if err != nil || id < 0 {
				return errors.New("invalid user or channel id")
			}
		}
	}
	if f.TimeBasis != "credited" && f.TimeBasis != "consumed" {
		return errors.New("invalid time basis")
	}
	if f.Start < 0 || f.End < 0 || (f.End > 0 && f.Start >= f.End) {
		return errors.New("invalid date range")
	}
	return nil
}

func compensationDayExpression(basis string) string {
	column := "credited_at"
	if basis == "consumed" {
		column = "consumed_at"
	}
	switch {
	case common.UsingMainDatabase(common.DatabaseTypeMySQL):
		return "DATE_FORMAT(DATE_ADD('1970-01-01', INTERVAL (" + column + " + 28800) SECOND), '%Y-%m-%d')"
	case common.UsingMainDatabase(common.DatabaseTypePostgreSQL):
		return "TO_CHAR(TIMESTAMP '1970-01-01' + (" + column + " + 28800) * INTERVAL '1 second', 'YYYY-MM-DD')"
	default:
		return "strftime('%Y-%m-%d', " + column + ", 'unixepoch', '+8 hours')"
	}
}

func compensationReportQuery(ctx context.Context, f CompensationReportFilter) *gorm.DB {
	q := DB.WithContext(ctx).Model(&StreamCompensation{}).Where("status = ?", "credited")
	column := "credited_at"
	if f.TimeBasis == "consumed" {
		column = "consumed_at"
	}
	if f.Start > 0 {
		q = q.Where(column+" >= ?", f.Start)
	}
	if f.End > 0 {
		q = q.Where(column+" < ?", f.End)
	}
	if f.User != "" {
		id, _ := strconv.Atoi(f.User)
		q = q.Where("user_id = ?", id)
	}
	if f.Channel != "" {
		id, _ := strconv.Atoi(f.Channel)
		q = q.Where("COALESCE(dimension_channel_id, 0) = ?", id)
	}
	if f.Group != nil {
		q = q.Where("COALESCE(dimension_use_group, '') = ?", *f.Group)
	}
	if f.Model != nil {
		q = q.Where("model_name = ?", *f.Model)
	}
	if f.Reason != "" {
		q = q.Where("reason = ?", f.Reason)
	}
	if f.Funding != nil {
		q = q.Where("COALESCE(dimension_funding, '') = ?", *f.Funding)
	}
	if f.Day != "" {
		q = q.Where(compensationDayExpression(f.TimeBasis)+" = ?", f.Day)
	}
	return q
}

type CompensationReportTotals struct {
	Quota int64 `json:"quota"`
	Count int64 `json:"count"`
	Users int64 `json:"users"`
}
type CompensationAggregate struct {
	L0 string `json:"l0"`
	L1 string `json:"l1"`
	L2 string `json:"l2"`
	D0 string `json:"d0"`
	D1 string `json:"d1"`
	D2 string `json:"d2"`
	CompensationReportTotals
}

// Only this allowlist can contribute SQL identifiers; values always use binds.
func compensationAggregateQuery(ctx context.Context, f CompensationReportFilter, dimensions []string) (*gorm.DB, error) {
	if err := f.Validate(); err != nil {
		return nil, err
	}
	if len(dimensions) < 1 || len(dimensions) > 3 {
		return nil, errors.New("select one to three dimensions")
	}
	castType := "TEXT"
	if common.UsingMainDatabase(common.DatabaseTypeMySQL) {
		castType = "CHAR"
	}
	columns := map[string]string{
		"user": "CAST(user_id AS " + castType + ")", "channel": "CAST(COALESCE(dimension_channel_id, 0) AS " + castType + ")",
		"group": "COALESCE(dimension_use_group, '')", "model": "model_name", "reason": "reason",
		"funding": "COALESCE(dimension_funding, '')", "day": compensationDayExpression(f.TimeBasis),
	}
	selects := []string{"COALESCE(SUM(quota), 0) AS quota", "COUNT(*) AS count", "COUNT(DISTINCT user_id) AS users"}
	groups := []string{}
	seen := map[string]bool{}
	for i, d := range dimensions {
		column, ok := columns[d]
		if !ok || seen[d] {
			return nil, errors.New("invalid or duplicate dimension")
		}
		seen[d] = true
		selects = append(selects, fmt.Sprintf("%s AS d%d", column, i))
		if d == "user" {
			selects = append(selects, fmt.Sprintf("COALESCE(MAX(dimension_username), '') AS l%d", i))
		}
		if d == "channel" {
			selects = append(selects, fmt.Sprintf("COALESCE(MAX(dimension_channel_name), '') AS l%d", i))
		}
		groups = append(groups, column)
	}
	return compensationReportQuery(ctx, f).Select(strings.Join(selects, ", ")).Group(strings.Join(groups, ", ")), nil
}

func CompensationAggregates(ctx context.Context, f CompensationReportFilter, dimensions []string, offset, limit int) ([]CompensationAggregate, int64, error) {
	q, err := compensationAggregateQuery(ctx, f, dimensions)
	if err != nil {
		return nil, 0, err
	}
	var count int64
	if err := DB.WithContext(ctx).Table("(?) AS aggregated", q).Count(&count).Error; err != nil {
		return nil, 0, err
	}
	items := []CompensationAggregate{}
	order := "quota DESC"
	for i := range dimensions {
		order += fmt.Sprintf(", d%d", i)
	}
	err = q.Order(order).Offset(offset).Limit(limit).Scan(&items).Error
	return items, count, err
}

type CompensationReportOverview struct {
	CompensationReportTotals
	Trend    []CompensationAggregate            `json:"trend"`
	Rankings map[string][]CompensationAggregate `json:"rankings"`
}

func CompensationOverview(ctx context.Context, f CompensationReportFilter) (CompensationReportOverview, error) {
	out := CompensationReportOverview{Trend: []CompensationAggregate{}, Rankings: map[string][]CompensationAggregate{}}
	if err := f.Validate(); err != nil {
		return out, err
	}
	if err := compensationReportQuery(ctx, f).Select("COALESCE(SUM(quota), 0) AS quota, COUNT(*) AS count, COUNT(DISTINCT user_id) AS users").Scan(&out.CompensationReportTotals).Error; err != nil {
		return out, err
	}
	q, err := compensationAggregateQuery(ctx, f, []string{"day"})
	if err != nil {
		return out, err
	}
	if err := q.Order("d0").Scan(&out.Trend).Error; err != nil {
		return out, err
	}
	for _, dimension := range []string{"user", "channel", "model"} {
		items, _, err := CompensationAggregates(ctx, f, []string{dimension}, 0, 10)
		if err != nil {
			return out, err
		}
		out.Rankings[dimension] = items
	}
	return out, nil
}

type CompensationAdminRecord struct {
	StreamCompensation
	Snapshot CompensationDimensions `json:"snapshot"`
}

func CompensationReportRecords(ctx context.Context, f CompensationReportFilter, offset, limit int) ([]CompensationAdminRecord, int64, error) {
	if err := f.Validate(); err != nil {
		return nil, 0, err
	}
	q := compensationReportQuery(ctx, f)
	var count int64
	if err := q.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	var records []StreamCompensation
	if err := q.Order("id DESC").Offset(offset).Limit(limit).Find(&records).Error; err != nil {
		return nil, 0, err
	}
	items := make([]CompensationAdminRecord, 0, len(records))
	for _, record := range records {
		items = append(items, CompensationAdminRecord{StreamCompensation: record, Snapshot: record.Dimensions})
	}
	return items, count, nil
}

// Visit a single database cursor, so exports are not silently truncated at a UI
// page boundary. Callers write each row directly to their CSV stream.
func ExportCompensationReport(ctx context.Context, f CompensationReportFilter, dimensions []string, visit func(any) error) error {
	if err := f.Validate(); err != nil {
		return err
	}
	q := compensationReportQuery(ctx, f).Order("id")
	if len(dimensions) > 0 {
		var err error
		q, err = compensationAggregateQuery(ctx, f, dimensions)
		if err != nil {
			return err
		}
		q = q.Order("quota DESC, d0")
	}
	rows, err := q.Rows()
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(dimensions) > 0 {
			var item CompensationAggregate
			if err := DB.ScanRows(rows, &item); err != nil {
				return err
			}
			if err := visit(item); err != nil {
				return err
			}
		} else {
			var item StreamCompensation
			if err := DB.ScanRows(rows, &item); err != nil {
				return err
			}
			if err := visit(item); err != nil {
				return err
			}
		}
	}
	return rows.Err()
}
