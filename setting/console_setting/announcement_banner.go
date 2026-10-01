package console_setting

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

// AnnouncementBanner is shared by the public homepage and authenticated popup.
type AnnouncementBanner struct {
	ImageURL  string `json:"imageUrl"`
	LinkURL   string `json:"linkUrl"`
	Published bool   `json:"published"`
	Revision  string `json:"revision,omitempty"`
}

func parseAnnouncementBanner(value string) (*AnnouncementBanner, error) {
	if len(value) > 1500000 {
		return nil, fmt.Errorf("公告图片不能超过1MB")
	}
	var banner AnnouncementBanner
	if err := common.UnmarshalJsonStr(value, &banner); err != nil {
		return nil, fmt.Errorf("公告图片配置格式错误")
	}
	if banner.Published && (strings.TrimSpace(banner.Revision) == "" || len(banner.Revision) > 100 || banner.ImageURL == "") {
		return nil, fmt.Errorf("请设置公告图片并确认发布")
	}
	for index, address := range []string{banner.ImageURL, banner.LinkURL} {
		if address == "" {
			continue
		}
		if index == 0 && strings.HasPrefix(address, "data:") {
			metadata, encoded, ok := strings.Cut(address, ",")
			data, err := base64.StdEncoding.DecodeString(encoded)
			if !ok || err != nil || len(data) == 0 || len(data) > 1024*1024 {
				return nil, fmt.Errorf("公告图片格式错误或超过1MB")
			}
			mime := http.DetectContentType(data)
			if (mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" && mime != "image/gif") || metadata != "data:"+mime+";base64" {
				return nil, fmt.Errorf("请上传PNG、JPEG、WebP或GIF图片")
			}
			continue
		}
		parsed, err := url.Parse(address)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" || parsed.User != nil || len(address) > 2048 {
			return nil, fmt.Errorf("公告图片及跳转链接须为有效的HTTP或HTTPS地址")
		}
	}
	return &banner, nil
}

func GetPublishedAnnouncementBanner() *AnnouncementBanner {
	if !GetConsoleSetting().AnnouncementsEnabled {
		return nil
	}
	banner, err := parseAnnouncementBanner(GetConsoleSetting().AnnouncementsBanner)
	if err != nil || !banner.Published {
		return nil
	}
	return banner
}
