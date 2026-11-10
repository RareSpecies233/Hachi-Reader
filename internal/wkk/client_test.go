package wkk

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	"golang.org/x/text/encoding/simplifiedchinese"
)

// ---------------------------------------------------------------- 工具

func gbkBytes(t *testing.T, s string) []byte {
	t.Helper()
	b, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte(s))
	if err != nil {
		t.Fatalf("GBK 编码失败: %v", err)
	}
	return b
}

func testClient(t *testing.T, hosts []string, mutate func(*Options)) *Client {
	t.Helper()
	opt := Options{
		Hosts:     hosts,
		PageGap:   time.Millisecond,
		SearchGap: 20 * time.Millisecond,
		Timeout:   5 * time.Second,
	}
	if mutate != nil {
		mutate(&opt)
	}
	c, err := NewClient(opt)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

func jarCount(c *Client, host string) int {
	u, err := url.Parse(host)
	if err != nil {
		return -1
	}
	return len(c.tc.GetCookies(u))
}

func listHTML(title string, id string) string {
	return `<html><body><div id="content"><div>` +
		`<a href="/book/` + id + `.htm" title="` + title + `">` + title + `</a>` +
		`</div></div></body></html>`
}

const loginHTML = `<html><body><div class="fl">请登录</div>` +
	`<form action="/login.php" method="post">` +
	`<input type="text" name="username"><input type="password" name="password">` +
	`</form>本站正式关闭。<br></body></html>`

// ---------------------------------------------------------------- Cookie 域

// TestSeedCookiesCoversAllHosts 是本次修复的核心断言：
// seed 之后每个 host 的 jar 里都必须有登录 Cookie，rotate 之后也不能丢。
func TestSeedCookiesCoversAllHosts(t *testing.T) {
	hosts := []string{"https://www.wenku8.net", "https://www.wenku8.cc"}
	c := testClient(t, hosts, func(o *Options) { o.UseBundledCookie = true })

	for _, h := range hosts {
		if n := jarCount(c, h); n == 0 {
			t.Errorf("%s 的 jar 里没有 Cookie（seed 只覆盖了当前 host？）", h)
		}
	}
	if st := c.Status(); len(st.CookieHosts) != 2 {
		t.Errorf("CookieHosts = %v, 期望两个 host 都有", st.CookieHosts)
	}

	// 轮换到另一个域之后，登录态仍必须完整。
	c.rotate()
	if c.Host() != hosts[1] {
		t.Fatalf("rotate 后 host = %s", c.Host())
	}
	for _, h := range hosts {
		if n := jarCount(c, h); n == 0 {
			t.Errorf("rotate 后 %s 丢 Cookie", h)
		}
	}

	// 再轮换回第一个域。
	c.rotate()
	if n := jarCount(c, hosts[0]); n == 0 {
		t.Errorf("第二次 rotate 后 %s 丢 Cookie", hosts[0])
	}
}

func TestSetCookieCoversAllHosts(t *testing.T) {
	hosts := []string{"https://a.example.com", "https://b.example.com"}
	c := testClient(t, hosts, nil)
	c.SetCookie("jieqiUserInfo=abc; jieqiVisitInfo=def")

	for _, h := range hosts {
		if n := jarCount(c, h); n < 2 {
			t.Errorf("%s 只有 %d 个 Cookie，期望 2 个", h, n)
		}
	}
	if c.CookieSource() != CookieCustom {
		t.Errorf("来源 = %s, 期望 cookie", c.CookieSource())
	}
}

// ---------------------------------------------------------------- 错误分类

func TestRateLimitedBackoffNoAmplification(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Retry-After", "2")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, "error code: 1015")
	}))
	defer srv.Close()

	c := testClient(t, []string{srv.URL}, func(o *Options) { o.UseBundledCookie = true })

	_, err := c.TopList(context.Background(), "allvisit", 1)
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("期望 ErrRateLimited，实际 %v", err)
	}
	// 关键：429 不能换 host 重试，否则请求数翻倍、限流更久。
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("上游请求数 = %d，期望 1（不应轮换重试）", got)
	}
	if st := c.Status(); !st.Blocked || st.BackoffSeconds <= 0 {
		t.Errorf("Status 未反映退避: blocked=%v backoff=%d", st.Blocked, st.BackoffSeconds)
	}

	// 退避期内必须快速失败，且不再打上游。
	start := time.Now()
	_, err = c.TopList(context.Background(), "allvisit", 1)
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("退避期内期望 ErrRateLimited，实际 %v", err)
	}
	if d := time.Since(start); d > 300*time.Millisecond {
		t.Errorf("退避期内请求耗时 %v，应该快速失败", d)
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("退避期内又打了上游：hits = %d", got)
	}
}

