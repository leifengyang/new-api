package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

// ClassifyStreamCompensation consumes persisted facts, not display percentages or
// the upstream-health policy. Unknown historical EOFs never become refunds.
func ClassifyStreamCompensation(log *model.Log) (status, reason string) {
	if log.Type != model.LogTypeConsume || !log.IsStream || log.Quota <= 0 {
		return "", ""
	}
	var other struct {
		CacheTokens *int64 `json:"cache_tokens"`
		Stream      struct {
			Status           string   `json:"status"`
			EndReason        string   `json:"end_reason"`
			EndError         string   `json:"end_error"`
			ErrorCount       int      `json:"error_count"`
			Errors           []string `json:"errors"`
			Response         string   `json:"response_status"`
			ExpectsTerminal  bool     `json:"expects_terminal"`
			IncompleteReason string   `json:"incomplete_reason"`
		} `json:"stream_status"`
	}
	if common.UnmarshalJsonStr(log.Other, &other) != nil {
		return "", ""
	}
	s := other.Stream
	switch {
	case s.EndReason == "client_gone":
		reason = "client_gone"
	case s.EndReason == "eof":
		// A completed/length-limited protocol response is not an EOF failure.
		if s.Response == "completed" || s.IncompleteReason == "max_output_tokens" || s.IncompleteReason == "max_tokens" {
			return "", ""
		}
		if s.Status != "error" && s.EndError == "" && s.ErrorCount == 0 && len(s.Errors) == 0 && s.Response != "failed" && !(s.ExpectsTerminal && s.Response == "") {
			return "", ""
		}
		reason = "abnormal_eof"
	case s.EndReason == "scanner_error" && (strings.EqualFold(strings.TrimSpace(s.EndError), "unexpected EOF") || strings.EqualFold(strings.TrimSpace(s.EndError), "EOF")):
		reason = "abnormal_eof"
	default:
		return "", ""
	}
	if other.CacheTokens == nil || *other.CacheTokens < 0 {
		return "review", reason
	}
	if *other.CacheTokens != 0 {
		return "", ""
	}
	return "pending", reason
}

func RunStreamCompensation(ctx context.Context, now time.Time) error {
	cfg, err := model.GetStreamCompensationConfig()
	if err != nil || !cfg.Enabled {
		return err
	}
	// A full wallet must not hold every other user's daily settlement hostage.
	// Failed credits remain visible and are retried without rescanning old logs.
	var after int64
	for {
		var failed []model.StreamCompensation
		if err := model.DB.WithContext(ctx).Where("status = ? AND id > ?", "failed", after).Order("id").Limit(200).Find(&failed).Error; err != nil {
			return err
		}
		if len(failed) == 0 {
			break
		}
		for _, record := range failed {
			if err := creditStreamCompensation(ctx, record.ID); err != nil {
				return err
			}
			after = record.ID
		}
	}
	cutoff := model.CompensationCutoff(now)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		batch, err := model.NewStreamCompensationBatch(ctx, cutoff)
		if err != nil || batch == nil {
			return err
		}
		err = runStreamCompensationBatch(ctx, batch)
		if err != nil {
			// Preserve the cursor and every committed credit. The next attempt
			// resumes this batch, even if its system-task lease was interrupted.
			model.DB.Model(batch).Updates(map[string]any{"status": "failed", "error": err.Error()})
			return err
		}
		if err := model.FinishStreamCompensationBatch(ctx, batch); err != nil {
			return err
		}
	}
}

func runStreamCompensationBatch(ctx context.Context, batch *model.StreamCompensationBatch) error {
	if err := model.DB.WithContext(ctx).Model(batch).Updates(map[string]any{"status": "running", "error": ""}).Error; err != nil {
		return err
	}
	for {
		cfg, err := model.GetStreamCompensationConfig()
		if err != nil {
			return err
		}
		if !cfg.Enabled {
			return fmt.Errorf("stream compensation paused")
		}
		var logs []model.Log
		// Portable keyset pagination, including independent ClickHouse log DBs.
		err = model.LOG_DB.WithContext(ctx).Where("type = ? AND is_stream = ? AND quota > 0 AND created_at >= ? AND created_at < ?", model.LogTypeConsume, true, batch.StartAt, batch.EndAt).
			Where("created_at > ? OR (created_at = ? AND request_id > ?) OR (created_at = ? AND request_id = ? AND id > ?)", batch.CursorTime, batch.CursorTime, batch.CursorRequest, batch.CursorTime, batch.CursorRequest, batch.CursorID).
			Order("created_at, request_id, id").Limit(200).Find(&logs).Error
		if err != nil {
			return err
		}
		if len(logs) == 0 {
			return nil
		}
		for i := range logs {
			log := &logs[i]
			status, reason := ClassifyStreamCompensation(log)
			if status == "" {
				continue
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			record := model.StreamCompensation{SourceKey: model.CompensationSourceKey(log), BatchID: batch.ID, UserID: log.UserId, RequestID: log.RequestId, ModelName: log.ModelName, ConsumedAt: log.CreatedAt, OriginalQuota: log.Quota, Quota: log.Quota, Reason: reason, Status: status}
			if status == "review" {
				record.Note = "cache_unknown"
			}
			// Already-refunded charges are excluded rather than paid again. A
			// legacy task refund without request correlation is not a stream log.
			if log.RequestId != "" {
				var refunded int64
				if err := model.LOG_DB.WithContext(ctx).Model(&model.Log{}).Where("user_id = ? AND request_id = ? AND type = ? AND quota > 0", log.UserId, log.RequestId, model.LogTypeRefund).Count(&refunded).Error; err != nil {
					return err
				}
				if refunded > 0 {
					record.Status = "skipped"
					record.Note = "already_refunded"
				}
			}
			if err := model.SaveStreamCompensation(ctx, &record); err != nil {
				return err
			}
			// Re-read after ON CONFLICT: the durable record owns the original
			// amount and batch, including when a previous attempt already paid it.
			if err := model.DB.WithContext(ctx).Where("source_key = ?", record.SourceKey).First(&record).Error; err != nil {
				return err
			}
			if err := creditStreamCompensation(ctx, record.ID); err != nil {
				return err
			}
		}
		last := logs[len(logs)-1]
		batch.CursorTime, batch.CursorRequest, batch.CursorID = last.CreatedAt, last.RequestId, last.Id
		batch.Scanned += int64(len(logs))
		if err := model.DB.WithContext(ctx).Model(batch).Updates(map[string]any{"cursor_time": batch.CursorTime, "cursor_request": batch.CursorRequest, "cursor_id": batch.CursorID, "scanned": batch.Scanned}).Error; err != nil {
			return err
		}
	}
}

func creditStreamCompensation(ctx context.Context, id int64) error {
	err := model.CreditStreamCompensation(ctx, id, 0, false)
	if errors.Is(err, model.ErrWalletQuotaLimitExceeded) {
		return model.DB.WithContext(ctx).Model(&model.StreamCompensation{}).Where("id = ? AND status IN ?", id, []string{"pending", "failed"}).Updates(map[string]any{"status": "failed", "note": "wallet_limit"}).Error
	}
	return err
}
