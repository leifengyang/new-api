package controller

import (
	"encoding/csv"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

func GetCompensationReport(c *gin.Context) {
	f := model.CompensationReportFilter{TimeBasis: "credited"}
	if err := c.ShouldBindQuery(&f); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := f.Validate(); err != nil {
		common.ApiError(c, err)
		return
	}
	page := common.GetPageQuery(c)
	switch c.Param("view") {
	case "overview":
		data, err := model.CompensationOverview(c.Request.Context(), f)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		common.ApiSuccess(c, data)
	case "aggregate":
		items, count, err := model.CompensationAggregates(c.Request.Context(), f, strings.Split(c.DefaultQuery("dimensions", "user"), ","), page.GetStartIdx(), page.GetPageSize())
		if err != nil {
			common.ApiError(c, err)
			return
		}
		common.ApiSuccess(c, gin.H{"items": items, "total": count})
	case "records":
		items, count, err := model.CompensationReportRecords(c.Request.Context(), f, page.GetStartIdx(), page.GetPageSize())
		if err != nil {
			common.ApiError(c, err)
			return
		}
		common.ApiSuccess(c, gin.H{"items": items, "total": count})
	default:
		c.Status(404)
	}
}

func ExportCompensationReport(c *gin.Context) {
	f := model.CompensationReportFilter{TimeBasis: "credited"}
	if err := c.ShouldBindQuery(&f); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := f.Validate(); err != nil {
		common.ApiError(c, err)
		return
	}
	var dimensions []string
	if c.Query("kind") == "aggregate" {
		dimensions = strings.Split(c.DefaultQuery("dimensions", "user"), ",")
	} else if c.Query("kind") != "records" {
		common.ApiErrorMsg(c, "invalid export kind")
		return
	}
	// Spool to a private temporary file. A failed/cancelled DB read must not
	// return a successful, silently truncated CSV; memory stays bounded.
	file, err := os.CreateTemp("", "new-api-compensation-*.csv")
	if err != nil {
		common.ApiError(c, err)
		return
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.WriteString("\ufeff"); err != nil {
		common.ApiError(c, err)
		return
	}
	w := csv.NewWriter(file)
	header := []string{"id", "user_id", "username", "channel_id", "channel_name", "group", "model", "reason", "funding", "original_quota", "enterprise_quota", "personal_quota", "credited_quota", "credited_usd", "consumed_at_beijing", "credited_at_beijing", "request_id"}
	if len(dimensions) > 0 {
		header = append(append([]string{}, dimensions...), "credited_quota", "credited_usd", "count", "users")
	}
	if err := w.Write(header); err != nil {
		common.ApiError(c, err)
		return
	}
	err = model.ExportCompensationReport(c.Request.Context(), f, dimensions, func(value any) error {
		var row []string
		switch item := value.(type) {
		case model.CompensationAggregate:
			values := []string{item.D0, item.D1, item.D2}
			row = append(row, values[:len(dimensions)]...)
			row = append(row, strconv.FormatInt(item.Quota, 10), decimal.NewFromInt(item.Quota).Div(decimal.NewFromFloat(common.QuotaPerUnit)).String(), strconv.FormatInt(item.Count, 10), strconv.FormatInt(item.Users, 10))
		case model.StreamCompensation:
			d := item.Dimensions
			row = []string{strconv.FormatInt(item.ID, 10), strconv.Itoa(item.UserID), d.Username, strconv.Itoa(d.ChannelID), d.ChannelName, d.UseGroup, item.ModelName, item.Reason, d.Funding, strconv.Itoa(item.OriginalQuota), strconv.Itoa(d.EnterpriseQuota), strconv.Itoa(d.PersonalQuota), strconv.Itoa(item.Quota), decimal.NewFromInt(int64(item.Quota)).Div(decimal.NewFromFloat(common.QuotaPerUnit)).String(), time.Unix(item.ConsumedAt, 0).In(model.CompensationLocation).Format(time.DateTime), time.Unix(item.CreditedAt, 0).In(model.CompensationLocation).Format(time.DateTime), item.RequestID}
		}
		for i, value := range row {
			trimmed := strings.TrimSpace(value)
			if trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0])) {
				row[i] = "'" + value
			}
		}
		return w.Write(row)
	})
	w.Flush()
	if err == nil {
		err = w.Error()
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	info, err := file.Stat()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if _, err := file.Seek(0, 0); err != nil {
		common.ApiError(c, err)
		return
	}
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="compensation-%s.csv"`, c.Query("kind")))
	c.DataFromReader(200, info.Size(), "text/csv; charset=utf-8", file, nil)
}
