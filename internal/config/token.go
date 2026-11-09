package config

// 访问令牌：256 位随机数，base64url 编码后 43 个字符。
// 优先级：-token 参数 > HACHI_TOKEN 环境变量 > data/token 文件 > 首次自动生成。

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// GenerateToken 生成 256 位（32 字节）随机令牌。
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func tokenPath(dataDir string) string {
	return filepath.Join(dataDir, "token")
}

// LoadToken 读取已保存的令牌，不存在返回空。
func LoadToken(dataDir string) string {
	b, err := os.ReadFile(tokenPath(dataDir))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// SaveToken 写入令牌文件（0600）。
func SaveToken(dataDir, token string) error {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(tokenPath(dataDir), []byte(token+"\n"), 0o600)
}

// ResolveToken 决定本次运行使用的令牌。
//   - explicit 非空：直接使用（来自 -token 或 HACHI_TOKEN）
//   - noAuth 为真：不启用鉴权，返回空
//   - 否则读 data/token，没有就生成并落盘
//
// 返回值 created 表示这次是新生成的，调用方应把它打印出来。
func ResolveToken(dataDir, explicit string, noAuth bool) (token string, created bool, err error) {
	if noAuth {
		return "", false, nil
	}
	if explicit != "" {
		return explicit, false, nil
	}
	if t := LoadToken(dataDir); t != "" {
		return t, false, nil
	}

	t, err := GenerateToken()
	if err != nil {
		return "", false, err
	}
	if err := SaveToken(dataDir, t); err != nil {
		return "", false, err
	}
	return t, true, nil
}

// ErrTokenDisabled 表示当前运行没有启用鉴权。
var ErrTokenDisabled = errors.New("当前未启用访问令牌")
