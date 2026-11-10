package api

// 服务端响应缓存：内容类 GET 接口在内存里缓存 10 分钟（可配置），
// 重复请求直接命中，不再打 wenku8 —— 既降低上游限流风险，也让 PWA 打开更快。
//
// 设计要点：
//   - 只缓存「内容类」接口（书籍/目录/正文/探索/搜索/标签），用户状态类一律不缓存
//   - 相同 URL 的并发请求只打一次上游（singleflight），避免把限流打得更狠
//   - 只缓存 2xx；带 ?refresh=1 强制绕过
//   - HACHI_CACHE_TTL=0 可整体关闭

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type cacheEntry struct {
	status  int
	header  http.Header
	body    []byte
	stored  time.Time
	expires time.Time
}

type inflight struct {
	done chan struct{}
	ent  *cacheEntry
}

type responseCache struct {
	ttl time.Duration
	max int

	mu      sync.Mutex
	items   map[string]*cacheEntry
	flight  map[string]*inflight
	hits    int64
	misses  int64
	evicted int64
}

func newResponseCache(ttl time.Duration, max int) *responseCache {
	if max <= 0 {
		max = 512
	}
	return &responseCache{
		ttl:    ttl,
		max:    max,
		items:  make(map[string]*cacheEntry),
		flight: make(map[string]*inflight),
	}
}

func (c *responseCache) enabled() bool { return c != nil && c.ttl > 0 }

// cacheableRequest 判断这个请求是否值得缓存。
func cacheableRequest(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	if r.URL.Query().Get("refresh") == "1" {
		return false
	}
	return cacheableAPI(r.URL.Path)
}

type cacheWriter struct {
	http.ResponseWriter
	status int
	body   []byte
}

func (w *cacheWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *cacheWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.body = append(w.body, b...)
	return w.ResponseWriter.Write(b)
}

// Middleware 包一层缓存。命中时直接回放，未命中则执行 next 并写入。
func (c *responseCache) Middleware(next http.Handler) http.Handler {
	if !c.enabled() {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !cacheableRequest(r) {
			next.ServeHTTP(w, r)
			return
		}

		key := r.Method + " " + r.URL.RequestURI()

		c.mu.Lock()
		if ent, ok := c.items[key]; ok {
			if time.Now().Before(ent.expires) {
				c.hits++
				c.mu.Unlock()
				replay(w, ent, "HIT")
				return
			}
			delete(c.items, key)
		}
		// 并发合并：同一个 URL 已经有人在打上游，就等它的结果
		if f, ok := c.flight[key]; ok {
			c.mu.Unlock()
			<-f.done
			if f.ent != nil {
				c.mu.Lock()
				c.hits++
				c.mu.Unlock()
				replay(w, f.ent, "HIT-SHARED")
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		f := &inflight{done: make(chan struct{})}
		c.flight[key] = f
		c.misses++
		c.mu.Unlock()

		cw := &cacheWriter{ResponseWriter: w}
		next.ServeHTTP(cw, r)

		// 只缓存成功的内容响应
		var stored *cacheEntry
		if cw.status >= 200 && cw.status < 300 && len(cw.body) > 0 {
			stored = &cacheEntry{
				status:  cw.status,
				header:  cloneHeader(cw.Header()),
				body:    cw.body,
				stored:  time.Now(),
				expires: time.Now().Add(c.ttl),
			}
			c.mu.Lock()
			c.items[key] = stored
			c.trimLocked()
			c.mu.Unlock()
		}

		c.mu.Lock()
		f.ent = stored
		delete(c.flight, key)
		c.mu.Unlock()
		close(f.done)
	})
}

func (c *responseCache) trimLocked() {
	if len(c.items) <= c.max {
		return
	}
	// 简单淘汰：先清过期，再按过期时间最早的删到 90%
	now := time.Now()
	for k, v := range c.items {
		if now.After(v.expires) {
			delete(c.items, k)
			c.evicted++
		}
	}
	for len(c.items) > c.max*9/10 {
		var oldestKey string
		var oldest time.Time
		for k, v := range c.items {
			if oldestKey == "" || v.expires.Before(oldest) {
				oldestKey, oldest = k, v.expires
			}
		}
		if oldestKey == "" {
			break
		}
		delete(c.items, oldestKey)
		c.evicted++
	}
}

func cloneHeader(h http.Header) http.Header {
	out := make(http.Header, len(h))
	for k, v := range h {
		out[k] = append([]string(nil), v...)
	}
	return out
}

func replay(w http.ResponseWriter, ent *cacheEntry, tag string) {
	for k, v := range ent.header {
		if k == "Content-Length" || k == "Date" {
			continue
		}
		w.Header()[k] = append([]string(nil), v...)
	}
	w.Header().Set("X-Hachi-Cache", tag)
	// Age = 这份缓存已经存了多久（与 HTTP 语义一致）
	w.Header().Set("Age", strconv.Itoa(int(time.Since(ent.stored).Seconds())))
	w.WriteHeader(ent.status)
	_, _ = w.Write(ent.body)
}

// Stats 供 /api/health 展示
func (c *responseCache) Stats() map[string]any {
	if !c.enabled() {
		return map[string]any{"enabled": false}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	total := c.hits + c.misses
	rate := 0.0
	if total > 0 {
		rate = float64(c.hits) / float64(total)
	}
	return map[string]any{
		"enabled": true,
		"ttlSec":  int(c.ttl.Seconds()),
		"entries": len(c.items),
		"max":     c.max,
		"hits":    c.hits,
		"misses":  c.misses,
		"evicted": c.evicted,
		"hitRate": rate,
	}
}

func (c *responseCache) Purge(prefix string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.items {
		if strings.Contains(k, prefix) {
			delete(c.items, k)
			c.evicted++
		}
	}
}
