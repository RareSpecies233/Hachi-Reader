package config

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// PublicURL 是给手机扫码用的地址：
//   - 显式配置 HACHI_PUBLIC_URL 时直接用（支持反代到 https 域名的情况）
//   - 否则用「局域网 IP + 监听端口」，纯 http（局域网内可用，但装 PWA 需要 HTTPS）
func (c Config) PublicURL(token string) string {
	base := strings.TrimRight(c.ExplicitPublicURL, "/")
	if base == "" {
		base = fmt.Sprintf("http://%s%s", c.lanHost(), c.port())
	}
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	q := u.Query()
	if token != "" {
		q.Set("token", token)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// LocalURL 是给本机调试用的地址。
func (c Config) LocalURL(token string) string {
	host := c.Addr
	if strings.HasPrefix(host, ":") {
		host = "localhost" + host
	}
	if strings.HasPrefix(host, "0.0.0.0:") {
		host = "localhost:" + strings.TrimPrefix(host, "0.0.0.0:")
	}
	base := "http://" + host
	if token == "" {
		return base
	}
	return base + "/?token=" + url.QueryEscape(token)
}

func (c Config) port() string {
	if i := strings.LastIndex(c.Addr, ":"); i >= 0 {
		return c.Addr[i:]
	}
	return ":8080"
}

// lanHost 找第一个私有网段的 IPv4；找不到就退回 localhost。
func (c Config) lanHost() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "localhost"
	}

	var fallback string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			if ip.IsPrivate() {
				return ip.String()
			}
			if fallback == "" {
				fallback = ip.String()
			}
		}
	}
	if fallback != "" {
		return fallback
	}
	return "localhost"
}
