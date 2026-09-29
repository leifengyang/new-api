package operation_setting

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func withDegradationWatchSetting(t *testing.T, setting DegradationWatchSetting) {
	t.Helper()
	original := degradationWatchSetting
	degradationWatchSetting = setting
	t.Cleanup(func() { degradationWatchSetting = original })
}

func TestResolveDegradationWatchTargetsFallsBackToLegacyFieldsWhenEmpty(t *testing.T) {
	withDegradationWatchSetting(t, DegradationWatchSetting{Group: "vip", Model: "gpt-6-astra", ReasoningEffort: "high"})

	targets := ResolveDegradationWatchTargets()

	assert.Equal(t, []DegradationWatchTarget{{Model: "gpt-6-astra", Group: "vip", ReasoningEffort: "high", Enabled: true}}, targets)
}

func TestResolveDegradationWatchTargetsTrimsAndDropsDuplicates(t *testing.T) {
	withDegradationWatchSetting(t, DegradationWatchSetting{Targets: []DegradationWatchTarget{
		{Model: " sol ", Group: " ", Enabled: true},
		{Model: "", Group: "vip", Enabled: true},
		{Model: "sol", Group: "vip", Enabled: false},
		{Model: "luna", Group: "vip", ReasoningEffort: "low"},
	}})

	targets := ResolveDegradationWatchTargets()

	assert.Equal(t, []DegradationWatchTarget{
		{Model: "sol", Group: DegradationWatchDefaultGroup, Enabled: true},
		{Model: "luna", Group: "vip", ReasoningEffort: "low"},
	}, targets)
}

func TestValidateDegradationWatchTargetsRejectsBadInput(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		ok   bool
	}{
		{"empty list", "[]", true},
		{"valid", `[{"model":"sol","group":"vip","enabled":true}]`, true},
		{"not an array", `{"model":"sol"}`, false},
		{"empty model", `[{"model":"  "}]`, false},
		{"duplicate model", `[{"model":"sol"},{"model":" sol"}]`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateDegradationWatchTargets(tc.raw)
			if tc.ok {
				assert.NoError(t, err)
			} else {
				assert.Error(t, err)
			}
		})
	}
}
