package controller

import (
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// CanvasSessionAuth follows UserAuth and excludes personal access tokens: cloud
// canvas data and its provisioned key belong to a live dashboard session.
func CanvasSessionAuth(c *gin.Context) {
	if _, ok := middleware.GetSessionAuthIdentity(c); !ok {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "code": "CANVAS_SESSION_REQUIRED", "message": "Sign in to new-api to open the canvas"})
		return
	}
	c.Next()
}

func BootstrapCanvas(c *gin.Context) {
	provisionCanvasToken(c, false)
}

func ResetCanvasToken(c *gin.Context) {
	provisionCanvasToken(c, true)
}

func provisionCanvasToken(c *gin.Context, replaceDeleted bool) {
	params := model.AuditFields{}
	entry := model.AuditLog{
		UserId: c.GetInt("id"), Username: c.GetString("username"), ActorRole: c.GetInt("role"),
		Category: model.AuditCategorySecurity, Action: "canvas.token_access", Content: "Canvas API key access",
		Other: model.AuditOther{Op: &model.AuditOperation{Action: "canvas.token_access", Params: params}},
	}
	if replaceDeleted {
		entry.Action, entry.Content = "canvas.token_replace", "Canvas deleted API key replacement"
		entry.Other.Op.Action = entry.Action
	}
	defer func() { model.RecordAuditLog(c, entry) }()
	userGroup := c.GetString("group")
	enterpriseLimits := service.EnterpriseGroupLimitsFromContext(c)
	if !service.GroupInUserUsableGroups(userGroup, enterpriseLimits, "auto") {
		writeCanvasError(c, http.StatusForbidden, "CANVAS_AUTO_UNAVAILABLE", model.ErrCanvasAutoUnavailable)
		return
	}
	token, created, err := model.EnsureCanvasToken(c.Request.Context(), c.GetInt("id"), len(service.GetUserAutoGroup(userGroup, enterpriseLimits)) > 0, replaceDeleted)
	if err != nil {
		code := "CANVAS_INTERNAL_ERROR"
		status := http.StatusConflict
		switch {
		case errors.Is(err, model.ErrCanvasTokenDeleted):
			code = "CANVAS_TOKEN_DELETED"
		case errors.Is(err, model.ErrCanvasTokenNotDeleted):
			code = "CANVAS_TOKEN_NOT_DELETED"
		case errors.Is(err, model.ErrCanvasTokenDisabled):
			code = "CANVAS_TOKEN_DISABLED"
		case errors.Is(err, model.ErrCanvasTokenExpired):
			code = "CANVAS_TOKEN_EXPIRED"
		case errors.Is(err, model.ErrCanvasTokenExhausted):
			code = "CANVAS_TOKEN_EXHAUSTED"
		case errors.Is(err, model.ErrCanvasTokenGroup):
			code = "CANVAS_TOKEN_GROUP"
		case errors.Is(err, model.ErrCanvasTokenLimit):
			code = "CANVAS_TOKEN_LIMIT"
		case errors.Is(err, model.ErrCanvasAutoUnavailable):
			code, status = "CANVAS_AUTO_UNAVAILABLE", http.StatusForbidden
		default:
			status = http.StatusInternalServerError
		}
		params["code"] = code
		writeCanvasError(c, status, code, err)
		return
	}
	params["id"], params["created"] = token.Id, created
	autoGroups, err := token.GetAutoGroups()
	if err != nil {
		writeCanvasError(c, http.StatusConflict, "CANVAS_AUTO_UNAVAILABLE", model.ErrCanvasAutoUnavailable)
		return
	}
	if len(autoGroups) == 0 {
		autoGroups = service.GetUserAutoGroup(userGroup, enterpriseLimits)
	} else {
		autoGroups = service.FilterUserTokenAutoGroups(userGroup, enterpriseLimits, autoGroups)
	}
	if len(autoGroups) == 0 {
		writeCanvasError(c, http.StatusForbidden, "CANVAS_AUTO_UNAVAILABLE", model.ErrCanvasAutoUnavailable)
		return
	}
	entry.Success = true
	common.ApiSuccess(c, gin.H{
		"user_id": c.GetInt("id"), "token_id": token.Id,
		"api_key": "sk-" + strings.TrimPrefix(token.Key, "sk-"), "base_url": "/v1",
	})
}

