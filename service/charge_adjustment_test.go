package service

import (
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	hosttypes "github.com/QuantumNous/new-api/types"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func chargeAdjustmentOf(t *testing.T, other *model.LogOther) map[string]any {
	t.Helper()
	snapshot := other.Snapshot()
	adjustment, ok := snapshot["charge_adjustment"].(map[string]any)
	require.True(t, ok, "charge_adjustment should be a public top-level object")
	// A public marker: the log formatter strips admin_info for non-admin
	// viewers, which would defeat the purpose.
	_, hasAdminInfo := snapshot["admin_info"]
	require.False(t, hasAdminInfo, "charge_adjustment must not depend on admin_info")
	return adjustment
}

// TestAttachChargeAdjustmentClampIsPublic verifies a saturated conversion is
// reported to the log owner, not only to admins.
func TestAttachChargeAdjustmentClampIsPublic(t *testing.T) {
	other := model.NewLogOther()
	clamp := &common.QuotaClamp{
		Op:       "QuotaFromDecimal",
		Kind:     common.QuotaClampOverflow,
		Original: 1.8e19,
		Clamped:  common.MaxQuota,
	}

	attachChargeAdjustment(other, clamp, chargeAdjustmentReason{})

	adjustment := chargeAdjustmentOf(t, other)
	require.Equal(t, ChargeAdjustmentClamped, adjustment["kind"])
	require.Equal(t, "QuotaFromDecimal", adjustment["op"])
	require.Equal(t, common.QuotaClampOverflow, adjustment["clamp_kind"])
	require.Equal(t, common.MaxQuota, adjustment["clamped"])
}

// TestAttachChargeAdjustmentPrefersNoBillableUsage verifies the cause that
// actually decided the final charge wins when several apply: an unbillable
// request is charged 0 whatever the conversion did on the way.
func TestAttachChargeAdjustmentPrefersNoBillableUsage(t *testing.T) {
	other := model.NewLogOther()
	clamp := &common.QuotaClamp{Op: "QuotaRound", Kind: common.QuotaClampOverflow, Clamped: common.MaxQuota}

	attachChargeAdjustment(other, clamp, chargeAdjustmentReason{NoBillableUsage: true, MinimumCharge: true})

	adjustment := chargeAdjustmentOf(t, other)
	require.Equal(t, ChargeAdjustmentNoBillableUsage, adjustment["kind"])
	require.NotContains(t, adjustment, "op")
}

func TestAttachChargeAdjustmentMinimumCharge(t *testing.T) {
	other := model.NewLogOther()

	attachChargeAdjustment(other, nil, chargeAdjustmentReason{MinimumCharge: true})

	adjustment := chargeAdjustmentOf(t, other)
	require.Equal(t, ChargeAdjustmentMinimumCharge, adjustment["kind"])
}

// TestAttachChargeAdjustmentNoopWithoutCause verifies the common case leaves
// the log untouched, so old and new logs stay byte-comparable.
func TestAttachChargeAdjustmentNoopWithoutCause(t *testing.T) {
	other := model.NewLogOther()
	other.SetPublic("model_ratio", 1.0)

	attachChargeAdjustment(other, nil, chargeAdjustmentReason{})

	require.NotContains(t, other.Snapshot(), "charge_adjustment")
}

// TestCalculateTextQuotaSummaryUnbillableUsageChargedZero verifies a request
// that carries nothing billable is charged 0 rather than the formula's result.
// The log marker for this case is derived at attach time, not here.
func TestCalculateTextQuotaSummaryUnbillableUsageChargedZero(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())

	relayInfo := &relaycommon.RelayInfo{
		RelayFormat:             types.RelayFormatOpenAI,
		FinalRequestRelayFormat: types.RelayFormatOpenAI,
		OriginModelName:         "gpt-4o",
		StartTime:               time.Now(),
		PriceData: hosttypes.PriceData{
			ModelRatio:      1,
			CompletionRatio: 1,
			GroupRatioInfo:  hosttypes.GroupRatioInfo{GroupRatio: 1},
		},
	}

	summary := calculateTextQuotaSummary(ctx, relayInfo, &dto.Usage{})

	require.Equal(t, 0, summary.Quota)
	require.False(t, summary.hasBillableUsage())
	require.False(t, summary.MinimumChargeApplied)
}

// TestAttachChargeAdjustmentEvaluatesBillabilityAtAttachTime guards the fixed
// -price tiered path: FixedPriceBilling is set by tiered settlement, after the
// formula ran, so a billability decision cached during the formula would mark a
// real charge as unbillable.
func TestAttachChargeAdjustmentEvaluatesBillabilityAtAttachTime(t *testing.T) {
	summary := &textQuotaSummary{FixedPriceBilling: true}
	other := model.NewLogOther()

	attachChargeAdjustment(other, nil, chargeAdjustmentReason{
		NoBillableUsage: !summary.hasBillableUsage(),
	})

	require.NotContains(t, other.Snapshot(), "charge_adjustment")
}

