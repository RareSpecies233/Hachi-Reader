// Package banner 打印启动时的 FIGlet 大标题。
package banner

import (
	"fmt"

	"github.com/common-nighthawk/go-figure"
)

// Print 输出 ASCII 大标题与一行副标题。
// 字体用 "small"：在手机终端、Docker 日志、Windows 控制台里都不会超出常见宽度。
func Print(version string) {
	fig := figure.NewFigure("HACHI READER", "small", true)
	fmt.Println()
	fmt.Print(fig.String())
	fmt.Printf("  轻小说阅读器 · v%s · self-hosted\n\n", version)
}

// PrintWide 供宽屏终端使用的大号字体。
func PrintWide(version string) {
	fig := figure.NewFigure("HACHI", "standard", true)
	fmt.Println()
	fmt.Print(fig.String())
	fmt.Printf("  Reader v%s\n\n", version)
}
