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
//   - www.wenku8.cc 对所有页面都 301 回 www.wenku8.net；登录态只存在于 .net。
//   - 站点/Cloudflare 对同一出口 IP 有短窗口限流，超限返回 429 + "error code: 1015"
//     （Retry-After 通常为 10 秒）。这类限流是 zone 级别的，换域名重试只会
//     让请求数翻倍，所以必须退避而不是轮换。

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"strconv"
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
	// ErrLoginStale 表示配置了凭据，但站点返回登录页 / 空列表，说明这份登录态已经失效。
	// 它和 ErrLoginRequired 的区别是：前者是"没配"，后者是"配了但坏了"。
	ErrLoginStale  = errors.New("wenku8 登录态已失效")
	ErrBlocked     = errors.New("wenku8 拒绝了请求（可能触发了防护）")
	ErrRateLimited = errors.New("wenku8 当前限流")
	ErrNotFound    = errors.New("wenku8 上找不到该内容")
	ErrCopyright   = errors.New("该书因版权原因无法获取")
)

const (
	mobileUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
		"AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

	// 站点把"两次搜索间隔不得少于 5 秒"写死在提示里，客户端至少守这个底线。
	defaultSearchGap = 5200 * time.Millisecond
	// 普通页面之间的最小间隔，避免被风控盯上。
	defaultPageGap = 120 * time.Millisecond

	// 429 没有 Retry-After 时的兜底等待。
	defaultRetryAfter = 10 * time.Second
	// 退避上限：再久就该让用户明确看到"被限流"，而不是无限挂住。
	maxBackoff = 60 * time.Second
	// 最近请求窗口大小，用于计算"最近 N 次成功率"。
	recentWindow = 20
)

// Status 是给 /api/wk8/status 与 /api/health 用的可观测性快照。
type Status struct {
	Source CookieSource `json:"source"`
	Host   string       `json:"host"`
	Hosts  []string     `json:"hosts"`
	// CookieHosts 列出 cookie jar 里真正有登录 Cookie 的 host。
	// 修复前这里只会有一个（seed 只对当前 host 生效）。
	CookieHosts []string `json:"cookieHosts"`
	LoggedIn    bool     `json:"login"`

	Requests int `json:"requests"`
	Success  int `json:"success"`
	Failed   int `json:"failed"`
	// Rejected 是退避期内被本地快速拒绝的请求数，不计入 Requests，
	// 这样"上游成功率"和"用户被挡了多少次"可以分开看。
	Rejected    int     `json:"rejected"`
	SuccessRate float64 `json:"successRate"`
	// RecentSuccessRate 是最近 recentWindow 次请求的成功率，更能反映"此刻"的状态。
	RecentSuccessRate float64 `json:"recentSuccessRate"`

	LastError   string `json:"lastError,omitempty"`
	LastErrorAt string `json:"lastErrorAt,omitempty"`

	Blocked        bool   `json:"blocked"`
	BlockedUntil   string `json:"blockedUntil,omitempty"`
	BackoffSeconds int    `json:"backoffSeconds"`
	Strikes        int    `json:"strikes"`

	LastProbeAt   string `json:"lastProbeAt,omitempty"`
	LastProbeOK   bool   `json:"lastProbeOk"`
	LastProbeNote string `json:"lastProbeNote,omitempty"`
}

type requestRecord struct {
	ok   bool
	kind string
}

// Client 是并发安全的。
type Client struct {
	hosts []string
	tc    tlsclient.HttpClient

	mu           sync.RWMutex
	hostIdx      int
	loggedIn     bool
	user         string
	pass         string
	cookie       string // 当前生效的 Cookie 头（account 模式为空）
	cookieHeader string // 与 cookie 相同，保留语义化名字便于阅读
	source       CookieSource

	sem     chan struct{} // 并发上限
	gate    sync.Mutex    // 相邻请求的最小间隔
	last    time.Time
	pageGap time.Duration

	searchGate sync.Mutex
	lastSearch time.Time
	searchGap  time.Duration

	// obsMu 保护退避状态与统计，独立于配置锁，避免在请求路径上抢 mu。
	obsMu       sync.Mutex
	blockUntil  time.Time
	strikes     int
	total       int
	success     int
	failed      int
	rejected    int
	recent      []requestRecord
	lastErr     string
	lastErrAt   time.Time
	lastProbeAt time.Time
	lastProbeOK bool
	lastProbe   string
}

