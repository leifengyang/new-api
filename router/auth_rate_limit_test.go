package router

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The process-wide memory limiter outlives a test, including go test -count.
var authRateLimitTestClient atomic.Uint64

func TestLoginRateLimitIsolatedFromSessionTraffic(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oldRedis, oldRDB := common.RedisEnabled, common.RDB
	oldEnabled, oldNum, oldDuration := common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration
	oldGlobal, oldSecure := common.GlobalApiRateLimitEnable, common.SessionCookieSecure
	t.Cleanup(func() {
		common.RedisEnabled, common.RDB = oldRedis, oldRDB
		common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = oldEnabled, oldNum, oldDuration
		common.GlobalApiRateLimitEnable, common.SessionCookieSecure = oldGlobal, oldSecure
	})
	common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = true, 2, 1200
	common.GlobalApiRateLimitEnable, common.SessionCookieSecure = false, true
	t.Setenv("AUTH_SESSION_RATE_LIMIT", "3")
	t.Setenv("AUTH_SESSION_RATE_LIMIT_DURATION", "60")

	for _, backend := range []string{"memory", "redis"} {
		t.Run(backend, func(t *testing.T) {
			common.RedisEnabled = backend == "redis"
			if common.RedisEnabled {
				server := miniredis.RunT(t)
				client := redis.NewClient(&redis.Options{Addr: server.Addr()})
				common.RDB = client
				t.Cleanup(func() { require.NoError(t, client.Close()) })
			}
			engine := gin.New()
			require.NoError(t, engine.SetTrustedProxies(nil))
			SetApiRouter(engine)
			remoteAddr := fmt.Sprintf("[2001:db8::%x]:1234", authRateLimitTestClient.Add(1))
			request := func(path string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(http.MethodPost, "http://example.com"+path, strings.NewReader("{}"))
				r.RemoteAddr = remoteAddr
				r.Header.Set("Origin", "http://example.com")
				r.Header.Set("Content-Type", "application/json")
				response := httptest.NewRecorder()
				engine.ServeHTTP(response, r)
				return response
			}

			// A failed session lookup must not spend a password-login attempt.
			for range 3 {
				require.Equal(t, http.StatusUnauthorized, request("/api/user/auth/refresh").Code)
			}
			limitedRefresh := request("/api/user/auth/refresh")
			require.Equal(t, http.StatusTooManyRequests, limitedRefresh.Code)
			assert.Equal(t, "60", limitedRefresh.Header().Get("Retry-After"))
			assert.Equal(t, http.StatusOK, request("/api/user/auth/logout").Code)
			for range 2 {
				require.Equal(t, http.StatusOK, request("/api/user/register").Code)
			}
			require.Equal(t, http.StatusTooManyRequests, request("/api/user/register").Code)

			// Invalid credentials still spend login attempts, and aliases cannot bypass them.
			for range 2 {
				response := request("/api/user/login")
				require.Equal(t, http.StatusOK, response.Code)
				assert.Contains(t, response.Body.String(), `"success":false`)
			}
			for _, path := range []string{"/api/user/login", "/api/user/login/2fa", "/api/user/login/verify", "/api/user/login/passkey/begin", "/api/user/login/passkey/finish", "/api/user/passkey/login/begin", "/api/user/passkey/login/finish"} {
				response := request(path)
				require.Equal(t, http.StatusTooManyRequests, response.Code, path)
				assert.Equal(t, "1200", response.Header().Get("Retry-After"))
				assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
				var body struct {
					Success bool   `json:"success"`
					Message string `json:"message"`
					Params  struct {
						Seconds int `json:"seconds"`
					} `json:"message_params"`
				}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
				assert.False(t, body.Success)
				assert.Contains(t, body.Message, "1200")
				assert.Equal(t, 1200, body.Params.Seconds)
			}
		})
	}
}
