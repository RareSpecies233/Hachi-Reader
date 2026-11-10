package wkk

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// 联网诊断测试，默认跳过：
//
//	HACHI_LIVE=1 go test ./internal/wkk/ -run Live -v
//
// 这些用例的价值是区分"软件问题"与"上游问题"：
//   - 两个域的 jar 里都有 Cookie，说明域切换不再丢登录态（软件侧已修）；
//   - 重复请求成功率低但错误是 ErrRateLimited，说明是上游限流，不是我们解析错。

func liveBundled(t *testing.T) *Client {
	t.Helper()
	if os.Getenv("HACHI_LIVE") == "" {
		t.Skip("跳过联网测试（设置 HACHI_LIVE=1 启用）")
	}
	c, err := NewClient(Options{Timeout: 30 * time.Second, UseBundledCookie: true})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

// TestLiveDomainCookieCoverage 断言修复后两个域都有登录 Cookie。
func TestLiveDomainCookieCoverage(t *testing.T) {
	c := liveBundled(t)
	for _, raw := range c.Hosts() {
		u, err := url.Parse(raw)
		if err != nil {
			continue
		}
		t.Logf("jar[%s] = %d 个 Cookie", u.Host, len(c.tc.GetCookies(u)))
	}
	st := c.Status()
	t.Logf("CookieHosts=%v host=%s", st.CookieHosts, st.Host)
	if len(st.CookieHosts) != len(c.Hosts()) {
		t.Errorf("只有 %v 有 Cookie，期望全部 host 都有", st.CookieHosts)
	}
}

// TestLiveForcedDomainSwitch 模拟 rotate() 把 hostIdx 切到 .cc 之后的真实场景：
// 站点会把 .cc 301 回 .net，因此只要 jar 里有 .net 的 Cookie，请求仍应成功。
func TestLiveForcedDomainSwitch(t *testing.T) {
	c := liveBundled(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	c.mu.Lock()
	c.hostIdx = 1 // https://www.wenku8.cc
	c.mu.Unlock()
	if got := c.Host(); !strings.Contains(got, "wenku8.cc") {
		t.Fatalf("host = %s, 期望 .cc", got)
	}

	res, err := c.TopList(ctx, "allvisit", 1)
	if err != nil {
		t.Fatalf("切到 .cc 后请求失败: %v（错误分类：rate=%v login=%v stale=%v blocked=%v）",
			err, err == ErrRateLimited, err == ErrLoginRequired, err == ErrLoginStale, err == ErrBlocked)
	}
	if len(res.Items) == 0 {
		t.Fatal("列表为空")
	}
	t.Logf("切到 .cc 后仍拿到 %d 条", len(res.Items))
}

// TestLiveCCOnlyCannotLogin 记录一个上游事实：只配置 .cc 时无法通过登录校验，
// 因为站点对 .cc 的所有路径都 301 回 .net，而 .net 需要自己的域 Cookie。
func TestLiveCCOnlyCannotLogin(t *testing.T) {
	if os.Getenv("HACHI_LIVE") == "" {
		t.Skip("跳过联网测试（设置 HACHI_LIVE=1 启用）")
	}
	c, err := NewClient(Options{Timeout: 30 * time.Second, UseBundledCookie: true,
		Hosts: []string{"https://www.wenku8.cc"}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, err = c.TopList(ctx, "allvisit", 1)
	t.Logf("只配 .cc 的结果: %v（预期 ErrLoginStale，因为 301 回 .net 时没有 .net Cookie）", err)
}

// TestLiveRepeatedTops 统计连续请求的成功率，是回答"上游还是我们"的关键数据。
func TestLiveRepeatedTops(t *testing.T) {
	c := liveBundled(t)
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	const rounds = 6
	okCount, rateCount := 0, 0
	for i := 0; i < rounds; i++ {
		start := time.Now()
		res, err := c.TopList(ctx, "allvisit", 1)
		switch {
		case err == nil:
			okCount++
			t.Logf("第 %d 次: ok items=%d %v", i+1, len(res.Items), time.Since(start).Round(time.Millisecond))
		case errors.Is(err, ErrRateLimited):
			rateCount++
			t.Logf("第 %d 次: rate_limited %v", i+1, err)
		default:
			t.Logf("第 %d 次: 其他错误 %v", i+1, err)
		}
		time.Sleep(700 * time.Millisecond)
	}
	st := c.Status()
	t.Logf("成功率 %d/%d，其中限流 %d 次；累计请求=%d 成功=%d 失败=%d 最近成功率=%.2f",
		okCount, rounds, rateCount, st.Requests, st.Success, st.Failed, st.RecentSuccessRate)
	if okCount == 0 && rateCount == 0 {
		t.Errorf("既没成功也没限流，说明存在未分类错误")
	}
}