type Options struct {
	Username string
	Password string
	Proxy    string        // 形如 http://127.0.0.1:7890 或 socks5://...
	Timeout  time.Duration // 单请求超时
	Hosts    []string
	Profile  string // safari_ios | chrome | safari，默认 safari_ios

	// Cookie 直接注入的 Cookie 头（如 "a=b; c=d"），用于账号登录不可用的情况。
	Cookie string
	// UseBundledCookie 在没有账号也没有自定义 Cookie 时，使用内置公共 Cookie。
	UseBundledCookie bool

	// PageGap/SearchGap 仅供测试缩短等待；为 0 时使用默认值。
	PageGap   time.Duration
	SearchGap time.Duration
}

// bundledCookie 来自 LightNovelReader 项目内置的公共账号 Cookie。
//
// 来源：https://github.com/dmzz-yyhyy/LightNovelReader （Apache-2.0）
//
//	app/.../defaultplugin/wenku8/Wenku8Api.kt 的 wenku8Cookies()
//
// 作用：wenku8 的排行榜/分类/搜索页要求登录，未登录只返回"本站正式关闭"的提示页。
// LNR 因此内置了一个公共账号的登录态，让所有用户开箱即用。
//
// 注意：这是第三方账号，可能随时失效或被限流；我们在它失效时会自动降级为
// "需要登录"的提示，并允许用 HACHI_WK8_COOKIE 或自己的账号覆盖。
const bundledCookie = "jieqiUserInfo=jieqiUserId%3D1125456%2CjieqiUserName%3Dyyhyy%2C" +
	"jieqiUserGroup%3D3%2CjieqiUserVip%3D0%2C" +
	"jieqiUserPassword%3Deb62861281462fd923fb99218735fef0%2C" +
	"jieqiUserName_un%3Dyyhyy%2C" +
	"jieqiUserHonor_un%3D%E4%B8%AD%E7%BA%A7%E4%BC%9A%E5%91%98%2C" +
	"jieqiUserGroupName_un%3D%E6%99%AE%E9%80%9A%E4%BC%9A%E5%91%98%2C" +
	"jieqiUserLogin%3D1739294499; " +
	"jieqiVisitInfo=jieqiUserLogin%3D1739294499%2CjieqiUserId%3D1125456"

// CookieSource 说明当前列表类请求靠什么通过登录校验。
type CookieSource string

const (
	CookieNone    CookieSource = "none"
	CookieAccount CookieSource = "account"
	CookieCustom  CookieSource = "cookie"
	CookieBundled CookieSource = "bundled"
)