// CanvasStorage implements the upstream storage adapter's opaque key/value
// contract. User identity always comes from the validated dashboard session.
func CanvasStorage(c *gin.Context) {
	collection := c.Param("collection")
	switch collection {
	case "projects", "works", "state", "preferences", "images", "previews", "media", "imageRecords", "videoRecords", "audioRecords", "agentRecords", "chats", "pluginData":
	default:
		writeCanvasError(c, http.StatusBadRequest, "CANVAS_COLLECTION_INVALID", errors.New("unsupported canvas collection"))
		return
	}
	// A wildcard route keeps encoded slashes inside upstream keys intact.
	key := strings.TrimPrefix(c.Param("key"), "/")
	if len(key) > 512 || !utf8.ValidString(key) || strings.ContainsRune(key, '\x00') || (c.Param("key") != "" && key == "") {
		writeCanvasError(c, http.StatusBadRequest, "CANVAS_KEY_INVALID", errors.New("canvas keys must contain between 1 and 512 UTF-8 bytes"))
		return
	}
	var expectedHash *string
	ifMatch, ifNoneMatch := c.Request.Header.Values("If-Match"), c.Request.Header.Values("If-None-Match")
	if len(ifMatch) > 0 || len(ifNoneMatch) > 0 {
		valid := c.Request.Method == http.MethodPut && collection == "chats" && key != "" && len(ifMatch)+len(ifNoneMatch) == 1
		condition := ""
		if valid && len(ifNoneMatch) == 1 {
			valid = strings.TrimSpace(ifNoneMatch[0]) == "*"
			condition = "absent"
		} else if valid {
			value := strings.TrimSpace(ifMatch[0])
			valid = len(value) == 66 && value[0] == '"' && value[65] == '"'
			if valid {
				condition = value[1:65]
				_, err := hex.DecodeString(condition)
				valid = err == nil && condition == strings.ToLower(condition)
			}
		}
		if !valid {
			writeCanvasError(c, http.StatusBadRequest, "CANVAS_STORAGE_CONDITION_INVALID", errors.New("conditional writes require a single chats key and either If-None-Match: * or a quoted lowercase SHA256 If-Match"))
			return
		}
		expectedHash = &condition
	}
	ctx, userID := c.Request.Context(), c.GetInt("id")
	switch c.Request.Method {
	case http.MethodGet:
		if key == "" {
			keys, err := model.ListCanvasObjectKeys(ctx, userID, collection)
			if errors.Is(err, model.ErrCanvasCollectionTooLarge) {
				writeCanvasError(c, http.StatusConflict, "CANVAS_COLLECTION_TOO_LARGE", err)
				return
			}
			if err != nil {
				writeCanvasError(c, http.StatusInternalServerError, "CANVAS_STORAGE_ERROR", err)
				return
			}
			common.ApiSuccess(c, gin.H{"keys": keys})
			return
		}
		object, err := model.GetCanvasObject(ctx, userID, collection, key)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			writeCanvasError(c, http.StatusNotFound, "CANVAS_OBJECT_NOT_FOUND", errors.New("canvas object was not found"))
			return
		}
		if err != nil {
			writeCanvasError(c, http.StatusInternalServerError, "CANVAS_STORAGE_ERROR", err)
			return
		}
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Content-Disposition", "attachment")
		c.Data(http.StatusOK, object.ContentType, object.Data)
	case http.MethodPut:
		if key == "" {
			writeCanvasError(c, http.StatusBadRequest, "CANVAS_KEY_INVALID", errors.New("a canvas object key is required"))
			return
		}
		contentType := c.GetHeader("Content-Type")
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || !strings.Contains(mediaType, "/") || len(contentType) > 255 {
			writeCanvasError(c, http.StatusBadRequest, "CANVAS_CONTENT_TYPE_INVALID", errors.New("invalid canvas content type"))
			return
		}
		if c.Request.ContentLength > model.MaxCanvasObjectBytes {
			writeCanvasError(c, http.StatusRequestEntityTooLarge, "CANVAS_OBJECT_TOO_LARGE", model.ErrCanvasObjectTooLarge)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, model.MaxCanvasObjectBytes))
		if err != nil {
			var limitError *http.MaxBytesError
			if errors.As(err, &limitError) {
				writeCanvasError(c, http.StatusRequestEntityTooLarge, "CANVAS_OBJECT_TOO_LARGE", model.ErrCanvasObjectTooLarge)
			} else {
				writeCanvasError(c, http.StatusBadRequest, "CANVAS_BODY_INVALID", errors.New("could not read canvas object"))
			}
			return
		}
		if mediaType == "application/json" || strings.HasSuffix(mediaType, "+json") {
			var value any
			if err := common.Unmarshal(body, &value); err != nil {
				writeCanvasError(c, http.StatusBadRequest, "CANVAS_JSON_INVALID", errors.New("invalid canvas JSON"))
				return
			}
		}
		if err := model.PutCanvasObject(ctx, &model.CanvasObject{
			UserID: userID, Collection: collection, RecordKey: key, Data: body, ContentType: contentType,
		}, expectedHash); err != nil {
			if errors.Is(err, model.ErrCanvasStorageConflict) {
				writeCanvasError(c, http.StatusPreconditionFailed, "CANVAS_STORAGE_CONFLICT", err)
				return
			}
			if errors.Is(err, model.ErrCanvasStorageQuotaExceeded) {
				writeCanvasError(c, http.StatusConflict, "CANVAS_STORAGE_QUOTA_EXCEEDED", err)
				return
			}
			if errors.Is(err, model.ErrCanvasCollectionTooLarge) {
				writeCanvasError(c, http.StatusConflict, "CANVAS_COLLECTION_TOO_LARGE", err)
				return
			}
			writeCanvasError(c, http.StatusInternalServerError, "CANVAS_STORAGE_ERROR", err)
			return
		}
		common.ApiSuccess(c, nil)
	case http.MethodDelete:
		if err := model.DeleteCanvasObjects(ctx, userID, collection, key); err != nil {
			writeCanvasError(c, http.StatusInternalServerError, "CANVAS_STORAGE_ERROR", err)
			return
		}
		common.ApiSuccess(c, nil)
	}
}

func writeCanvasError(c *gin.Context, status int, code string, err error) {
	message := err.Error()
	if status == http.StatusInternalServerError {
		// SQL failures may contain binary payloads or credentials. Do not return
		// or log the underlying database error for this storage boundary.
		message = "Canvas storage is temporarily unavailable"
	}
	c.JSON(status, gin.H{"success": false, "code": code, "message": message})
}
