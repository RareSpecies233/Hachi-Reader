package wkk

// wenku8.net 客户端。
//
// 为什么不用 net/http 默认传输：
//   - 站点在 Cloudflare 后面，实测桌面 Chrome UA 会被直接 403；
//   - 更要命的是 Go 的 TLS / HTTP2 指纹会被 Cloudflare 判定为机器人，
//     即使把 UA 改成 iPhone Safari 仍然返回 "Just a moment..."。
//   - 实测 curl 能通、Go 不能，说明拦的是指纹而不是 UA。
//     因此这里用 bogdanfinn/tls-client 完整伪装 Safari iOS 的 TLS + HTTP2 指纹。
//
// 其它实测约束：
//   - 全站 GBK 编码。
//   - 搜索 / 排行 / 标签 / 分类列表页未登录会返回"本站正式关闭"登录页。
//   - 书籍详情、目录、正文匿名可读。

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/PuerkitoBio/goquery"
	fhttp "github.com/bogdanfinn/fhttp"
	tlsclient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	"golang.org/x/text/encoding/simplifiedchinese"
)

var (
	ErrLoginRequired = errors.New("需要登录 wenku8 账号")
	ErrBlocked       = errors.New("wenku8 拒绝了请求（可能触发了防护）")
	ErrNotFound      = errors.New("wenku8 上找不到该内容")
	ErrCopyright     = errors.New("该书因版权原因无法获取")
)

const (
	mobileUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
		"AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

	// 站点把"两次搜索间隔不得少于 5 秒"写死在提示里，客户端至少守这个底线。
	searchGap = 5200 * time.Millisecond
	// 普通页面之间的最小间隔，避免被风控盯上。
	pageGap = 120 * time.Millisecond
)

// Client 是并发安全的。
type Client struct {
	hosts []string
	tc    tlsclient.HttpClient

	mu       sync.RWMutex
	hostIdx  int
	loggedIn bool
	user     string
	pass     string

	sem  chan struct{} // 并发上限
	gate sync.Mutex    // 相邻请求的最小间隔
	last time.Time

	searchGate sync.Mutex
	lastSearch time.Time
}

type Options struct {
	Username string
	Password string
	Proxy    string        // 形如 http://127.0.0.1:7890 或 socks5://...
	Timeout  time.Duration // 单请求超时
	Hosts    []string
	Profile  string // safari_ios | chrome | safari，默认 safari_ios
}

func NewClient(opt Options) (*Client, error) {
	hosts := opt.Hosts
	if len(hosts) == 0 {
		hosts = []string{"https://www.wenku8.net", "https://www.wenku8.cc"}
	}
	timeout := opt.Timeout
	if timeout == 0 {
		timeout = 25 * time.Second
	}

	profile := profiles.Safari_IOS_17_0
	switch strings.ToLower(opt.Profile) {
	case "chrome":
		profile = profiles.Chrome_120
	case "safari":
		profile = profiles.Safari_16_0
	}

	jar := tlsclient.NewCookieJar()
	opts := []tlsclient.HttpClientOption{
		tlsclient.WithTimeoutSeconds(int(timeout.Seconds())),
		tlsclient.WithClientProfile(profile),
		tlsclient.WithCookieJar(jar),
		tlsclient.WithDisableHttp3(), // QUIC 在部分网络下不稳，走 TCP 更可控
	}
	if opt.Proxy != "" {
		opts = append(opts, tlsclient.WithProxyUrl(opt.Proxy))
	}

	tc, err := tlsclient.NewHttpClient(tlsclient.NewNoopLogger(), opts...)
	if err != nil {
		return nil, fmt.Errorf("初始化抓取客户端失败: %w", err)
	}

	return &Client{
		hosts: hosts,
		tc:    tc,
		user:  opt.Username,
		pass:  opt.Password,
		sem:   make(chan struct{}, 3),
	}, nil
}

func (c *Client) host() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.hosts[c.hostIdx]
}

func (c *Client) rotate() {
	c.mu.Lock()
	c.hostIdx = (c.hostIdx + 1) % len(c.hosts)
	c.mu.Unlock()
}

func (c *Client) Host() string { return c.host() }

// SetCredentials 更新账号并清除登录态，下次 Login 时生效。
func (c *Client) SetCredentials(user, pass string) {
	c.mu.Lock()
	c.user, c.pass = user, pass
	c.loggedIn = false
	c.mu.Unlock()
}

// Logout 清除内存中的登录态与账号。
func (c *Client) Logout() {
	c.mu.Lock()
	c.user, c.pass = "", ""
	c.loggedIn = false
	c.mu.Unlock()
}

func (c *Client) credentials() (string, string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.user, c.pass
}

func (c *Client) IsLoggedIn() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.loggedIn
}

// ---------------------------------------------------------------- 请求

func (c *Client) wait(ctx context.Context) error {
	select {
	case c.sem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}

	c.gate.Lock()
	if d := pageGap - time.Since(c.last); d > 0 {
		time.Sleep(d)
	}
	c.last = time.Now()
	c.gate.Unlock()
	return nil
}

func (c *Client) release() { <-c.sem }

func (c *Client) newRequest(ctx context.Context, method, rawURL string, body io.Reader) (*fhttp.Request, error) {
	req, err := fhttp.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", mobileUA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	req.Header.Set("Referer", c.host()+"/")
	return req, nil
}

