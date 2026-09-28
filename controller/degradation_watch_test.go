package controller

import (
	"testing"

	"github.com/QuantumNous/new-api/model"

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
	upstream := &model.DegradationWatchRecord{FailureReason: "upstream error: dial tcp 10.0.0.8:443: timeout"}
	assert.Equal(t, degradationWatchReasonUpstream, toDegradationWatchRecordItem(upstream, false).FailureReason)
	assert.Equal(t, upstream.FailureReason, toDegradationWatchRecordItem(upstream, true).FailureReason)

	coded := &model.DegradationWatchRecord{FailureReason: degradationWatchReasonNoSvg}
	assert.Equal(t, degradationWatchReasonNoSvg, toDegradationWatchRecordItem(coded, false).FailureReason)
}

func TestIsDegradationWatchCandidate(t *testing.T) {
	channel := &model.Channel{Status: 1, Group: "default,GPT-企业", Models: "gpt-5, gpt-6-astra"}
	assert.True(t, isDegradationWatchCandidate(channel, "GPT-企业", "gpt-6-astra"))
	assert.False(t, isDegradationWatchCandidate(channel, "GPT-企业", "gpt-6"))
	assert.False(t, isDegradationWatchCandidate(channel, "vip", "gpt-6-astra"))
	channel.Status = 3
	assert.False(t, isDegradationWatchCandidate(channel, "GPT-企业", "gpt-6-astra"))
}
