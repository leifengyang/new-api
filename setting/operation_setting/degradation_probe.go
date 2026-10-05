package operation_setting

import (
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

const DegradationProbePlanKey = DegradationWatchConfigName + ".probe_plan"

const SanaeProbePrompt = `仅依据你已有的知识，直接给出你明确知道的最近一任日本首相姓名。不联网、不调用工具、不猜测，不要求确认其截至今天是否仍在任。如果姓名不确定，只输出“uncertain”。不添加任何解释或免责声明。`

type DegradationProbe struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	Prompt          string `json:"prompt"`
	Expected        string `json:"expected"`
	Match           string `json:"match"`
	IntervalMinutes int    `json:"interval_minutes"`
}

type DegradationProbeBinding struct {
	ProbeID string `json:"probe_id"`
	Enabled bool   `json:"enabled"`
	// Zero inherits the probe's default interval.
	IntervalMinutes int `json:"interval_minutes"`
}

type DegradationProbeTarget struct {
	Group           string                    `json:"group"`
	ChannelID       int                       `json:"channel_id"`
	Model           string                    `json:"model"`
	ReasoningEffort string                    `json:"reasoning_effort"`
	Enabled         bool                      `json:"enabled"`
	Public          bool                      `json:"public"`
	Probes          []DegradationProbeBinding `json:"probes"`
}

type DegradationProbePlan struct {
	Enabled        bool                     `json:"enabled"`
	Concurrency    int                      `json:"concurrency"`
	TimeoutSeconds int                      `json:"timeout_seconds"`
	Probes         []DegradationProbe       `json:"probes"`
	Targets        []DegradationProbeTarget `json:"targets"`
}

func ParseDegradationProbePlan(raw string) (*DegradationProbePlan, error) {
	var plan DegradationProbePlan
	if err := common.UnmarshalJsonStr(raw, &plan); err != nil {
		return nil, fmt.Errorf("invalid probe plan: %w", err)
	}
	if plan.Probes == nil {
		plan.Probes = []DegradationProbe{}
	}
	if plan.Targets == nil {
		plan.Targets = []DegradationProbeTarget{}
	}
	for i := range plan.Targets {
		if plan.Targets[i].Probes == nil {
			plan.Targets[i].Probes = []DegradationProbeBinding{}
		}
	}
	if !IsValidDegradationWatchConcurrency(plan.Concurrency) || !IsValidDegradationWatchTimeoutSeconds(plan.TimeoutSeconds) {
		return nil, fmt.Errorf("invalid concurrency or timeout")
	}
	if len(plan.Probes) > 20 || len(plan.Targets) > 200 {
		return nil, fmt.Errorf("at most 20 probes and 200 targets are allowed")
	}
	probes := map[string]bool{}
	for _, probe := range plan.Probes {
		if strings.TrimSpace(probe.ID) == "" || len(probe.ID) > 64 || probes[probe.ID] || strings.TrimSpace(probe.Name) == "" || len([]rune(probe.Name)) > 100 {
			return nil, fmt.Errorf("invalid or duplicate probe")
		}
		probes[probe.ID] = true
		if strings.TrimSpace(probe.Prompt) == "" || len([]rune(probe.Prompt)) > MaxDegradationWatchPromptLength || !IsValidDegradationWatchIntervalMinutes(probe.IntervalMinutes) {
			return nil, fmt.Errorf("invalid prompt or interval: %s", probe.Name)
		}
		if probe.Kind != "text" && probe.Kind != "drawing" {
			return nil, fmt.Errorf("invalid probe kind")
		}
		if probe.Kind == "text" && (strings.TrimSpace(probe.Expected) == "" || len([]rune(probe.Expected)) > 2000 || (probe.Match != "exact" && probe.Match != "contains")) {
			return nil, fmt.Errorf("invalid answer matching rule")
		}
	}
	targets, public := map[string]bool{}, map[string]bool{}
	for _, target := range plan.Targets {
		key := fmt.Sprintf("%s\x00%s", target.Group, target.Model)
		identity := fmt.Sprintf("%s\x00%d", key, target.ChannelID)
		if strings.TrimSpace(target.Group) == "" || len(target.Group) > 128 || strings.TrimSpace(target.Model) == "" || len(target.Model) > 128 || target.ChannelID <= 0 || targets[identity] || len(target.ReasoningEffort) > 32 {
			return nil, fmt.Errorf("invalid or duplicate target")
		}
		targets[identity] = true
		if target.Public && public[key] {
			return nil, fmt.Errorf("only one public channel per group and model is allowed")
		}
		public[key] = public[key] || target.Public
		seen := map[string]bool{}
		for _, binding := range target.Probes {
			if !probes[binding.ProbeID] || seen[binding.ProbeID] || (binding.IntervalMinutes != 0 && !IsValidDegradationWatchIntervalMinutes(binding.IntervalMinutes)) {
				return nil, fmt.Errorf("invalid probe binding")
			}
			seen[binding.ProbeID] = true
		}
	}
	return &plan, nil
}
