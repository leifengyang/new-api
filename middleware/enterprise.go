package middleware

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"

	"github.com/gin-gonic/gin"
)

// EnterpriseAuth 只放行被平台管理员标记为「企业账号」的普通用户。
//
// 判定只看鉴权链路写进上下文的标记（UserBase.WriteContext 写入），不看请求体、
// 路径参数或任何客户端可控的字段。平台管理员不走这里——他们管用户的入口是管理端，
// 不是某家企业的控制台。
func EnterpriseAuth() func(c *gin.Context) {
	return func(c *gin.Context) {
		if !common.GetContextKeyBool(c, constant.ContextKeyUserIsEnterprise) {
			c.JSON(http.StatusForbidden, gin.H{
				"success": false,
				"message": common.TranslateMessage(c, i18n.MsgAuthInsufficientPrivilege),
			})
			c.Abort()
			return
		}
		c.Next()
	}
}