func NewClient(opt Options) (*Client, error) {
	hosts := opt.Hosts
	if len(hosts) == 0 {
		hosts = []string{"https://www.wenku8.net", "https://www.wenku8.cc"}
	}
	timeout := opt.Timeout
	if timeout == 0 {
		timeout = 25 * time.Second
	}
	pageGap := opt.PageGap
	if pageGap == 0 {
		pageGap = defaultPageGap
	}
	searchGap := opt.SearchGap
	if searchGap == 0 {
		searchGap = defaultSearchGap
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

	cookie := opt.Cookie
	source := CookieNone
	switch {
	case opt.Username != "" && opt.Password != "":
		source = CookieAccount // 登录成功后才有登录态
	case cookie != "":
		source = CookieCustom
	case opt.UseBundledCookie:
		cookie = bundledCookie
		source = CookieBundled
	}

	c := &Client{
		hosts:        append([]string(nil), hosts...),
		tc:           tc,
		user:         opt.Username,
		pass:         opt.Password,
		cookie:       cookie,
		cookieHeader: cookie,
		source:       source,
		sem:          make(chan struct{}, 3),
		pageGap:      pageGap,
		searchGap:    searchGap,
	}
	// 关键修复：Cookie 按域存储，只 seed 当前 host 会让轮换后的域裸奔。
	// 这里对全部 host 都注入一次，rotate() 之后也不会丢登录态。
	c.seedCookies(cookie)
	return c, nil
}

// seedCookies 把 "a=b; c=d" 形式的 Cookie 写进所有 host 的 cookie jar。
func (c *Client) seedCookies(header string) {
	if header == "" {
		return
	}
	for _, h := range c.snapshotHosts() {
		c.seedCookiesOn(h, header)
	}
}

// seedCookiesOn 把 Cookie 头写进指定 host 的 jar。
func (c *Client) seedCookiesOn(host, header string) {
	u, err := url.Parse(host)
	if err != nil {
		return
	}
	var cookies []*fhttp.Cookie
	for _, pair := range strings.Split(header, ";") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		k, v, ok := strings.Cut(pair, "=")
		if !ok || k == "" {
			continue
		}
		cookies = append(cookies, &fhttp.Cookie{Name: strings.TrimSpace(k), Value: strings.TrimSpace(v)})
	}
	if len(cookies) > 0 {
		c.tc.SetCookies(u, cookies)
	}
}

func (c *Client) snapshotHosts() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]string(nil), c.hosts...)
}

// CookieSource 返回当前列表访问所用的登录凭据来源。
func (c *Client) CookieSource() CookieSource {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.source
}

// SetCookie 用自定义 Cookie 覆盖当前凭据，并对所有 host 生效。
func (c *Client) SetCookie(header string) {
	c.mu.Lock()
	c.user, c.pass = "", ""
	c.cookie = header
	c.cookieHeader = header
	c.source = CookieCustom
	c.loggedIn = header != ""
	c.mu.Unlock()
	c.seedCookies(header)
}

func (c *Client) host() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.hosts[c.hostIdx]
}

// rotate 切换到下一个域名，并确保新域也有登录 Cookie。
//
// 注意：429/403 是 Cloudflare 对出口 IP 的限流，不在此处轮换——
// 换域名反而会让请求数翻倍、把限流打得更久。
func (c *Client) rotate() {
	c.mu.Lock()
	c.hostIdx = (c.hostIdx + 1) % len(c.hosts)
	header := c.cookieHeader
	primary := c.hosts[0]
	src := c.source
	c.mu.Unlock()

	// 只在"新 host 还没有 Cookie"时补种，避免用初始 Cookie 覆盖站点已经
	// 续期过的 Set-Cookie 值（wenku8 会在每次成功响应里刷新 jieqiUserLogin）。
	if header != "" {
		c.ensureSeeded(c.host(), header)
		return
	}
	if src == CookieAccount {
		c.ensureMirrored(primary, c.host())
	}
}

// ensureSeeded 只在 host 的 jar 为空时注入 Cookie。
func (c *Client) ensureSeeded(host, header string) {
	u, err := url.Parse(host)
	if err != nil || len(c.tc.GetCookies(u)) > 0 {
		return
	}
	c.seedCookiesOn(host, header)
}

// ensureMirrored 在 account 模式下把主域的 Cookie 补到缺失的 host。
func (c *Client) ensureMirrored(from, to string) {
	if from == to {
		return
	}
	toURL, err := url.Parse(to)
	if err != nil || len(c.tc.GetCookies(toURL)) > 0 {
		return
	}
	c.mirrorCookiesToAllHosts(from)
}

// preferPrimary 把 hostIdx 拨回主域。
// 轮换只用于故障转移；一旦请求成功就回到主域，避免长期粘在 .cc 上
// （.cc 每个请求都要多一次 301，等于把上游请求数翻倍）。
func (c *Client) preferPrimary() {
	c.mu.Lock()
	if c.hostIdx != 0 {
		c.hostIdx = 0
	}
	c.mu.Unlock()
}

