package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config 全部来自环境变量，便于 Docker / systemd / launchd / Windows 服务统一注入。
type Config struct {
	Addr    string
	DataDir string
	Token   string

	WK8User string
	WK8Pass string
	// Proxy 可选，形如 http://127.0.0.1:7890；服务器能直连 wenku8 时留空即可。
	Proxy   string
	Profile string
	Timeout time.Duration

	// 是否允许 /api/img 代理任意图片域名（默认只放行已知图床）
	AllowAnyImageHost bool

	// Dev 为真时直接从磁盘 web/ 读取前端，改代码刷新即可，无需重新编译。
	Dev bool

	// WK8Cookie 直接注入的 wenku8 Cookie（优先于账号登录）
	WK8Cookie string
	// NoBundledCookie 关闭内置公共 Cookie 兜底
	NoBundledCookie bool
	// NoAuth 关闭访问令牌校验
	NoAuth bool
	// ExplicitPublicURL 扫码/分享用的外部地址（反代到 https 域名时设置）
	ExplicitPublicURL string

	// CacheTTL 内容接口的服务端缓存时长，0 表示关闭
	CacheTTL time.Duration
	// CacheSize 缓存条目上限
	CacheSize int
}

func Load() Config {
	c := Config{
		Addr:              env("HACHI_ADDR", ":8080"),
		DataDir:           env("HACHI_DATA", "./data"),
		Token:             os.Getenv("HACHI_TOKEN"),
		WK8User:           os.Getenv("HACHI_WK8_USER"),
		WK8Pass:           os.Getenv("HACHI_WK8_PASS"),
		Proxy:             os.Getenv("HACHI_PROXY"),
		Profile:           env("HACHI_PROFILE", "safari_ios"),
		WK8Cookie:         os.Getenv("HACHI_WK8_COOKIE"),
		ExplicitPublicURL: os.Getenv("HACHI_PUBLIC_URL"),
		CacheTTL:          10 * time.Minute,
		CacheSize:         512,
		Timeout:           25 * time.Second,
	}
	if v := os.Getenv("HACHI_TIMEOUT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.Timeout = time.Duration(n) * time.Second
		}
	}
	if v := os.Getenv("HACHI_NO_BUNDLED_COOKIE"); v != "" {
		c.NoBundledCookie = strings.EqualFold(v, "1") || strings.EqualFold(v, "true")
	}
	if v := os.Getenv("HACHI_CACHE_TTL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			c.CacheTTL = time.Duration(n) * time.Second
		}
	}
	if v := os.Getenv("HACHI_CACHE_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.CacheSize = n
		}
	}
	if v := os.Getenv("HACHI_NO_AUTH"); v != "" {
		c.NoAuth = strings.EqualFold(v, "1") || strings.EqualFold(v, "true")
	}
	if v := os.Getenv("HACHI_DEV"); v != "" {
		c.Dev = strings.EqualFold(v, "1") || strings.EqualFold(v, "true")
	}
	if v := os.Getenv("HACHI_ALLOW_ANY_IMAGE_HOST"); v != "" {
		c.AllowAnyImageHost = strings.EqualFold(v, "1") || strings.EqualFold(v, "true")
	}
	if abs, err := filepath.Abs(c.DataDir); err == nil {
		c.DataDir = abs
	}
	return c
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ---------------------------------------------------------------- wenku8 凭据

// Credentials 以本地文件形式保存 wenku8 账号，权限 0600。
// 单用户自托管场景下这样最省事；请确保数据目录不对公网暴露。
type Credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func credentialsPath(dataDir string) string {
	return filepath.Join(dataDir, "wenku8.json")
}

// LoadCredentials 读取已保存的账号，不存在时返回空结构。
func LoadCredentials(dataDir string) Credentials {
	var c Credentials
	b, err := os.ReadFile(credentialsPath(dataDir))
	if err != nil {
		return c
	}
	_ = json.Unmarshal(b, &c)
	return c
}

// SaveCredentials 写入账号文件（0600）。
func SaveCredentials(dataDir string, c Credentials) error {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(credentialsPath(dataDir), b, 0o600)
}

// ClearCredentials 删除保存的账号。
func ClearCredentials(dataDir string) error {
	err := os.Remove(credentialsPath(dataDir))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ---------------------------------------------------------------- wenku8 Cookie

func cookiePath(dataDir string) string {
	return filepath.Join(dataDir, "wenku8.cookie")
}

// LoadCookie 读取设置页保存的 Cookie。
func LoadCookie(dataDir string) string {
	b, err := os.ReadFile(cookiePath(dataDir))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// SaveCookie 保存 Cookie（0600）。
func SaveCookie(dataDir, cookie string) error {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(cookiePath(dataDir), []byte(cookie+"\n"), 0o600)
}

// ClearCookie 删除保存的 Cookie。
func ClearCookie(dataDir string) error {
	err := os.Remove(cookiePath(dataDir))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
