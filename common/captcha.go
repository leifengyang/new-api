package common

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/dchest/captcha"
	"github.com/go-redis/redis/v8"
)

const (
	ImageCaptchaTTL       = 5 * time.Minute
	imageCaptchaKeyPrefix = "auth:image-captcha:"
	imageCaptchaCapacity  = 10000
)

// GET and DEL must be atomic, including for wrong answers. Lua also supports
// Redis versions predating GETDEL. Never log challenges through Redis helpers.
const consumeImageCaptchaScript = `
local value = redis.call('GET', KEYS[1])
redis.call('DEL', KEYS[1])
return value
`

type imageCaptchaEntry struct {
	value     string
	expiresAt time.Time
}

var imageCaptchaStore = struct {
	sync.Mutex
	entries map[string]imageCaptchaEntry
}{entries: make(map[string]imageCaptchaEntry)}

// CreateImageCaptcha renders a PNG without text metadata or an exposed answer.
// Redis shares challenges across nodes; memory storage is for single-node use.
func CreateImageCaptcha(ctx context.Context, purpose string) (id string, image string, err error) {
	if purpose != "login" && purpose != "register" {
		return "", "", errors.New("invalid captcha purpose")
	}
	var token [24]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", "", err
	}
	id = base64.RawURLEncoding.EncodeToString(token[:])
	digits := make([]byte, 6)
	answer := make([]byte, len(digits))
	for i := range digits {
		n, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", "", err
		}
		digits[i] = byte(n.Int64())
		answer[i] = '0' + digits[i]
	}
	var png bytes.Buffer
	if _, err := captcha.NewImage(id, digits, 180, 60).WriteTo(&png); err != nil {
		return "", "", err
	}
	value := purpose + ":" + string(answer)
	if RedisEnabled {
		if RDB == nil {
			return "", "", errors.New("captcha store unavailable")
		}
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if err := RDB.Set(ctx, imageCaptchaKeyPrefix+id, value, ImageCaptchaTTL).Err(); err != nil {
			return "", "", err
		}
	} else {
		imageCaptchaStore.Lock()
		defer imageCaptchaStore.Unlock()
		now := time.Now()
		for key, entry := range imageCaptchaStore.entries {
			if !now.Before(entry.expiresAt) {
				delete(imageCaptchaStore.entries, key)
			}
		}
		if len(imageCaptchaStore.entries) >= imageCaptchaCapacity {
			return "", "", errors.New("captcha store full")
		}
		imageCaptchaStore.entries[id] = imageCaptchaEntry{value: value, expiresAt: now.Add(ImageCaptchaTTL)}
	}
	return id, "data:image/png;base64," + base64.StdEncoding.EncodeToString(png.Bytes()), nil
}

// VerifyImageCaptcha consumes a challenge ID on its first attempt, including
// empty/wrong answers or use for the wrong authentication action.
// A configured but unavailable Redis never falls back to per-node memory.
func VerifyImageCaptcha(ctx context.Context, purpose, id, answer string) (bool, error) {
	if len(id) != 32 {
		return false, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil || len(decoded) != 24 {
		return false, nil
	}
	var value string
	if RedisEnabled {
		if RDB == nil {
			return false, errors.New("captcha store unavailable")
		}
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		value, err = RDB.Eval(ctx, consumeImageCaptchaScript, []string{imageCaptchaKeyPrefix + id}).Text()
		if errors.Is(err, redis.Nil) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
	} else {
		imageCaptchaStore.Lock()
		entry, ok := imageCaptchaStore.entries[id]
		delete(imageCaptchaStore.entries, id)
		imageCaptchaStore.Unlock()
		if !ok || !time.Now().Before(entry.expiresAt) {
			return false, nil
		}
		value = entry.value
	}
	answer = strings.TrimSpace(answer)
	if len(answer) != 6 || (purpose != "login" && purpose != "register") {
		return false, nil
	}
	return subtle.ConstantTimeCompare([]byte(value), []byte(purpose+":"+answer)) == 1, nil
}