func TestBlocked403(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, "Attention Required")
	}))
	defer srv.Close()

	c := testClient(t, []string{srv.URL}, func(o *Options) { o.UseBundledCookie = true })
	_, err := c.TopList(context.Background(), "allvisit", 1)
	if !errors.Is(err, ErrBlocked) {
		t.Fatalf("期望 ErrBlocked，实际 %v", err)
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("403 后不应立刻换 host 重试，hits = %d", got)
	}
	if st := c.Status(); !st.Blocked {
		t.Errorf("403 后应进入退避")
	}
}

func TestChallengePageIsBlocked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// HTTP 200 但内容是 Cloudflare JS 挑战页
		_, _ = io.WriteString(w, "<html><title>Just a moment...</title><body>cf-chl</body></html>")
	}))
	defer srv.Close()

	c := testClient(t, []string{srv.URL}, func(o *Options) { o.UseBundledCookie = true })
	_, err := c.TopList(context.Background(), "allvisit", 1)
	if !errors.Is(err, ErrBlocked) {
		t.Fatalf("期望 ErrBlocked，实际 %v", err)
	}
}

// TestLoginPageWithCookieIsStale：配了 Cookie 却拿到登录页 → 登录态失效，
// 而不是"需要登录"（后者是没配凭据）。
func TestLoginPageWithCookieIsStale(t *testing.T) {
	body := gbkBytes(t, loginHTML)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	c := testClient(t, []string{srv.URL}, func(o *Options) { o.UseBundledCookie = true })
	_, err := c.TopList(context.Background(), "allvisit", 1)
	if !errors.Is(err, ErrLoginStale) {
		t.Fatalf("期望 ErrLoginStale，实际 %v", err)
	}

	// 未配置凭据时才是 ErrLoginRequired。
	c2 := testClient(t, []string{srv.URL}, nil)
	_, err = c2.TopList(context.Background(), "allvisit", 1)
	if !errors.Is(err, ErrLoginRequired) {
		t.Fatalf("无凭据时期望 ErrLoginRequired，实际 %v", err)
	}
}

// TestEmptyListHTTP200IsNotSuccess：HTTP 200 + 空内容必须报错。
func TestEmptyListHTTP200IsNotSuccess(t *testing.T) {
	body := gbkBytes(t, `<html><body><p>系统维护中</p></body></html>`)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	c := testClient(t, []string{srv.URL}, func(o *Options) { o.UseBundledCookie = true })
	res, err := c.TopList(context.Background(), "allvisit", 1)
	if err == nil {
		t.Fatalf("空列表被当成成功返回了: %+v", res)
	}
	if !errors.Is(err, ErrLoginStale) {
		t.Fatalf("期望 ErrLoginStale，实际 %v", err)
	}
	if st := c.Status(); st.LastProbeOK {
		t.Errorf("空列表不应被记为探测成功")
	}
}

func TestNonEmptyListSuccess(t *testing.T) {
	body := gbkBytes(t, listHTML("文学少女", "1"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	c := testClient(t, []string{srv.URL}, func(o *Options) { o.UseBundledCookie = true })
	res, err := c.TopList(context.Background(), "allvisit", 1)
	if err != nil {
		t.Fatalf("TopList: %v", err)
	}
	if len(res.Items) != 1 || res.Items[0].Title != "文学少女" {
		t.Fatalf("解析结果异常: %+v", res.Items)
	}
	st := c.Status()
	if !st.LastProbeOK || st.Requests != 1 || st.Success != 1 {
		t.Errorf("统计异常: %+v", st)
	}
	if st.SuccessRate != 1 {
		t.Errorf("成功率 = %v", st.SuccessRate)
	}
}

// 5xx 属于单个域的故障，应该轮换到另一个 host 继续尝试。
func TestRotateOnServerError(t *testing.T) {
	var badHits, goodHits int32
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&badHits, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()
	goodBody := gbkBytes(t, listHTML("文学少女", "1"))
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&goodHits, 1)
		_, _ = w.Write(goodBody)
	}))
	defer good.Close()

	c := testClient(t, []string{bad.URL, good.URL}, func(o *Options) { o.UseBundledCookie = true })
	res, err := c.TopList(context.Background(), "allvisit", 1)
	if err != nil {
		t.Fatalf("轮换后应成功: %v", err)
	}
	if len(res.Items) != 1 {
		t.Fatalf("items = %d", len(res.Items))
	}
	if atomic.LoadInt32(&badHits) != 1 || atomic.LoadInt32(&goodHits) != 1 {
		t.Errorf("hits bad=%d good=%d，期望各 1", badHits, goodHits)
	}
	// 故障转移后成功，应回到主域，避免长期粘在备用域（.cc 每次多一次 301）。
	if c.Host() != bad.URL {
		t.Errorf("成功后 host = %s, 期望主域 %s", c.Host(), bad.URL)
	}
}