func (c *Client) Host() string { return c.host() }

// Hosts 返回域名列表（只读副本）。
func (c *Client) Hosts() []string { return c.snapshotHosts() }

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

// markLoginInvalid 在站点明确返回登录页时把内存里的登录态置为失效，
// 这样 /api/health 的 login 字段不会继续骗人。
func (c *Client) markLoginInvalid() {
	c.mu.Lock()
	c.loggedIn = false
	c.mu.Unlock()
}

// ---------------------------------------------------------------- 退避与统计

// noteRejected 记录一次"本地退避拒绝"。
func (c *Client) noteRejected() {
	c.obsMu.Lock()
	c.rejected++
	c.obsMu.Unlock()
}

func (c *Client) blockedFor() time.Duration {
	c.obsMu.Lock()
	defer c.obsMu.Unlock()
	if c.blockUntil.IsZero() {
		return 0
	}
	if d := time.Until(c.blockUntil); d > 0 {
		return d
	}
	c.blockUntil = time.Time{}
	return 0
}

// tripBlock 记录一次被限流/被拦截，返回本次退避时长。
// 连续触发时逐步拉长，但不超过 maxBackoff。
func (c *Client) tripBlock(base time.Duration) time.Duration {
	c.obsMu.Lock()
	defer c.obsMu.Unlock()
	c.strikes++
	d := base
	if c.strikes > 1 {
		d += time.Duration(c.strikes-1) * 5 * time.Second
	}
	if d > maxBackoff {
		d = maxBackoff
	}
	if until := time.Now().Add(d); until.After(c.blockUntil) {
		c.blockUntil = until
	}
	return d
}

func (c *Client) recordOK() {
	c.obsMu.Lock()
	defer c.obsMu.Unlock()
	c.total++
	c.success++
	c.strikes = 0
	c.pushRecord(requestRecord{ok: true, kind: "ok"})
}

func (c *Client) recordFail(kind string, err error) {
	c.obsMu.Lock()
	defer c.obsMu.Unlock()
	c.total++
	c.failed++
	c.pushRecord(requestRecord{ok: false, kind: kind})
	if err != nil {
		c.lastErr = err.Error()
		c.lastErrAt = time.Now()
	}
}

func (c *Client) pushRecord(r requestRecord) {
	c.recent = append(c.recent, r)
	if len(c.recent) > recentWindow {
		c.recent = c.recent[len(c.recent)-recentWindow:]
	}
}

func (c *Client) noteProbe(ok bool, note string) {
	c.obsMu.Lock()
	defer c.obsMu.Unlock()
	c.lastProbeAt = time.Now()
	c.lastProbeOK = ok
	c.lastProbe = note
}

// Status 返回可观测性快照。
func (c *Client) Status() Status {
	c.mu.RLock()
	st := Status{
		Source:   c.source,
		Host:     c.hosts[c.hostIdx],
		Hosts:    append([]string(nil), c.hosts...),
		LoggedIn: c.loggedIn,
	}
	c.mu.RUnlock()

	c.obsMu.Lock()
	st.Requests = c.total
	st.Success = c.success
	st.Failed = c.failed
	st.Rejected = c.rejected
	st.LastError = c.lastErr
	st.LastProbeOK = c.lastProbeOK
	st.LastProbeNote = c.lastProbe
	if c.total > 0 {
		st.SuccessRate = float64(c.success) / float64(c.total)
	}
	if len(c.recent) > 0 {
		n := 0
		for _, r := range c.recent {
			if r.ok {
				n++
			}
		}
		st.RecentSuccessRate = float64(n) / float64(len(c.recent))
	}
	st.Strikes = c.strikes
	if !c.blockUntil.IsZero() {
		if d := time.Until(c.blockUntil); d > 0 {
			st.Blocked = true
			st.BackoffSeconds = int(math.Ceil(d.Seconds()))
			st.BlockedUntil = c.blockUntil.Format(time.RFC3339)
		}
	}
	if !c.lastErrAt.IsZero() {
		st.LastErrorAt = c.lastErrAt.Format(time.RFC3339)
	}
	if !c.lastProbeAt.IsZero() {
		st.LastProbeAt = c.lastProbeAt.Format(time.RFC3339)
	}
	c.obsMu.Unlock()

	// 记录哪些 host 真的有 Cookie —— 这是"域切换丢登录态"的直接证据。
	for _, h := range st.Hosts {
		u, err := url.Parse(h)
		if err != nil {
			continue
		}
		if len(c.tc.GetCookies(u)) > 0 {
			st.CookieHosts = append(st.CookieHosts, h)
		}
	}
	if st.CookieHosts == nil {
		st.CookieHosts = []string{}
	}
	return st
}

