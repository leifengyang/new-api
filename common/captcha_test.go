package common

import (
	"bytes"
	"context"
	"encoding/base64"
	"image/png"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupImageCaptchaTest(t *testing.T, useRedis bool) *miniredis.Miniredis {
	t.Helper()
	previousEnabled, previousClient := RedisEnabled, RDB
	RedisEnabled, RDB = useRedis, nil
	imageCaptchaStore.Lock()
	previousEntries := imageCaptchaStore.entries
	imageCaptchaStore.entries = make(map[string]imageCaptchaEntry)
	imageCaptchaStore.Unlock()
	t.Cleanup(func() {
		RedisEnabled, RDB = previousEnabled, previousClient
		imageCaptchaStore.Lock()
		imageCaptchaStore.entries = previousEntries
		imageCaptchaStore.Unlock()
	})
	if !useRedis {
		return nil
	}
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr(), MaxRetries: -1})
	RDB = client
	t.Cleanup(func() { require.NoError(t, client.Close()) })
	return server
}

func TestImageCaptchaChallengeLifecycle(t *testing.T) {
	for _, backend := range []string{"memory", "redis"} {
		t.Run(backend, func(t *testing.T) {
			server := setupImageCaptchaTest(t, backend == "redis")
			for _, test := range []struct {
				name, purpose, answer string
				expired, valid        bool
			}{
				{name: "correct", purpose: "login", answer: "123456", valid: true},
				{name: "wrong", purpose: "login", answer: "654321"},
				{name: "empty", purpose: "login"},
				{name: "wrong purpose", purpose: "register", answer: "123456"},
				{name: "expired", purpose: "login", answer: "123456", expired: true},
			} {
				t.Run(test.name, func(t *testing.T) {
					id, data, err := CreateImageCaptcha(context.Background(), "login")
					require.NoError(t, err)
					raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(data, "data:image/png;base64,"))
					require.NoError(t, err)
					img, err := png.Decode(bytes.NewReader(raw))
					require.NoError(t, err)
					assert.Equal(t, 180, img.Bounds().Dx())
					assert.Equal(t, 60, img.Bounds().Dy())
					if server != nil {
						server.Set(imageCaptchaKeyPrefix+id, "login:123456")
						server.SetTTL(imageCaptchaKeyPrefix+id, ImageCaptchaTTL)
						if test.expired {
							server.FastForward(ImageCaptchaTTL)
						}
					} else {
						expiry := time.Now().Add(ImageCaptchaTTL)
						if test.expired {
							expiry = time.Now().Add(-time.Second)
						}
						imageCaptchaStore.entries[id] = imageCaptchaEntry{value: "login:123456", expiresAt: expiry}
					}
					valid, err := VerifyImageCaptcha(context.Background(), test.purpose, id, test.answer)
					require.NoError(t, err)
					assert.Equal(t, test.valid, valid)
					valid, err = VerifyImageCaptcha(context.Background(), "login", id, "123456")
					require.NoError(t, err)
					assert.False(t, valid, "every attempted challenge is single use")
				})
			}
		})
	}
}

func TestImageCaptchaAllowsOnlyOneConcurrentVerification(t *testing.T) {
	for _, backend := range []string{"memory", "redis"} {
		t.Run(backend, func(t *testing.T) {
			server := setupImageCaptchaTest(t, backend == "redis")
			id, _, err := CreateImageCaptcha(context.Background(), "login")
			require.NoError(t, err)
			if server != nil {
				server.Set(imageCaptchaKeyPrefix+id, "login:123456")
			} else {
				imageCaptchaStore.entries[id] = imageCaptchaEntry{value: "login:123456", expiresAt: time.Now().Add(time.Minute)}
			}
			var results [2]bool
			var errs [2]error
			start := make(chan struct{})
			var group sync.WaitGroup
			for i := range 2 {
				group.Go(func() { <-start; results[i], errs[i] = VerifyImageCaptcha(context.Background(), "login", id, "123456") })
			}
			close(start)
			group.Wait()
			require.NoError(t, errs[0])
			require.NoError(t, errs[1])
			assert.NotEqual(t, results[0], results[1], "exactly one request can consume the challenge")
		})
	}
}

func TestImageCaptchaFailsClosedWhenRedisUnavailable(t *testing.T) {
	setupImageCaptchaTest(t, false)
	id, _, err := CreateImageCaptcha(context.Background(), "login")
	require.NoError(t, err)
	RedisEnabled = true
	valid, err := VerifyImageCaptcha(context.Background(), "login", id, "123456")
	require.Error(t, err)
	assert.False(t, valid)
	_, _, err = CreateImageCaptcha(context.Background(), "login")
	require.Error(t, err)
}
