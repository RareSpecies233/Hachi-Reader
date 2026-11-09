// Package qr 在终端打印二维码，手机相机扫描即可带着令牌直接进入。
package qr

import (
	"fmt"
	"os"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

// Print 输出二维码。
//
// 终端是 TTY 时用 ANSI 黑白背景绘制——否则深色主题下"白"模块会变成深色，
// 极性反转会让部分扫码器识别失败。管道/重定向时退回字符块输出。
func Print(url string) error {
	q, err := qrcode.New(url, qrcode.Medium)
	if err != nil {
		return err
	}
	q.DisableBorder = false // 必须保留静默区，否则扫不出来

	bitmap := q.Bitmap()
	tty := isTTY(os.Stdout)

	var sb strings.Builder
	for _, row := range bitmap {
		for _, dark := range row {
			switch {
			case tty && dark:
				sb.WriteString("\x1b[40m  \x1b[0m") // 黑底
			case tty && !dark:
				sb.WriteString("\x1b[47m  \x1b[0m") // 白底
			case dark:
				sb.WriteString("██")
			default:
				sb.WriteString("  ")
			}
		}
		sb.WriteString("\n")
	}
	fmt.Print(sb.String())
	return nil
}

func isTTY(f *os.File) bool {
	st, err := f.Stat()
	if err != nil {
		return false
	}
	return st.Mode()&os.ModeCharDevice != 0
}