// ---------------------------------------------------------------- 请求

func (c *Client) wait(ctx context.Context) error {
	select {
	case c.sem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}

	c.gate.Lock()
	if d := c.pageGap - time.Since(c.last); d > 0 {
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
	// 退避期内直接快速失败：继续打只会把 Cloudflare 的 1015 打得更久。
	if d := c.blockedFor(); d > 0 {
		c.noteRejected()
		return nil, fmt.Errorf("%w：还需等待约 %d 秒", ErrRateLimited, int(math.Ceil(d.Seconds())))
	}

	if err := c.wait(ctx); err != nil {
		return nil, err
	}
	defer c.release()

	// 排队期间可能已经被别的请求触发了退避，再确认一次，避免继续打上游。
	if d := c.blockedFor(); d > 0 {
		c.noteRejected()
		return nil, fmt.Errorf("%w：还需等待约 %d 秒", ErrRateLimited, int(math.Ceil(d.Seconds())))
	}

	var lastErr error
	for attempt := 0; attempt < len(c.hosts); attempt++ {
		req, err := c.newRequest(ctx, "GET", c.host()+path, nil)
		if err != nil {
			return nil, err
		}

		resp, err := c.tc.Do(req)
		if err != nil {
			c.recordFail("transport", err)
			lastErr = err
			c.rotate()
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if readErr != nil {
			c.recordFail("read", readErr)
			lastErr = readErr
			c.rotate()
			continue
		}

		switch {
		case resp.StatusCode == 404:
			c.recordFail("not_found", ErrNotFound)
			return nil, ErrNotFound
		case resp.StatusCode == 429:
			// Cloudflare 1015：zone 级限流，换 host 是同一个 zone，退避才是正解。
			d := c.tripBlock(retryAfter(resp, defaultRetryAfter))
			err := fmt.Errorf("%w（Cloudflare 1015，已退避 %d 秒）", ErrRateLimited, int(math.Ceil(d.Seconds())))
			c.recordFail("rate_limited", err)
			return nil, err
		case resp.StatusCode == 403 || looksLikeChallenge(body):
			d := c.tripBlock(3 * time.Second)
			err := fmt.Errorf("%w（已退避 %d 秒）", ErrBlocked, int(math.Ceil(d.Seconds())))
			c.recordFail("blocked", err)
			return nil, err
		case resp.StatusCode >= 500:
			lastErr = fmt.Errorf("wenku8 返回 HTTP %d", resp.StatusCode)
			c.recordFail("http_5xx", lastErr)
			c.rotate()
			continue
		case resp.StatusCode >= 400:
			lastErr = fmt.Errorf("wenku8 返回 HTTP %d", resp.StatusCode)
			c.recordFail("http_4xx", lastErr)
			c.rotate()
			continue
		}
		c.recordOK()
		c.preferPrimary()
		return body, nil
	}
	if lastErr == nil {
		lastErr = ErrBlocked
	}
	return nil, lastErr
}

// retryAfter 解析 Retry-After（秒）。Cloudflare 1015 通常给 10 秒。
func retryAfter(resp *fhttp.Response, fallback time.Duration) time.Duration {
	v := strings.TrimSpace(resp.Header.Get("Retry-After"))
	if v == "" {
		return fallback
	}
	if n, err := strconv.Atoi(v); err == nil && n > 0 {
		d := time.Duration(n) * time.Second
		if d > maxBackoff {
			d = maxBackoff
		}
		return d
	}
	if t, err := fhttp.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			if d > maxBackoff {
				d = maxBackoff
			}
			return d
		}
	}
	return fallback
}

