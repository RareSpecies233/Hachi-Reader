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
	"syscall"
	"time"

	hachi "hachi"
	"hachi/internal/api"
	"hachi/internal/config"
	"hachi/internal/store"
	"hachi/internal/wkk"
)

// version 由 -ldflags "-X main.version=…" 注入
var version = api.Version

func main() {
	var (
		addr    = flag.String("addr", "", "监听地址，如 :8080")
		dataDir = flag.String("data", "", "数据目录")
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

	if err := run(cfg); err != nil {
		log.Fatalf("启动失败: %v", err)
	}
}

func run(cfg config.Config) error {
	log.Printf("Hachi Reader %s", version)
	log.Printf("数据目录: %s", cfg.DataDir)

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

	wk, err := wkk.NewClient(wkk.Options{
		Username: cfg.WK8User,
		Password: cfg.WK8Pass,
		Proxy:    cfg.Proxy,
		Profile:  cfg.Profile,
		Timeout:  cfg.Timeout,
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
			log.Printf("✓ 已登录 wenku8，探索与搜索可用")
		}
	} else {
		log.Printf("· 未配置 wenku8 账号（HACHI_WK8_USER / HACHI_WK8_PASS）")
		log.Printf("  探索与搜索需要登录，其余功能不受影响")
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
