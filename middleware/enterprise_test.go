package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

// EnterpriseAuth 的判定只看鉴权链路写进上下文的标记：普通用户、管理员、
// 以及任何客户端可控的输入都不能把它变成通行证。
func TestEnterpriseAuthOnlyAllowsMarkedAccounts(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name    string
		marks   map[constant.ContextKey]any
		allowed bool
	}{
		{name: "没有标记", marks: nil, allowed: false},
		{name: "标记为假", marks: map[constant.ContextKey]any{constant.ContextKeyUserIsEnterprise: false}, allowed: false},
		{name: "标记为真", marks: map[constant.ContextKey]any{constant.ContextKeyUserIsEnterprise: true}, allowed: true},
		// 非布尔值不构成通行证：判定要求上下文里就是一个 true。
		{name: "标记是字符串", marks: map[constant.ContextKey]any{constant.ContextKeyUserIsEnterprise: "true"}, allowed: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reached := false
			router := gin.New()
			router.Use(func(c *gin.Context) {
				for key, value := range tc.marks {
					common.SetContextKey(c, key, value)
				}
				c.Next()
			})
			router.Use(EnterpriseAuth())
			router.GET("/api/enterprise/profile", func(c *gin.Context) {
				reached = true
				c.Status(http.StatusNoContent)
			})

			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/enterprise/profile", nil))

			if tc.allowed {
				assert.Equal(t, http.StatusNoContent, recorder.Code)
				assert.True(t, reached)
				return
			}
			assert.Equal(t, http.StatusForbidden, recorder.Code)
			assert.False(t, reached, "被拦下的请求不能进到 handler")
		})
	}
}