// Fetch 抓取任意绝对 URL（图片代理用），返回字节与 Content-Type。
func (c *Client) Fetch(ctx context.Context, rawURL string) ([]byte, string, error) {
	if d := c.blockedFor(); d > 0 {
		c.noteRejected()
		return nil, "", fmt.Errorf("%w：还需等待约 %d 秒", ErrRateLimited, int(math.Ceil(d.Seconds())))
	}
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

// isLoginPageText 判断页面是否是站点要求登录的提示页。
func isLoginPageText(s string) bool {
	return strings.Contains(s, "本站正式关闭")
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

	if isLoginPageText(s) {
		c.markLoginInvalid()
		if c.CookieSource() == CookieNone {
			return nil, ErrLoginRequired
		}
		return nil, fmt.Errorf("%w：站点返回了登录页，请在设置中更新账号或 Cookie", ErrLoginStale)
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

	if resp.StatusCode == 429 {
		d := c.tripBlock(retryAfter(resp, defaultRetryAfter))
		return fmt.Errorf("%w（登录时被 Cloudflare 限流，已退避 %d 秒）", ErrRateLimited, int(math.Ceil(d.Seconds())))
	}

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
	// 把登录得到的 Cookie 镜像到其它域名，避免 rotate 后只剩一个域有登录态。
	c.mirrorCookiesToAllHosts(c.host())
	return nil
}

// mirrorCookiesToAllHosts 把 from 域上的 Cookie 复制到其它 host。
// 站点只认 .net 的登录态，.cc 会 301；镜像只是兜底，不改变现有行为。
func (c *Client) mirrorCookiesToAllHosts(from string) {
	u, err := url.Parse(from)
	if err != nil {
		return
	}
	cookies := c.tc.GetCookies(u)
	if len(cookies) == 0 {
		return
	}
	for _, h := range c.snapshotHosts() {
		if h == from {
			continue
		}
		nu, err := url.Parse(h)
		if err != nil {
			continue
		}
		clones := make([]*fhttp.Cookie, 0, len(cookies))
		for _, ck := range cookies {
			clones = append(clones, &fhttp.Cookie{Name: ck.Name, Value: ck.Value})
		}
		c.tc.SetCookies(nu, clones)
	}
}

// VerifyLogin 用一次列表请求验证登录态是否仍然有效。
func (c *Client) VerifyLogin(ctx context.Context) bool {
	raw, err := c.do(ctx, "/modules/article/toplist.php?sort=allvisit")
	if err != nil {
		return false
	}
	utf8Body, _ := simplifiedchinese.GBK.NewDecoder().Bytes(raw)
	return !isLoginPageText(string(utf8Body))
}

// Probe 做一次轻量列表探测（排行榜第 1 页），用于启动自检。
func (c *Client) Probe(ctx context.Context) error {
	res, err := c.TopList(ctx, "allvisit", 1)
	if err != nil {
		return err
	}
	c.noteProbe(true, fmt.Sprintf("排行榜第 1 页 %d 条", len(res.Items)))
	return nil
}

// ---------------------------------------------------------------- 搜索节流

// waitSearchGap 在已持有 searchGate 的前提下补足两次搜索的间隔。
func (c *Client) waitSearchGap(ctx context.Context) error {
	if d := c.searchGap - time.Since(c.lastSearch); d > 0 {
		select {
		case <-time.After(d):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
