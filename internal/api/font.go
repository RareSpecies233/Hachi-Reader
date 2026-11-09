package api

// 自定义字体：解决"某些字被降级到别的字体"的问题。
// 用户上传一个覆盖更全的 CJK 字体（TTF/OTF/WOFF/WOFF2），服务端存一份，
// 前端用 @font-face 注入，阅读器优先使用它。

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxFontBytes = 80 << 20 // 80MB，足够放一个完整 CJK 字体
	fontMetaFile = "meta.json"
)

type fontMeta struct {
	Name      string `json:"name"`
	Ext       string `json:"ext"`
	Size      int64  `json:"size"`
	UpdatedAt int64  `json:"updatedAt"`
}

func (s *Server) fontDir() string {
	dir := filepath.Join(s.cfg.DataDir, "fonts")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func (s *Server) readFontMeta() (*fontMeta, error) {
	b, err := os.ReadFile(filepath.Join(s.fontDir(), fontMetaFile))
	if err != nil {
		return nil, err
	}
	var m fontMeta
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Server) writeFontMeta(m *fontMeta) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.fontDir(), fontMetaFile), b, 0o644)
}

// sniffFont 用魔数判断真实格式，避免把任意文件当字体存下来。
func sniffFont(head []byte) (ext, format string, ok bool) {
	if len(head) < 4 {
		return "", "", false
	}
	switch {
	case string(head[:4]) == "wOF2":
		return "woff2", "woff2", true
	case string(head[:4]) == "wOFF":
		return "woff", "woff", true
	case string(head[:4]) == "OTTO":
		return "otf", "opentype", true
	case string(head[:4]) == "true", string(head[:4]) == "ttcf",
		head[0] == 0x00 && head[1] == 0x01 && head[2] == 0x00 && head[3] == 0x00:
		return "ttf", "truetype", true
	}
	return "", "", false
}

func fontContentType(ext string) string {
	switch ext {
	case "ttf":
		return "font/ttf"
	case "otf":
		return "font/otf"
	case "woff":
		return "font/woff"
	case "woff2":
		return "font/woff2"
	}
	return "application/octet-stream"
}

// handleFontInfo 返回当前字体的元信息。
func (s *Server) handleFontInfo(w http.ResponseWriter, r *http.Request) {
	m, err := s.readFontMeta()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"font": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"font": m})
}

// handleFontFile 输出字体文件本体。
func (s *Server) handleFontFile(w http.ResponseWriter, r *http.Request) {
	m, err := s.readFontMeta()
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "尚未上传字体")
		return
	}
	path := filepath.Join(s.fontDir(), "custom."+m.Ext)
	f, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "字体文件丢失")
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", fontContentType(m.Ext))
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", fmt.Sprintf(`"%d-%d"`, m.UpdatedAt, m.Size))
	http.ServeContent(w, r, "custom."+m.Ext, time.Unix(m.UpdatedAt, 0), f)
}

// handleFontUpload 接收 multipart 上传（字段名 file）。
func (s *Server) handleFontUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFontBytes+1<<20)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "上传内容过大或格式错误（上限 80MB）")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "缺少字体文件字段 file")
		return
	}
	defer file.Close()

	head := make([]byte, 4)
	if _, err := io.ReadFull(file, head); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "文件太小，不是有效字体")
		return
	}
	ext, _, ok := sniffFont(head)
	if !ok {
		writeError(w, http.StatusBadRequest, "bad_request", "不是有效的字体文件（支持 ttf / otf / woff / woff2）")
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "读取文件失败")
		return
	}

	// 先写临时文件再原子替换，避免上传中断留下半个字体
	tmp, err := os.CreateTemp(s.fontDir(), "upload-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "无法写入数据目录")
		return
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	n, err := io.Copy(tmp, io.LimitReader(file, maxFontBytes))
	if err != nil {
		tmp.Close()
		writeError(w, http.StatusInternalServerError, "internal", "保存失败")
		return
	}
	tmp.Close()
	if n == 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "文件为空")
		return
	}

	// 清掉旧字体（可能是别的扩展名）
	old, _ := s.readFontMeta()
	if old != nil {
		_ = os.Remove(filepath.Join(s.fontDir(), "custom."+old.Ext))
	}

	if err := os.Rename(tmpName, filepath.Join(s.fontDir(), "custom."+ext)); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "保存字体失败")
		return
	}

	name := header.Filename
	if name == "" {
		name = "custom." + ext
	}
	meta := &fontMeta{Name: name, Ext: ext, Size: n, UpdatedAt: time.Now().Unix()}
	if err := s.writeFontMeta(meta); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "写入字体信息失败")
		return
	}

	log.Printf("[font] 已上传自定义字体 %s（%s，%.1f MB）", name, ext, float64(n)/1024/1024)
	writeJSON(w, http.StatusOK, map[string]any{"font": meta})
}

// handleFontDelete 删除自定义字体。
func (s *Server) handleFontDelete(w http.ResponseWriter, r *http.Request) {
	m, err := s.readFontMeta()
	if err == nil && m != nil {
		_ = os.Remove(filepath.Join(s.fontDir(), "custom."+m.Ext))
	}
	_ = os.Remove(filepath.Join(s.fontDir(), fontMetaFile))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// fontCacheControl 让浏览器缓存字体（文件名带版本号时可长缓存）
var _ = strings.TrimSpace
