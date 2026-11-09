package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"hachi/internal/config"
	"hachi/internal/store"
	"hachi/internal/wkk"
)

const Version = "0.1.0"

type Server struct {
	cfg    config.Config
	st     *store.Store
	wk     *wkk.Client
	static fs.FS
	mux    *http.ServeMux
	img    *imageCache
	jobs   *jobRegistry

	// 访问令牌可在运行时轮换，所以用读写锁保护
	tokenMu sync.RWMutex
	token   string
}

func New(cfg config.Config, st *store.Store, wk *wkk.Client, static fs.FS) *Server {
	s := &Server{
		cfg:    cfg,
		st:     st,
		wk:     wk,
		static: static,
		mux:    http.NewServeMux(),
		img:    newImageCache(cfg.DataDir, cfg.AllowAnyImageHost),
		jobs:   newJobRegistry(),
		token:  cfg.Token,
	}
	s.routes()
	return s
}

func (s *Server) routes() {
	m := s.mux

	m.HandleFunc("GET /api/health", s.handleHealth)
	m.HandleFunc("POST /api/unlock", s.handleUnlock)
	m.HandleFunc("POST /api/lock", s.handleLock)
	m.HandleFunc("GET /api/token", s.handleGetToken)
	m.HandleFunc("POST /api/token/rotate", s.handleRotateToken)

	m.HandleFunc("GET /api/explore/tops", s.handleTops)
	m.HandleFunc("GET /api/explore/list", s.handleAllList)
	m.HandleFunc("GET /api/explore/tag", s.handleTagList)
	m.HandleFunc("POST /api/login", s.handleLogin)
	m.HandleFunc("POST /api/logout", s.handleLogout)

	m.HandleFunc("GET /api/tags", s.handleTags)
	m.HandleFunc("GET /api/search", s.handleSearch)

	m.HandleFunc("GET /api/book/{id}", s.handleBook)
	m.HandleFunc("GET /api/book/{id}/volumes", s.handleVolumes)
	m.HandleFunc("GET /api/book/{id}/chapter/{cid}", s.handleChapter)
	m.HandleFunc("GET /api/book/{id}/state", s.handleGetState)
	m.HandleFunc("PUT /api/book/{id}/state", s.handlePutState)
	m.HandleFunc("POST /api/book/{id}/read", s.handleMarkRead)
	m.HandleFunc("POST /api/book/{id}/read-all", s.handleMarkAllRead)

	m.HandleFunc("GET /api/shelves", s.handleShelves)
	m.HandleFunc("POST /api/shelves", s.handleCreateShelf)
	m.HandleFunc("PATCH /api/shelves/{id}", s.handleUpdateShelf)
	m.HandleFunc("DELETE /api/shelves/{id}", s.handleDeleteShelf)
	m.HandleFunc("POST /api/shelves/{id}/books", s.handleAddToShelf)
	m.HandleFunc("DELETE /api/shelves/{id}/books/{bookId}", s.handleRemoveFromShelf)
	m.HandleFunc("GET /api/library", s.handleLibrary)

	m.HandleFunc("POST /api/stats/session", s.handleAddSession)
	m.HandleFunc("GET /api/stats/summary", s.handleStatsSummary)
	m.HandleFunc("GET /api/stats/calendar", s.handleCalendar)

	m.HandleFunc("GET /api/updates", s.handleUpdates)
	m.HandleFunc("POST /api/updates/check", s.handleCheckUpdates)

	m.HandleFunc("POST /api/cache/{id}", s.handleCacheBook)
	m.HandleFunc("GET /api/cache", s.handleCacheInfo)
	m.HandleFunc("DELETE /api/cache/{id}", s.handleClearCache)

	m.HandleFunc("GET /api/settings", s.handleGetSettings)
	m.HandleFunc("PUT /api/settings", s.handlePutSettings)

	m.HandleFunc("GET /api/img", s.handleImage)

	m.HandleFunc("/", s.handleStatic)
}

func (s *Server) Handler() http.Handler {
	return s.recoverer(s.logger(s.auth(s.securityHeaders(s.mux))))
}

