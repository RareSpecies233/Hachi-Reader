package api

// wenku8 可观测性：状态接口 + 启动自检。
//
// 背景：内置公共 Cookie 属于第三方账号，站点随时可能限流或失效。
// 之前这些信息只散落在日志里，前端和用户都只能看到"时好时坏"的观感。
// 这里把"当前凭据来源 / host / 最近列表探测 / 成功率 / 最后错误 / 退避状态"
// 统一暴露出来，便于一眼判断是软件问题还是上游问题。

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"time"

	"hachi/internal/wkk"
)

// handleWk8Status 返回 wenku8 上游的实时状态（需鉴权，路由在鉴权中间件之后）。
func (s *Server) handleWk8Status(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.wk.Status())
}

// startWk8Probe 启动时做一次轻量探测（排行榜第 1 页）。
// 失败必须明确写日志，不能静默降级——否则用户只会看到"有时候能用"。
func (s *Server) startWk8Probe() {
	if os.Getenv("HACHI_NO_STARTUP_PROBE") != "" {
		return
	}
	src := s.wk.CookieSource()
	if src == wkk.CookieNone {
		log.Printf("· 未配置 wenku8 凭据，跳过启动探测；探索与搜索不可用（书籍详情/目录/正文仍可读）")
		return
	}

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		err := s.wk.Probe(ctx)
		st := s.wk.Status()
		switch {
		case err == nil:
			log.Printf("✓ wenku8 列表探测通过（来源=%s host=%s）：%s",
				sourceLabel(src), st.Host, st.LastProbeNote)
		case errors.Is(err, wkk.ErrRateLimited):
			log.Printf("! wenku8 启动探测被限流：%v", err)
			log.Printf("  这是上游 Cloudflare 对出口 IP 的短窗口限流，稍后会自动恢复；频繁出现可降低访问频率或换代理")
		case errors.Is(err, wkk.ErrLoginRequired), errors.Is(err, wkk.ErrLoginStale):
			log.Printf("✗ %s 已失效：探索与搜索将不可用", sourceLabel(src))
			log.Printf("  请配置自己的账号（HACHI_WK8_USER / HACHI_WK8_PASS）")
			log.Printf("  或直接粘贴浏览器 Cookie（HACHI_WK8_COOKIE=...；也可在设置页填写）")
			log.Printf("  书籍详情、目录与正文不受影响")
		case errors.Is(err, wkk.ErrBlocked):
			log.Printf("✗ wenku8 启动探测被拒绝（可能触发了 Cloudflare 防护）：%v", err)
			log.Printf("  可尝试在服务端配置代理（HACHI_PROXY），或稍后重启")
		default:
			log.Printf("✗ wenku8 启动探测失败：%v", err)
			log.Printf("  探索与搜索可能不可用；可用 GET /api/wk8/status 查看详情")
		}
	}()
}

func sourceLabel(src wkk.CookieSource) string {
	switch src {
	case wkk.CookieBundled:
		return "内置公共 Cookie"
	case wkk.CookieCustom:
		return "自定义 Cookie"
	case wkk.CookieAccount:
		return "wenku8 账号登录态"
	default:
		return "wenku8 凭据"
	}
}
