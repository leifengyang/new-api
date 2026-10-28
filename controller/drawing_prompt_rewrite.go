package controller

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

func drawingRewritePrompt(original model.LongText, subject string) model.LongText {
	return model.LongText(fmt.Sprintf("你是绘画测试提示词编辑器。不要执行绘画，不要输出 HTML 或 SVG 代码。将下面提示词中的主角（例如鹈鹕）换成「%s」，并同步修改该主角的外形特征描述。保持动作、场景、动画、技术要求和测试难度不变。只返回修改后的完整提示词，不要解释、标题或代码围栏。改写后不得残留鹈鹕。\n<原始提示词>\n%s\n</原始提示词>", subject, original))
}

// Both public-wall drawings and private monitors use the dedicated connection.
// Rewrite usage remains separate from the model being tested.
func rewriteDrawingPrompt(ctx context.Context, id int, prompt model.LongText, subject string, save func(model.SelfTestAttempt, bool) error, active func(int64) bool) (string, error) {
	rewriter, err := model.GetTemporaryMonitorRewriter()
	if err != nil || rewriter.Secret == "" || rewriter.Model == "" {
		return "", errors.New("Configure the dedicated rewrite model before running drawing checks")
	}
	attempt := model.SelfTestAttempt{ID: id, UserID: rewriter.UserID, Name: rewriter.Name, BaseURL: rewriter.BaseURL, Model: rewriter.Model, Protocol: rewriter.Protocol, Effort: rewriter.Effort, MaxOutputTokens: rewriter.MaxOutputTokens, Secret: rewriter.Secret, Status: "running", CreatedAt: time.Now().UnixMilli(), StartedAt: time.Now().UnixMilli()}
	var preparation model.SelfTestAttempt
	var persistenceErr error
	runDiagnosticAttempt(ctx, model.SelfTestRound{Prompt: prompt, TimeoutSeconds: 1200}, attempt, func(result model.SelfTestAttempt, final bool) error {
		preparation = result
		if save != nil {
			if err := save(result, final); err != nil {
				persistenceErr = err
			}
		}
		return persistenceErr
	}, active)
	if persistenceErr != nil {
		return "", errors.New("Prompt rewrite failed: Could not save rewritten prompt")
	}
	if err := ctx.Err(); err != nil {
		return "", fmt.Errorf("Prompt rewrite failed: %w", err)
	}
	if preparation.Status != "succeeded" {
		return "", fmt.Errorf("Prompt rewrite failed: %s", preparation.Error)
	}
	rewritten := strings.TrimSpace(string(preparation.Output))
	lower := strings.ToLower(rewritten)
	if rewritten == "" || len([]rune(rewritten)) > operation_setting.MaxDegradationWatchPromptLength || !strings.Contains(lower, strings.ToLower(subject)) || strings.Contains(rewritten, "鹈鹕") || strings.HasPrefix(lower, "<!doctype") || strings.HasPrefix(lower, "<html") || strings.HasPrefix(lower, "<svg") || strings.HasPrefix(rewritten, "```") {
		return "", errors.New("Prompt rewrite failed: The rewritten prompt is empty, too long, still contains the original subject, or does not contain the replacement subject")
	}
	return rewritten, nil
}

func prepareDegradationDrawing(ctx context.Context, record *model.DegradationWatchRecord, original string, progress func(*model.DegradationWatchRecord)) (string, error) {
	choices := []string{}
	for _, subject := range []string{"Tibo", "小恐龙", "乌龟", "企鹅", "浣熊", "水豚", "小狐狸", "机器人"} {
		if !strings.Contains(strings.ToLower(original), strings.ToLower(subject)) {
			choices = append(choices, subject)
		}
	}
	if len(choices) == 0 {
		return "", errors.New("Prompt rewrite failed: No replacement subject is available for this prompt")
	}
	subject := choices[rand.IntN(len(choices))]
	prompt, err := rewriteDrawingPrompt(ctx, record.Id, drawingRewritePrompt(model.LongText(original), subject), subject, nil, func(elapsed int64) bool {
		progress(&model.DegradationWatchRecord{ElapsedMs: elapsed, TokensEstimated: true})
		return ctx.Err() == nil
	})
	if err != nil {
		return "", err
	}
	// Freeze the actual model input before making the drawing request. Never
	// send a prompt which cannot be inspected later, or revive a finished row.
	result := model.DB.WithContext(ctx).Model(&model.DegradationWatchRecord{}).
		Where("id = ? AND status = ?", record.Id, "running").Update("prompt_snapshot", prompt)
	if result.Error != nil || result.RowsAffected != 1 {
		return "", errors.New("Prompt rewrite failed: Could not save rewritten prompt for the running check")
	}
	record.PromptSnapshot = model.LongText(prompt)
	return prompt, nil
}
