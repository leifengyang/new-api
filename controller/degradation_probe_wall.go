package controller

import (
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
)

type degradationProbeLane struct {
	Group       string `json:"group"`
	Model       string `json:"model"`
	ChannelID   int    `json:"channel_id,omitempty"`
	ChannelName string `json:"channel_name,omitempty"`
	Enabled     bool   `json:"enabled"`
	Public      bool   `json:"public,omitempty"`
}

type degradationProbeHistory struct {
	ID              string                       `json:"id"`
	Name            string                       `json:"name"`
	Kind            string                       `json:"kind"`
	Enabled         bool                         `json:"enabled"`
	IntervalMinutes int                          `json:"interval_minutes"`
	Stats           model.DegradationProbeStats  `json:"stats"`
	Records         []degradationWatchRecordItem `json:"records"`
	NextBefore      int                          `json:"next_before"`
	Artwork         *degradationWatchRecordItem  `json:"artwork,omitempty"`
}

func GetDegradationProbeWall(c *gin.Context) {
	if c.Query("model") == "" {
		if err := model.FailInterruptedDegradationWatchRecords(); err != nil {
			common.ApiError(c, err)
			return
		}
	}
	plan, err := resolveDegradationProbePlan()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	admin := isDegradationWatchAdmin(c)
	titles := map[int]string{}
	if admin && c.Query("model") == "" {
		channels, err := model.GetAllChannels(0, 0, true, true)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		for _, channel := range channels {
			titles[channel.Id] = channel.Name
		}
	}
	channelID, _ := strconv.Atoi(c.Query("channel_id"))
	lanes := []degradationProbeLane{}
	var selected *operation_setting.DegradationProbeTarget
	for _, target := range plan.Targets {
		if !admin && !target.Public {
			continue
		}
		lane := degradationProbeLane{Group: target.Group, Model: target.Model, Enabled: plan.Enabled && target.Enabled}
		if admin {
			lane.ChannelID, lane.Public = target.ChannelID, target.Public
			lane.ChannelName = titles[target.ChannelID]
		}
		lanes = append(lanes, lane)
		if c.Query("group") == target.Group && c.Query("model") == target.Model && (!admin || channelID == target.ChannelID) {
			copy := target
			selected = &copy
		}
	}
	since := common.GetTimestamp() - 24*60*60
	if c.Query("days") == "7" {
		since = common.GetTimestamp() - model.DegradationWatchRetentionSeconds
	}
	if c.Query("model") == "" {
		common.ApiSuccess(c, gin.H{"enabled": plan.Enabled, "lanes": lanes, "since": since})
		return
	}
	if selected == nil {
		c.JSON(404, gin.H{"success": false, "message": "record not found"})
		return
	}
	if admin {
		if channel, err := model.GetChannelById(selected.ChannelID, false); err == nil {
			titles[channel.Id] = channel.Name
		}
	}
	before, _ := strconv.Atoi(c.Query("before"))
	rows := []degradationProbeHistory{}
	const pageSize = 300
	for _, probe := range plan.Probes {
		for _, binding := range selected.Probes {
			if binding.ProbeID != probe.ID || (c.Query("probe_id") != "" && c.Query("probe_id") != probe.ID) {
				continue
			}
			records, stats, art, err := model.GetDegradationProbeHistory(probeSeries(*selected, probe), since, max(before, 0), pageSize+1, admin)
			if err != nil {
				common.ApiError(c, err)
				return
			}
			row := degradationProbeHistory{ID: probe.ID, Name: probe.Name, Kind: probe.Kind, Enabled: plan.Enabled && selected.Enabled && binding.Enabled, IntervalMinutes: probe.IntervalMinutes, Stats: stats, Records: []degradationWatchRecordItem{}}
			if binding.IntervalMinutes > 0 {
				row.IntervalMinutes = binding.IntervalMinutes
			}
			if len(records) > pageSize {
				records = records[:pageSize]
				row.NextBefore = records[len(records)-1].Id
			}
			for _, record := range records {
				item := toDegradationWatchRecordItem(record, admin, nil, titles)
				item.GroupName, item.ProbeID, item.ProbeName, item.ProbeKind = selected.Group, probe.ID, probe.Name, probe.Kind
				row.Records = append(row.Records, item)
			}
			if art != nil {
				item := toDegradationWatchRecordItem(art, admin, nil, titles)
				item.GroupName, item.ProbeKind = selected.Group, "drawing"
				row.Artwork = &item
			}
			rows = append(rows, row)
		}
	}
	common.ApiSuccess(c, gin.H{"probes": rows, "since": since})
}
