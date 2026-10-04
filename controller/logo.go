package controller

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"strings"

	_ "golang.org/x/image/webp"
)

const maxLogoImageBytes = 256 * 1024

// Uploaded logos use the existing Logo option, so they survive restarts and
// work on every node without a separate local upload volume.
func validateLogoImage(value string) error {
	if !strings.HasPrefix(strings.ToLower(value), "data:") {
		return nil
	}
	header, encoded, ok := strings.Cut(value, ",")
	formats := map[string]string{
		"data:image/png;base64": "png", "data:image/jpeg;base64": "jpeg",
		"data:image/gif;base64": "gif", "data:image/webp;base64": "webp",
	}
	expected, supported := formats[header]
	if !ok || !supported || len(encoded) > base64.StdEncoding.EncodedLen(maxLogoImageBytes) {
		return errors.New("choose a PNG, JPEG, WebP or GIF logo up to 256 KB")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > maxLogoImageBytes {
		return errors.New("invalid logo image data")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != expected {
		return errors.New("logo content does not match its image type")
	}
	if config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 {
		return errors.New("logo dimensions must not exceed 4096 pixels per side")
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return errors.New("invalid or incomplete logo image")
	}
	return nil
}
