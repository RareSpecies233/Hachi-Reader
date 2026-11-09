// Package hachi 只做一件事：把 web/ 下的前端静态资源打进二进制。
// 部署时只需要一个可执行文件，不需要额外拷贝前端目录。
package hachi

import "embed"

//go:embed all:web
var FS embed.FS
