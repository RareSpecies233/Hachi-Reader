package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	hachi "hachi"
	"hachi/internal/api"
	"hachi/internal/banner"
	"hachi/internal/config"
	"hachi/internal/qr"
	"hachi/internal/store"
	"hachi/internal/wkk"
)

// version 由 -ldflags "-X main.version=…" 注入
var version = api.Version

func main() {
	var (
		addr    = flag.String("addr", "", "监听地址，如 :8080")
		dataDir = flag.String("data", "", "数据目录")
		token   = flag.String("token", "", "访问令牌（留空则读取 data/token 或自动生成）")
		noAuth  = flag.Bool("no-auth", false, "关闭访问令牌校验（仅限可信局域网）")
	)
	flag.Parse()

	log.SetFlags(log.Ltime)

	cfg := config.Load()
	if *addr != "" {
		cfg.Addr = *addr
	}
	if *dataDir != "" {
		cfg.DataDir = *dataDir
	}
	if *token != "" {
		cfg.Token = *token
	}

	if err := run(cfg, *noAuth || cfg.NoAuth); err != nil {
		log.Fatalf("启动失败: %v", err)
	}
}

func run(cfg config.Config, noAuth bool) error {
	banner.Print(version)
	log.Printf("数据目录: %s", cfg.DataDir)

	// 访问令牌：参数 > 环境变量 > data/token > 首次生成
	tok, created, err := config.ResolveToken(cfg.DataDir, cfg.Token, noAuth)
	if err != nil {
		return fmt.Errorf("初始化访问令牌失败: %w", err)
	}
	cfg.Token = tok
	if noAuth {
		log.Printf("⚠️  已关闭访问令牌校验，任何能访问端口的人都可以使用")
	} else {
		if created {
			log.Printf("✓ 已生成访问令牌（256 位），并保存到 %s", filepath.Join(cfg.DataDir, "token"))
		}
		log.Printf("")
		log.Printf("   访问令牌: %s", tok)
		log.Printf("   首次访问时粘贴到解锁页即可；也可用 ?token=… 直接进入")
		log.Printf("")
	}

	st, err := store.Open(filepath.Join(cfg.DataDir, "hachi.db"))
	if err != nil {
		return fmt.Errorf("打开数据库失败: %w", err)
	}
	defer st.Close()

	// 环境变量优先；没有则读 data/wenku8.json（设置页保存的账号）
	if cfg.WK8User == "" {
		if cred := config.LoadCredentials(cfg.DataDir); cred.Username != "" {
			cfg.WK8User, cfg.WK8Pass = cred.Username, cred.Password
		}
	}

	// Cookie 优先级：自定义 > 账号登录 > 内置公共 Cookie
	if cfg.WK8Cookie == "" {
		cfg.WK8Cookie = config.LoadCookie(cfg.DataDir)
	}

	wk, err := wkk.NewClient(wkk.Options{
		Username:         cfg.WK8User,
		Password:         cfg.WK8Pass,
		Cookie:           cfg.WK8Cookie,
		UseBundledCookie: !cfg.NoBundledCookie,
		Proxy:            cfg.Proxy,
		Profile:          cfg.Profile,
		Timeout:          cfg.Timeout,
	})
	if err != nil {
		return err
	}

	// 登录是可选能力：不配账号时仍可读书籍详情、目录与正文。
	if cfg.WK8User != "" && cfg.WK8Pass != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		err := wk.Login(ctx)
		cancel()
		if err != nil {
			log.Printf("⚠️  wenku8 登录失败：%v", err)
			log.Printf("   探索与搜索将不可用；书籍详情与正文仍可离线读取。")
		} else {
			log.Printf("· wenku8 登录成功（列表可用性由启动探测确认）")
		}
	} else {
		switch wk.CookieSource() {
		case wkk.CookieCustom:
			log.Printf("· 将使用自定义 Cookie 访问 wenku8（列表可用性由启动探测确认）")
		case wkk.CookieBundled:
			log.Printf("· 未配置账号，将使用内置公共 Cookie 访问列表页")
			log.Printf("  该 Cookie 来自 LightNovelReader 项目，可能随时失效；可用 HACHI_WK8_USER/PASS 覆盖")
		default:
			log.Printf("· 未配置 wenku8 账号，探索与搜索将不可用")
		}
	}

	var static fs.FS
	if cfg.Dev {
		static = os.DirFS("web")
		log.Printf("· 开发模式：前端从 ./web 实时读取")
	} else {
		sub, err := fs.Sub(hachi.FS, "web")
		if err != nil {
			return fmt.Errorf("加载内嵌前端失败: %w", err)
		}
		static = sub
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.New(cfg, st, wk, static).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return fmt.Errorf("监听 %s 失败: %w", cfg.Addr, err)
	}

	// 扫码直达：手机相机扫描后自动带上令牌，免去输入
	if tok != "" {
		scanURL := cfg.PublicURL(tok)
		log.Printf("手机扫码直接进入（相机对准下方二维码）：")
		if err := qr.Print(scanURL); err != nil {
			log.Printf("（二维码生成失败：%v）", err)
		}
		log.Printf("   %s", scanURL)
		log.Printf("   本机: %s", cfg.LocalURL(tok))
		if strings.HasPrefix(scanURL, "https://") {
			log.Printf("   提示：HTTPS 下可直接用 Safari「添加到主屏幕」安装为 PWA")
		} else {
			log.Printf("   提示：扫码即可阅读；「添加到主屏幕」需要 HTTPS 域名（设置 HACHI_PUBLIC_URL）")
		}
		log.Printf("")
	}

	go func() {
		log.Printf("✓ 服务已启动: http://localhost%s", cfg.Addr)
		if cfg.Token != "" {
			log.Printf("  已启用访问令牌，首次访问请带 ?token=… 或在设置里填写")
		}
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("HTTP 服务异常: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Printf("正在关闭…")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(ctx)
}