// ---------------------------------------------------------------- 搜索节流

// TestSearchSerialized 并发发起两次搜索，验证第二个请求真正等够了间隔。
func TestSearchSerialized(t *testing.T) {
	var mu sync.Mutex
	var times []time.Time
	body := gbkBytes(t, `<html><body><div id="content"></div></body></html>`)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		times = append(times, time.Now())
		mu.Unlock()
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	gap := 120 * time.Millisecond
	c := testClient(t, []string{srv.URL}, func(o *Options) {
		o.UseBundledCookie = true
		o.SearchGap = gap
	})

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.Search(context.Background(), "文学少女", "articlename", 1)
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(times) != 2 {
		t.Fatalf("搜索请求数 = %d", len(times))
	}
	if d := times[1].Sub(times[0]); d < gap-20*time.Millisecond {
		t.Errorf("两次搜索间隔 = %v，小于约定 %v（节流被绕过）", d, gap)
	}
}

// TestBackoffGrows：连续触发时退避时间应递增，并受上限约束。
func TestBackoffGrows(t *testing.T) {
	c := testClient(t, []string{"https://a.example.com"}, func(o *Options) { o.UseBundledCookie = true })
	d1 := c.tripBlock(time.Second)
	d2 := c.tripBlock(time.Second)
	d3 := c.tripBlock(time.Second)
	if d2 <= d1 || d3 <= d2 {
		t.Errorf("退避未递增: %v %v %v", d1, d2, d3)
	}
	if d3 > maxBackoff {
		t.Errorf("退避 %v 超过上限 %v", d3, maxBackoff)
	}
	if st := c.Status(); !st.Blocked || st.Strikes != 3 {
		t.Errorf("Status: blocked=%v strikes=%d", st.Blocked, st.Strikes)
	}
}

func TestRetryAfter(t *testing.T) {
	resp := &fhttp.Response{Header: fhttp.Header{}}
	resp.Header.Set("Retry-After", "7")
	if d := retryAfter(resp, time.Second); d != 7*time.Second {
		t.Errorf("Retry-After=7 -> %v", d)
	}
	resp.Header.Set("Retry-After", "abc")
	if d := retryAfter(resp, 3*time.Second); d != 3*time.Second {
		t.Errorf("非法 Retry-After 应回退: %v", d)
	}
	resp.Header.Del("Retry-After")
	if d := retryAfter(resp, 5*time.Second); d != 5*time.Second {
		t.Errorf("缺失 Retry-After 应回退: %v", d)
	}
	// 超过上限要被截断
	resp.Header.Set("Retry-After", "9999")
	if d := retryAfter(resp, time.Second); d != maxBackoff {
		t.Errorf("超大 Retry-After 未截断: %v", d)
	}
}

// 确保“有 Cookie”时不会把成功页面误判成登录态失效。
func TestSuccessfulProbeMarksStatus(t *testing.T) {
	body := gbkBytes(t, listHTML("文学少女", "1"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	c := testClient(t, []string{srv.URL}, func(o *Options) { o.UseBundledCookie = true })
	if err := c.Probe(context.Background()); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	st := c.Status()
	if !st.LastProbeOK || st.LastProbeNote == "" {
		t.Errorf("探测状态未记录: %+v", st)
	}
	if st.Requests != 1 || st.Success != 1 || st.Failed != 0 {
		t.Errorf("统计异常: %+v", st)
	}
}

// 保证 Hosts() 返回副本，外部改动不会影响客户端。
func TestHostsCopy(t *testing.T) {
	c := testClient(t, []string{"https://a.example.com", "https://b.example.com"}, nil)
	hs := c.Hosts()
	hs[0] = "https://evil.example.com"
	if c.Hosts()[0] != "https://a.example.com" {
		t.Errorf("Hosts() 泄漏了内部切片")
	}
	if !strings.Contains(c.Host(), "a.example.com") {
		t.Errorf("host = %s", c.Host())
	}
}