// ---------------------------------------------------------------- 中间件

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[panic] %s %s: %v", r.Method, r.URL.Path, rec)
				writeError(w, http.StatusInternalServerError, "internal", "服务器内部错误")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}

func (s *Server) logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: 200}
		next.ServeHTTP(sw, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.code, time.Since(start).Round(time.Millisecond))
		}
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) currentToken() string {
	s.tokenMu.RLock()
	defer s.tokenMu.RUnlock()
	return s.token
}

func (s *Server) setToken(t string) {
	s.tokenMu.Lock()
	s.token = t
	s.tokenMu.Unlock()
}

// auth 单用户令牌校验。未启用令牌（HACHI_NO_AUTH=1）时不校验。
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := s.currentToken()
		if want == "" || r.URL.Path == "/api/health" || r.URL.Path == "/api/unlock" {
			next.ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}

		got := ""
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			got = strings.TrimPrefix(h, "Bearer ")
		}
		if got == "" {
			got = r.URL.Query().Get("token")
		}
		if got == "" {
			if ck, err := r.Cookie("hachi_token"); err == nil {
				got = ck.Value
			}
		}
		// 常量时间比较，避免通过响应时间逐位猜令牌
		if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized", "访问令牌无效或已过期")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------- 静态资源

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "not_found", "接口不存在")
		return
	}

	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}

	if st, err := fs.Stat(s.static, p); err == nil && !st.IsDir() {
		if s.cfg.Dev {
			// 开发模式下前端随时在改，一律不缓存
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			if strings.HasSuffix(p, ".webmanifest") {
				w.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
			}
			http.ServeFileFS(w, r, s.static, p)
			return
		}

		// 缓存策略集中在这里决定，避免后面的默认值把特殊规则覆盖掉
		switch {
		case p == "sw.js":
			// Service Worker 必须每次回源校验，否则用户拿不到新版本
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			w.Header().Set("Service-Worker-Allowed", "/")
		case strings.HasSuffix(p, ".webmanifest"):
			w.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
		case strings.HasSuffix(p, ".html"):
			w.Header().Set("Cache-Control", "no-cache")
		default:
			w.Header().Set("Cache-Control", "public, max-age=300")
		}
		http.ServeFileFS(w, r, s.static, p)
		return
	}

	// SPA 回退：非静态资源一律交给前端路由
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFileFS(w, r, s.static, "index.html")
}

// ---------------------------------------------------------------- 响应工具

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("[json] 编码失败: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]apiError{"error": {Code: code, Message: msg}})
}

// writeUpstreamError 把抓取层错误映射成合适的 HTTP 状态与前端可读文案。
func (s *Server) writeUpstreamError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, wkk.ErrLoginRequired):
		writeError(w, http.StatusForbidden, "login_required",
			"探索与搜索需要登录 wenku8 账号，请在设置中填写账号密码")
	case errors.Is(err, wkk.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "在 wenku8 上找不到这本书或这一章")
	case errors.Is(err, wkk.ErrCopyright):
		writeError(w, http.StatusForbidden, "copyright", "该书因版权原因无法获取")
	case errors.Is(err, wkk.ErrBlocked):
		writeError(w, http.StatusBadGateway, "upstream_blocked",
			"wenku8 拒绝了请求。可尝试在服务端配置代理（HACHI_PROXY），或稍后重试")
	default:
		log.Printf("[upstream] %v", err)
		writeError(w, http.StatusBadGateway, "upstream_error", "无法从 wenku8 获取数据："+err.Error())
	}
}

// ---------------------------------------------------------------- 令牌 Cookie

// isHTTPS 判断请求是否走 HTTPS（含反代）。
func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// setAuthCookie 把令牌写进 HttpOnly Cookie：
// JavaScript 读不到，XSS 偷不走；浏览器自动随请求发送，图片也不用再拼 ?token=。
func setAuthCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "hachi_token",
		Value:    token,
		Path:     "/",
		MaxAge:   3600 * 24 * 365,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isHTTPS(r),
	})
}

func clearAuthCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     "hachi_token",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isHTTPS(r),
	})
}
