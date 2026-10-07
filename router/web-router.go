package router

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-contrib/gzip"
	"github.com/gin-contrib/static"
	"github.com/gin-gonic/gin"
)

// WebAssets holds the embedded dashboard frontend assets.
type WebAssets struct {
	BuildFS   fs.FS
	IndexPage []byte
}

func SetWebRouter(router *gin.Engine, assets WebAssets, pluginDispatcher gin.HandlerFunc) {
	if assets.BuildFS == nil {
		assets.BuildFS = embed.FS{}
	}
	frontendFS := common.EmbedFolder(assets.BuildFS, "web/dist")
	archiveDir := os.Getenv("WEB_ASSET_ARCHIVE_DIR")
	if archiveDir != "" {
		build, err := fs.Sub(assets.BuildFS, "web/dist")
		if err == nil {
			err = archiveWebAssets(build, archiveDir, time.Now())
		}
		if err != nil {
			common.SysError("could not archive dashboard assets: " + err.Error())
		}
	}

	router.NoRoute(
		pluginDispatcher,
		middleware.RouteTag("web"),
		gzip.Gzip(gzip.DefaultCompression),
		middleware.AccessTokenAudit(),
		middleware.GlobalWebRateLimit(),
		middleware.Cache(),
		func(c *gin.Context) {
			if c.Request.URL.Path != "/" && c.Request.URL.Path != "/index.html" {
				return
			}
			serveDashboardIndex(c, assets.IndexPage)
		},
		static.Serve("/", frontendFS),
		func(c *gin.Context) {
			urlPath := c.Request.URL.Path
			name := strings.TrimPrefix(urlPath, "/")
			if archiveDir != "" && isVersionedWebAsset(name) && (c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead) {
				file, err := os.OpenInRoot(archiveDir, name)
				if err == nil {
					defer file.Close()
					info, err := file.Stat()
					if err == nil && info.Mode().IsRegular() {
						c.Header("X-Content-Type-Options", "nosniff")
						http.ServeContent(c.Writer, c.Request, info.Name(), info.ModTime(), file)
						return
					}
				}
			}
			if strings.HasPrefix(urlPath, "/v1") || strings.HasPrefix(urlPath, "/api") || strings.HasPrefix(urlPath, "/assets") || strings.HasPrefix(urlPath, "/static/") || isWebAssetExtension(path.Ext(urlPath)) {
				c.Header("CDN-Cache-Control", "no-store")
				c.Header("Cloudflare-CDN-Cache-Control", "no-store")
				c.Header("X-Content-Type-Options", "nosniff")
				controller.RelayNotFound(c)
				return
			}
			serveDashboardIndex(c, assets.IndexPage)
		},
	)
}

func serveDashboardIndex(c *gin.Context, index []byte) {
	c.Header("Cache-Control", "no-cache")
	if c.Request.Method == http.MethodHead {
		c.Header("Content-Type", "text/html; charset=utf-8")
		c.AbortWithStatus(http.StatusOK)
		return
	}
	if c.Request.Method != http.MethodGet {
		c.Header("Allow", "GET, HEAD")
		c.Header("Cache-Control", "no-store")
		c.AbortWithStatus(http.StatusMethodNotAllowed)
		return
	}
	c.Data(http.StatusOK, "text/html; charset=utf-8", index)
	c.Abort()
}

func isWebAssetExtension(ext string) bool {
	switch strings.ToLower(ext) {
	case ".js", ".mjs", ".css", ".map", ".json", ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".ico", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".webmanifest":
		return true
	}
	return false
}
