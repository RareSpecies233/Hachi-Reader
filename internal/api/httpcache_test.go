package api

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestResponseCacheHitAndBypass(t *testing.T) {
	var calls int32
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[1]}`))
	})

	c := newResponseCache(10*time.Minute, 8)
	h := c.Middleware(next)

	do := func(target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	r1 := do("/api/explore/tops?sort=allvisit")
	if r1.Header().Get("X-Hachi-Cache") != "" {
		t.Errorf("首次请求不应标记缓存命中，实际 %q", r1.Header().Get("X-Hachi-Cache"))
	}
	r2 := do("/api/explore/tops?sort=allvisit")
	if got := r2.Header().Get("X-Hachi-Cache"); got != "HIT" {
		t.Errorf("第二次请求应命中缓存，实际 %q", got)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Errorf("上游应只被调用 1 次，实际 %d", calls)
	}

	// ?refresh=1 必须绕过缓存
	do("/api/explore/tops?sort=allvisit&refresh=1")
	if atomic.LoadInt32(&calls) != 2 {
		t.Errorf("refresh=1 应重新请求上游，实际调用 %d 次", calls)
	}
}

func TestResponseCacheSkipsStateEndpoints(t *testing.T) {
	var calls int32
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	c := newResponseCache(time.Minute, 8)
	h := c.Middleware(next)

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/shelves", nil)
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	if calls != 3 {
		t.Errorf("状态类接口不应被缓存，上游调用次数 = %d", calls)
	}
}

func TestResponseCacheCoalescesConcurrent(t *testing.T) {
	var calls int32
	release := make(chan struct{})
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		<-release // 卡住，确保并发请求同时进来
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	c := newResponseCache(time.Minute, 8)
	h := c.Middleware(next)

	const n = 5
	done := make(chan struct{}, n)
	for i := 0; i < n; i++ {
		go func() {
			req := httptest.NewRequest(http.MethodGet, "/api/book/1", nil)
			h.ServeHTTP(httptest.NewRecorder(), req)
			done <- struct{}{}
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	for i := 0; i < n; i++ {
		<-done
	}

	if calls != 1 {
		t.Errorf("并发相同请求应合并为 1 次上游调用，实际 %d", calls)
	}
}

func TestResponseCacheDoesNotStoreErrors(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{}}`))
	})
	c := newResponseCache(time.Minute, 8)
	h := c.Middleware(next)

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/book/1", nil))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/book/1", nil))
	if rec.Header().Get("X-Hachi-Cache") != "" {
		t.Error("错误响应不应被缓存")
	}
}

func TestResponseCacheDisabled(t *testing.T) {
	c := newResponseCache(0, 8)
	if c.enabled() {
		t.Error("TTL=0 时应关闭缓存")
	}
	if c.Stats()["enabled"] != false {
		t.Error("关闭时 Stats 应报告 enabled=false")
	}
}