// TestCalculateTextQuotaSummaryFlagsMinimumCharge verifies a billable request
// whose formula rounds below 1 quota is flagged as floored, so the log owner
// does not read the 1-quota charge as the formula's own result.
func TestCalculateTextQuotaSummaryFlagsMinimumCharge(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())

	relayInfo := &relaycommon.RelayInfo{
		RelayFormat:             types.RelayFormatOpenAI,
		FinalRequestRelayFormat: types.RelayFormatOpenAI,
		OriginModelName:         "gpt-4o",
		StartTime:               time.Now(),
		PriceData: hosttypes.PriceData{
			// 1 token at a ratio small enough that the product rounds to 0.
			ModelRatio:      0.0001,
			CompletionRatio: 1,
			GroupRatioInfo:  hosttypes.GroupRatioInfo{GroupRatio: 1},
		},
	}

	summary := calculateTextQuotaSummary(ctx, relayInfo, &dto.Usage{PromptTokens: 1, TotalTokens: 1})

	require.Equal(t, 1, summary.Quota)
	require.True(t, summary.MinimumChargeApplied)
	require.True(t, summary.hasBillableUsage())
}

// TestCalculateTextQuotaSummaryPlainChargeHasNoAdjustment verifies a charge
// that the formula produced outright is not flagged as adjusted.
func TestCalculateTextQuotaSummaryPlainChargeHasNoAdjustment(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())

	relayInfo := &relaycommon.RelayInfo{
		RelayFormat:             types.RelayFormatOpenAI,
		FinalRequestRelayFormat: types.RelayFormatOpenAI,
		OriginModelName:         "gpt-4o",
		StartTime:               time.Now(),
		PriceData: hosttypes.PriceData{
			ModelRatio:      1,
			CompletionRatio: 1,
			GroupRatioInfo:  hosttypes.GroupRatioInfo{GroupRatio: 1},
		},
	}

	summary := calculateTextQuotaSummary(ctx, relayInfo, &dto.Usage{PromptTokens: 1000, TotalTokens: 1000})

	require.Equal(t, 1000, summary.Quota)
	require.False(t, summary.MinimumChargeApplied)
}

// TestPostTextConsumeQuotaRecordsChargeAdjustment runs the real settle path
// against a database and reads the recorded log back, so the marker is proven
// to reach storage rather than only the in-memory other map.
func TestPostTextConsumeQuotaRecordsChargeAdjustment(t *testing.T) {
	for index, tc := range []struct {
		name       string
		usage      *dto.Usage
		modelRatio float64
		wantQuota  int
		wantKind   string
	}{
		{
			name:       "no billable usage",
			usage:      &dto.Usage{},
			modelRatio: 1,
			wantQuota:  0,
			wantKind:   ChargeAdjustmentNoBillableUsage,
		},
		{
			name:       "minimum charge floor",
			usage:      &dto.Usage{PromptTokens: 1, TotalTokens: 1},
			modelRatio: 0.0001,
			wantQuota:  1,
			wantKind:   ChargeAdjustmentMinimumCharge,
		},
		{
			name:       "plain formula result carries no marker",
			usage:      &dto.Usage{PromptTokens: 1000, TotalTokens: 1000},
			modelRatio: 1,
			wantQuota:  1000,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })

			logDB, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			require.NoError(t, err)
			logSQL, err := logDB.DB()
			require.NoError(t, err)
			logSQL.SetMaxOpenConns(1)
			t.Cleanup(func() { require.NoError(t, logSQL.Close()) })

			oldDB, oldLogDB := model.DB, model.LOG_DB
			oldMainType, oldLogType := common.MainDatabaseType(), common.LogDatabaseType()
			model.DB, model.LOG_DB = db, logDB
			common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
			t.Cleanup(func() {
				model.DB, model.LOG_DB = oldDB, oldLogDB
				common.SetDatabaseTypes(oldMainType, oldLogType)
			})

			require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.Channel{}))
			require.NoError(t, logDB.AutoMigrate(&model.Log{}))

			user := model.User{Username: fmt.Sprintf("charge_adjustment_%d", index), Quota: 1_000_000, Status: common.UserStatusEnabled}
			require.NoError(t, db.Create(&user).Error)
			token := model.Token{UserId: user.Id, Key: fmt.Sprintf("charge-adjustment-test-%d", index), Name: "charge-adjustment", RemainQuota: 1_000_000, Status: common.TokenStatusEnabled}
			require.NoError(t, db.Create(&token).Error)
			channel := model.Channel{Name: "charge-adjustment", Key: "unused", Status: common.ChannelStatusEnabled}
			require.NoError(t, db.Create(&channel).Error)

			info := &relaycommon.RelayInfo{
				UserId:          user.Id,
				TokenId:         token.Id,
				TokenKey:        token.Key,
				ChannelMeta:     &relaycommon.ChannelMeta{ChannelId: channel.Id},
				OriginModelName: "charge-adjustment-test",
				UsingGroup:      "default",
				UserGroup:       "default",
				StartTime:       time.Now(),
				RelayFormat:     types.RelayFormatOpenAI,
				PriceData: hosttypes.PriceData{
					ModelRatio:      tc.modelRatio,
					CompletionRatio: 1,
					GroupRatioInfo:  hosttypes.GroupRatioInfo{GroupRatio: 1},
				},
			}
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
			ctx.Set("token_name", token.Name)

			PostTextConsumeQuota(ctx, info, tc.usage, nil)

			var log model.Log
			require.NoError(t, logDB.Where("user_id = ?", user.Id).Take(&log).Error)
			require.Equal(t, tc.wantQuota, log.Quota)

			var other map[string]any
			require.NoError(t, common.UnmarshalJsonStr(log.Other, &other))
			if tc.wantKind == "" {
				require.NotContains(t, other, "charge_adjustment")
				return
			}
			adjustment, ok := other["charge_adjustment"].(map[string]any)
			require.True(t, ok, "charge_adjustment should be recorded on the consume log")
			require.Equal(t, tc.wantKind, adjustment["kind"])
		})
	}
}
