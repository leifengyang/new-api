package controller

import (
	"fmt"
	"testing"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/stretchr/testify/assert"
)

func TestExtractDegradationWatchHtml(t *testing.T) {
	for _, tc := range []struct {
		name   string
		text   string
		html   string
		reason string
	}{
		{"empty", "  \n", "", degradationWatchReasonEmpty},
		{"no html", "抱歉，我无法完成。", "", degradationWatchReasonNoHtml},
		{"html without svg", "<!doctype html><html><canvas></canvas></html>", "", degradationWatchReasonNoSvg},
		{
			"fenced with commentary",
			"好的：\n```html\n<!DOCTYPE html><html><body><svg viewBox=\"0 0 16 10\"></svg></body></html>\n```\n说明",
			"<!DOCTYPE html><html><body><svg viewBox=\"0 0 16 10\"></svg></body></html>",
			"",
		},
		{"no doctype", "<html><svg/></html>", "<html><svg/></html>", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			html, reason := extractDegradationWatchHtml(tc.text)
			assert.Equal(t, tc.html, html)
			assert.Equal(t, tc.reason, reason)
		})
	}
}

func TestCollectDegradationWatchStreamText(t *testing.T) {
	chat := []byte("data: {\"choices\":[{\"delta\":{\"content\":\"<html>\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"</html>\"}}]}\n\ndata: [DONE]\n")
	assert.Equal(t, "<html></html>", collectDegradationWatchStreamText(chat))

	responses := []byte("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"<svg>\"}\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"content\":[{\"type\":\"output_text\",\"text\":\"<svg>\"}]}]}}\n")
	assert.Equal(t, "<svg>", collectDegradationWatchStreamText(responses))

	completedOnly := []byte("data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"reasoning\"},{\"content\":[{\"type\":\"output_text\",\"text\":\"<svg>\"}]}]}}\n")
	assert.Equal(t, "<svg>", collectDegradationWatchStreamText(completedOnly))
}

func TestDegradationWatchRecordItemMasksUpstreamErrorsForUsers(t *testing.T) {
	aliases := map[string]string{"7": "Alpha"}
	upstream := &model.DegradationWatchRecord{ChannelId: 7, FailureReason: "upstream error: dial tcp 10.0.0.8:443: timeout"}
	assert.Equal(t, degradationWatchReasonUpstream, toDegradationWatchRecordItem(upstream, false, aliases).FailureReason)
	assert.Equal(t, upstream.FailureReason, toDegradationWatchRecordItem(upstream, true, aliases).FailureReason)

	coded := &model.DegradationWatchRecord{ChannelId: 7, FailureReason: degradationWatchReasonNoSvg}
	assert.Equal(t, degradationWatchReasonNoSvg, toDegradationWatchRecordItem(coded, false, aliases).FailureReason)
}

func TestDegradationWatchRecordItemHidesChannelIdFromUsers(t *testing.T) {
	aliases := map[string]string{"7": "Alpha"}
	record := &model.DegradationWatchRecord{ChannelId: 7}

	user := toDegradationWatchRecordItem(record, false, aliases)
	assert.Equal(t, "Alpha", user.ChannelTitle)
	assert.True(t, user.Aliased)
	assert.Zero(t, user.ChannelId, "users must never receive channel ids")

	admin := toDegradationWatchRecordItem(record, true, aliases)
	assert.Equal(t, "Alpha", admin.ChannelTitle)
	assert.Equal(t, 7, admin.ChannelId)
}

func TestIsDegradationWatchCandidate(t *testing.T) {
	channel := &model.Channel{Status: 1, Group: "default,GPT-企业", Models: "gpt-5, gpt-6-astra"}
	assert.True(t, isDegradationWatchCandidate(channel, "GPT-企业", "gpt-6-astra"))
	assert.False(t, isDegradationWatchCandidate(channel, "GPT-企业", "gpt-6"))
	assert.False(t, isDegradationWatchCandidate(channel, "vip", "gpt-6-astra"))
	channel.Status = 3
	assert.False(t, isDegradationWatchCandidate(channel, "GPT-企业", "gpt-6-astra"))
}

func TestSelectDegradationWatchJobsRespectsTargetAndChannelFilters(t *testing.T) {
	channels := []*model.Channel{
		{Id: 1, Status: 1, Group: "vip", Models: "sol,luna"},
		{Id: 2, Status: 1, Group: "vip", Models: "sol"},
	}
	targets := []operation_setting.DegradationWatchTarget{
		{Model: "sol", Group: "vip", Enabled: true},
		{Model: "luna", Group: "vip", Enabled: false},
	}
	describe := func(jobs []degradationWatchJob) []string {
		out := make([]string, 0, len(jobs))
		for _, job := range jobs {
			out = append(out, fmt.Sprintf("%s@%d", job.target.Model, job.channel.Id))
		}
		return out
	}

	assert.Equal(t, []string{"sol@1", "sol@2"}, describe(selectDegradationWatchJobs(channels, targets, degradationWatchTaskPayload{})), "scheduled rounds skip disabled targets")
	assert.Equal(t, []string{"luna@1"}, describe(selectDegradationWatchJobs(channels, targets, degradationWatchTaskPayload{Model: "luna"})), "a named target runs even when disabled")
	assert.Equal(t, []string{"sol@2"}, describe(selectDegradationWatchJobs(channels, targets, degradationWatchTaskPayload{Model: "sol", ChannelId: 2})))
	assert.Empty(t, selectDegradationWatchJobs(channels, targets, degradationWatchTaskPayload{Model: "luna", ChannelId: 2}))
}

func TestGroupDegradationWatchRoundsSplitsByRunId(t *testing.T) {
	records := []*model.DegradationWatchRecord{
		{Id: 6, RunId: "b", ChannelId: 1, ModelName: "sol", CreatedAt: 2000},
		{Id: 5, RunId: "b", ChannelId: 1, ModelName: "luna", CreatedAt: 1990},
		{Id: 4, RunId: "a", ChannelId: 1, ModelName: "sol", CreatedAt: 1000},
	}

	rounds := groupDegradationWatchRounds(records)

	assert.Len(t, rounds, 2)
	assert.Equal(t, "b", rounds[0].Key)
	assert.EqualValues(t, 1990, rounds[0].StartedAt)
	assert.Equal(t, 5, rounds[0].minId)
	assert.Len(t, rounds[0].records, 2)
	assert.Equal(t, "a", rounds[1].Key)
}

func TestGroupDegradationWatchRoundsSplitsLegacyRecordsByGapAndRepeatedSeries(t *testing.T) {
	records := []*model.DegradationWatchRecord{
		{Id: 9, ChannelId: 1, ModelName: "sol", CreatedAt: 5000},
		{Id: 8, ChannelId: 2, ModelName: "sol", CreatedAt: 4990},
		{Id: 7, ChannelId: 1, ModelName: "sol", CreatedAt: 4980},
		{Id: 6, ChannelId: 2, ModelName: "sol", CreatedAt: 4000},
	}

	rounds := groupDegradationWatchRounds(records)

	assert.Len(t, rounds, 3)
	assert.Equal(t, "legacy-8", rounds[0].Key, "a repeated channel+model starts a new round")
	assert.Equal(t, "legacy-7", rounds[1].Key)
	assert.Equal(t, "legacy-6", rounds[2].Key, "a gap longer than the legacy window starts a new round")
}
