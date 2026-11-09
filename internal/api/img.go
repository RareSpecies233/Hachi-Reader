package api

// 图片代理：wenku8 的插图托管在第三方图床，且部分图床会校验来源。
// 统一由服务端抓取并落盘缓存，好处是：离线可读、省流量、绕开防盗链。
//
// 安全：只允许 http(s)，拒绝内网/回环地址，防止被当成 SSRF 跳板。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type imageCache struct {
	dir      string
	allowAny bool
	sem      chan struct{}
}

func newImageCache(dataDir string, allowAny bool) *imageCache {
	dir := filepath.Join(dataDir, "img")
	_ = os.MkdirAll(dir, 0o755)
	return &imageCache{dir: dir, allowAny: allowAny, sem: make(chan struct{}, 6)}
}

var errForbiddenHost = errors.New("不允许的图片地址")

func (c *imageCache) key(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// allowedHost 判断域名是否放行。默认只放行 wenku8 系列与常见图床前缀。
func (c *imageCache) allowedHost(host string) bool {
	if c.allowAny {
		return true
	}
	h := strings.ToLower(host)
	if h == "img.wenku8.com" || strings.HasSuffix(h, ".wenku8.com") ||
		strings.HasSuffix(h, ".wenku8.net") || strings.HasSuffix(h, ".wenku8.cc") {
		return true
	}
	for _, prefix := range []string{"pic.", "img.", "image."} {
		if strings.HasPrefix(h, prefix) {
			return true
		}
	}
	return false
}

// checkHost 同时做私网地址检查。
func (c *imageCache) checkHost(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return errForbiddenHost
	}
	host := u.Hostname()
	if host == "" || !c.allowedHost(host) {
		return errForbiddenHost
	}

	ips, err := net.LookupIP(host)
	if err != nil {
		// 解析失败时交给实际请求去失败，避免 DNS 抖动导致图片全挂
		return nil
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			return errForbiddenHost
		}
	}
	return nil
}

type fetchFunc func(ctx context.Context, rawURL string) ([]byte, string, error)

// Get 先查磁盘缓存，未命中再抓取并落盘。
func (c *imageCache) Get(ctx context.Context, rawURL string, fetch fetchFunc) ([]byte, string, error) {
	if err := c.checkHost(rawURL); err != nil {
		return nil, "", err
	}

	k := c.key(rawURL)
	binPath := filepath.Join(c.dir, k+".bin")
	typePath := filepath.Join(c.dir, k+".type")

	if data, err := os.ReadFile(binPath); err == nil && len(data) > 0 {
		ct := "image/jpeg"
		if b, err := os.ReadFile(typePath); err == nil && len(b) > 0 {
			ct = strings.TrimSpace(string(b))
		}
		return data, ct, nil
	}

	select {
	case c.sem <- struct{}{}:
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
	defer func() { <-c.sem }()

	// 再查一次，避免并发重复下载
	if data, err := os.ReadFile(binPath); err == nil && len(data) > 0 {
		return data, "image/jpeg", nil
	}

	data, ct, err := fetch(ctx, rawURL)
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 || len(data) > 24<<20 {
		return nil, "", fmt.Errorf("图片数据异常")
	}
	if ct == "" {
		ct = http.DetectContentType(data)
	}
	if !strings.HasPrefix(ct, "image/") && !strings.HasPrefix(ct, "application/octet-stream") {
		return nil, "", fmt.Errorf("响应不是图片: %s", ct)
	}
	if strings.HasPrefix(ct, "application/octet-stream") {
		ct = http.DetectContentType(data)
	}

	// 原子写，避免半截文件被当成有效缓存
	tmp, err := os.CreateTemp(c.dir, k+".*.tmp")
	if err == nil {
		if _, werr := tmp.Write(data); werr == nil {
			_ = tmp.Close()
			_ = os.Rename(tmp.Name(), binPath)
			_ = os.WriteFile(typePath, []byte(ct), 0o644)
		} else {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}
	return data, ct, nil
}

func (s *Server) handleImage(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("u")
	if raw == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "缺少图片地址参数 u")
		return
	}

	data, ct, err := s.img.Get(r.Context(), raw, s.wk.Fetch)
	if err != nil {
		if errors.Is(err, errForbiddenHost) {
			writeError(w, http.StatusForbidden, "forbidden", "不允许代理该地址")
			return
		}
		writeError(w, http.StatusBadGateway, "upstream_error", "图片加载失败")
		return
	}

	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	_, _ = w.Write(data)
}