// do 发起一次 GET，自动做域名轮换与错误分类。
func (c *Client) do(ctx context.Context, path string) ([]byte, error) {
	if err := c.wait(ctx); err != nil {
		return nil, err
	}
	defer c.release()

	var lastErr error
	for attempt := 0; attempt < len(c.hosts); attempt++ {
		req, err := c.newRequest(ctx, "GET", c.host()+path, nil)
		if err != nil {
			return nil, err
		}

		resp, err := c.tc.Do(req)
		if err != nil {
			lastErr = err
			c.rotate()
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			c.rotate()
			continue
		}

		if resp.StatusCode == 404 {
			return nil, ErrNotFound
		}
		if resp.StatusCode == 403 || looksLikeChallenge(body) {
			lastErr = ErrBlocked
			c.rotate()
			continue
		}
		if resp.StatusCode >= 400 {
			lastErr = fmt.Errorf("wenku8 返回 HTTP %d", resp.StatusCode)
			c.rotate()
			continue
		}
		return body, nil
	}
	if lastErr == nil {
		lastErr = ErrBlocked
	}
	return nil, lastErr
}

// Fetch 抓取任意绝对 URL（图片代理用），返回字节与 Content-Type。
func (c *Client) Fetch(ctx context.Context, rawURL string) ([]byte, string, error) {
	if err := c.wait(ctx); err != nil {
		return nil, "", err
	}
	defer c.release()

	req, err := c.newRequest(ctx, "GET", rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := c.tc.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 24<<20))
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode >= 400 {
		return nil, "", fmt.Errorf("抓取 %s 失败: HTTP %d", rawURL, resp.StatusCode)
	}
	return body, resp.Header.Get("Content-Type"), nil
}

// looksLikeChallenge 识别 Cloudflare 的 JavaScript 挑战页。
func looksLikeChallenge(body []byte) bool {
	head := body
	if len(head) > 4096 {
		head = head[:4096]
	}
	s := string(head)
	return strings.Contains(s, "Just a moment") ||
		strings.Contains(s, "cf-chl") ||
		strings.Contains(s, "Attention Required")
}

// fetchDoc 取页面并解析为 goquery 文档（已把 GBK 转成 UTF-8）。
func (c *Client) fetchDoc(ctx context.Context, path string) (*goquery.Document, error) {
	raw, err := c.do(ctx, path)
	if err != nil {
		return nil, err
	}
	utf8Body, derr := simplifiedchinese.GBK.NewDecoder().Bytes(raw)
	if derr != nil || len(utf8Body) == 0 {
		utf8Body = raw // 少数页面可能是 UTF-8
	}
	s := string(utf8Body)

	if strings.Contains(s, "本站正式关闭") && !c.IsLoggedIn() {
		return nil, ErrLoginRequired
	}

	doc, err := goquery.NewDocumentFromReader(strings.NewReader(s))
	if err != nil {
		return nil, fmt.Errorf("解析 HTML 失败: %w", err)
	}
	return doc, nil
}

// ---------------------------------------------------------------- 登录

// Login 用账号密码登录并保存 Cookie。没有配置账号时直接返回 nil。
func (c *Client) Login(ctx context.Context) error {
	user, pass := c.credentials()
	if user == "" || pass == "" {
		return nil
	}

	form := url.Values{
		"username":  {user},
		"password":  {pass},
		"usecookie": {"315360000"},
		"action":    {"login"},
		"submit":    {" 登 录 "},
	}
	endpoint := c.host() + "/login.php?do=submit"

	req, err := c.newRequest(ctx, "POST", endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.tc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	u, _ := url.Parse(c.host())
	logged := false
	for _, ck := range c.tc.GetCookies(u) {
		if ck.Name == "jieqiUserInfo" && ck.Value != "" {
			logged = true
		}
	}
	if !logged {
		s := string(body)
		switch {
		case strings.Contains(s, "密码错误"), strings.Contains(s, "用户名或密码"), strings.Contains(s, "登录失败"):
			return errors.New("wenku8 账号或密码错误")
		default:
			return errors.New("wenku8 登录失败（站点可能要求验证码或已限制登录）")
		}
	}

	c.mu.Lock()
	c.loggedIn = true
	c.mu.Unlock()
	return nil
}

// VerifyLogin 用一次列表请求验证登录态是否仍然有效。
func (c *Client) VerifyLogin(ctx context.Context) bool {
	if !c.IsLoggedIn() {
		return false
	}
	raw, err := c.do(ctx, "/modules/article/toplist.php?sort=allvisit")
	if err != nil {
		return false
	}
	utf8Body, _ := simplifiedchinese.GBK.NewDecoder().Bytes(raw)
	return !strings.Contains(string(utf8Body), "本站正式关闭")
}

// ---------------------------------------------------------------- 搜索节流

// searchWait 保证两次搜索至少间隔 5.2 秒。
func (c *Client) searchWait(ctx context.Context) error {
	c.searchGate.Lock()
	defer c.searchGate.Unlock()
	if d := searchGap - time.Since(c.lastSearch); d > 0 {
		select {
		case <-time.After(d):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	c.lastSearch = time.Now()
	return nil
}
