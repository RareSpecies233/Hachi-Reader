package api

// 自定义字体库：解决"某些字被降级到别的字体"的问题。
//
// 用户可以上传多个覆盖更全的 CJK 字体（TTF/OTF/WOFF/WOFF2），服务端保存成一个
// 字体库（data/fonts/<id>.<ext> + index.json），前端用 @font-face 注入，
// 阅读器按 settings.customFontId 选用其中一个。
//
// 兼容：旧版本只存一个 custom.<ext> + meta.json。首次读取索引时会自动迁移成
// 一条记录；旧的 /api/font* 接口仍然可用（映射到列表里的第一个字体）。

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	maxFontBytes  = 80 << 20 // 80MB，足够放一个完整 CJK 字体
	fontIndexFile = "index.json"
	// 旧版单字体元信息，只用于迁移
	legacyFontMetaFile = "meta.json"
)

// FontEntry 是字体库中的一条记录。ID 用短随机串，文件名即 <id>.<ext>。
type FontEntry struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Ext     string `json:"ext"`
	Size    int64  `json:"size"`
	AddedAt int64  `json:"addedAt"`
}

type fontIndex struct {
	Fonts []FontEntry `json:"fonts"`
}

// 旧版前端/接口的字段形状，保持向后兼容
type legacyFontMeta struct {
	Name      string `json:"name"`
	Ext       string `json:"ext"`
	Size      int64  `json:"size"`
	UpdatedAt int64  `json:"updatedAt"`
}

// 索引与文件的写操作串行化：同一时刻只允许一个上传/删除/迁移在跑。
var fontStoreMu sync.Mutex

func (s *Server) fontDir() string {
	dir := filepath.Join(s.cfg.DataDir, "fonts")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func newFontID() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

/* ---------------------------------------------------------------- 索引读写 */

// readFontIndexLocked 读取 index.json；文件不存在时返回 (nil, false)。
// 调用方必须持有 fontStoreMu。
func (s *Server) readFontIndexLocked() ([]FontEntry, bool) {
	b, err := os.ReadFile(filepath.Join(s.fontDir(), fontIndexFile))
	if err != nil {
		return nil, false
	}
	var idx fontIndex
	if err := json.Unmarshal(b, &idx); err != nil {
		log.Printf("[font] index.json 解析失败，按空索引处理: %v", err)
		return nil, true
	}
	return idx.Fonts, true
}

func (s *Server) writeFontIndexLocked(list []FontEntry) error {
	if list == nil {
		list = []FontEntry{}
	}
	b, err := json.MarshalIndent(fontIndex{Fonts: list}, "", "  ")
	if err != nil {
		return err
	}
	dir := s.fontDir()
	tmp, err := os.CreateTemp(dir, "index-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, filepath.Join(dir, fontIndexFile))
}

// migrateLegacyLocked 把旧的 custom.<ext> + meta.json 迁移成一条索引记录。
// 调用方必须持有 fontStoreMu。
func (s *Server) migrateLegacyLocked() []FontEntry {
	dir := s.fontDir()
	mb, err := os.ReadFile(filepath.Join(dir, legacyFontMetaFile))
	if err != nil {
		return nil
	}
	var m legacyFontMeta
	if err := json.Unmarshal(mb, &m); err != nil || m.Ext == "" {
		return nil
	}
	src := filepath.Join(dir, "custom."+m.Ext)
	st, err := os.Stat(src)
	if err != nil {
		return nil
	}
	id := newFontID()
	dst := filepath.Join(dir, id+"."+m.Ext)
	if err := os.Rename(src, dst); err != nil {
		log.Printf("[font] 迁移旧字体失败: %v", err)
		return nil
	}
	name := strings.TrimSpace(m.Name)
	if name == "" {
		name = "custom." + m.Ext
	}
	added := m.UpdatedAt
	if added == 0 {
		added = time.Now().Unix()
	}
	list := []FontEntry{{ID: id, Name: name, Ext: m.Ext, Size: st.Size(), AddedAt: added}}
	if err := s.writeFontIndexLocked(list); err != nil {
		log.Printf("[font] 写入迁移后的索引失败: %v", err)
		return list
	}
	_ = os.Remove(filepath.Join(dir, legacyFontMetaFile))
	log.Printf("[font] 已把旧字体 %s 迁移到字体库（id=%s）", name, id)
	return list
}

// loadFontIndexLocked 读取索引，必要时迁移旧数据。调用方必须持有 fontStoreMu。
func (s *Server) loadFontIndexLocked() []FontEntry {
	if list, ok := s.readFontIndexLocked(); ok {
		if list == nil {
			list = []FontEntry{}
		}
		return list
	}
	if migrated := s.migrateLegacyLocked(); migrated != nil {
		return migrated
	}
	return []FontEntry{}
}

// findFontLocked 按 id 查找。调用方必须持有 fontStoreMu。
func findFont(list []FontEntry, id string) (int, *FontEntry) {
	for i := range list {
		if list[i].ID == id {
			return i, &list[i]
		}
	}
	return -1, nil
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

/* ---------------------------------------------------------------- 新接口 */

// handleFontsList 返回字体库列表。GET /api/fonts
func (s *Server) handleFontsList(w http.ResponseWriter, r *http.Request) {
	fontStoreMu.Lock()
	list := s.loadFontIndexLocked()
	fontStoreMu.Unlock()
	if list == nil {
		list = []FontEntry{}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"fonts": list})
}

// handleFontUpload 接收 multipart 上传（字段名 file）。POST /api/fonts
// 同名（忽略大小写）视为替换：沿用原 id，只更新文件与元信息，避免列表里堆重复项。
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

	name := strings.TrimSpace(filepath.Base(header.Filename))
	if name == "" || name == "." || name == string(filepath.Separator) {
		name = "font." + ext
	}

	dir := s.fontDir()

	// 先落临时文件，校验/写入都成功后再原子改名，避免上传中断留下半个字体
	tmp, err := os.CreateTemp(dir, "upload-*")
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

	fontStoreMu.Lock()
	defer fontStoreMu.Unlock()

	list := s.loadFontIndexLocked()
	idx := -1
	for i := range list {
		if strings.EqualFold(list[i].Name, name) {
			idx = i
			break
		}
	}

	entry := FontEntry{Name: name, Ext: ext, Size: n, AddedAt: time.Now().Unix()}
	replaced := idx >= 0
	if replaced {
		entry.ID = list[idx].ID
		if list[idx].Ext != "" && list[idx].Ext != ext {
			_ = os.Remove(filepath.Join(dir, entry.ID+"."+list[idx].Ext))
		}
	} else {
		for {
			entry.ID = newFontID()
			if i, _ := findFont(list, entry.ID); i < 0 {
				break
			}
		}
	}

	if err := os.Rename(tmpName, filepath.Join(dir, entry.ID+"."+ext)); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "保存字体失败")
		return
	}

	if replaced {
		list[idx] = entry
	} else {
		list = append(list, entry)
	}
	if err := s.writeFontIndexLocked(list); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "写入字体索引失败")
		return
	}

	log.Printf("[font] 已保存自定义字体 %s（%s，%.1f MB，id=%s，替换=%v）",
		name, ext, float64(n)/1024/1024, entry.ID, replaced)
	writeJSON(w, http.StatusOK, map[string]any{
		"font":     entry,
		"fonts":    list,
		"replaced": replaced,
	})
}

// handleFontDelete 删除字体库中的一个字体。DELETE /api/fonts/{id}
func (s *Server) handleFontDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "缺少字体 id")
		return
	}

	fontStoreMu.Lock()
	defer fontStoreMu.Unlock()

	list := s.loadFontIndexLocked()
	i, entry := findFont(list, id)
	if i < 0 {
		writeError(w, http.StatusNotFound, "not_found", "字体不存在")
		return
	}
	_ = os.Remove(filepath.Join(s.fontDir(), entry.ID+"."+entry.Ext))
	list = append(list[:i], list[i+1:]...)
	if err := s.writeFontIndexLocked(list); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "写入字体索引失败")
		return
	}
	log.Printf("[font] 已删除字体 %s（id=%s）", entry.Name, entry.ID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "fonts": list})
}

// handleFontFile 输出指定字体文件。GET /api/fonts/{id}/file
func (s *Server) handleFontFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	fontStoreMu.Lock()
	list := s.loadFontIndexLocked()
	_, entry := findFont(list, id)
	fontStoreMu.Unlock()
	if entry == nil {
		writeError(w, http.StatusNotFound, "not_found", "字体不存在")
		return
	}

	path := filepath.Join(s.fontDir(), entry.ID+"."+entry.Ext)
	f, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "字体文件丢失")
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", fontContentType(entry.Ext))
	// 前端 URL 带 ?v=<addedAt>，内容变化时 URL 变化，可以放心长缓存
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", fmt.Sprintf(`"%s-%d-%d"`, entry.ID, entry.AddedAt, entry.Size))
	http.ServeContent(w, r, entry.ID+"."+entry.Ext, time.Unix(entry.AddedAt, 0), f)
}

/* ---------------------------------------------------------------- 旧接口兼容 */

func (s *Server) legacyFirstFont() *FontEntry {
	fontStoreMu.Lock()
	defer fontStoreMu.Unlock()
	list := s.loadFontIndexLocked()
	if len(list) == 0 {
		return nil
	}
	e := list[0]
	return &e
}

// handleFontInfo 旧版：返回第一个字体。GET /api/font
func (s *Server) handleFontInfo(w http.ResponseWriter, r *http.Request) {
	e := s.legacyFirstFont()
	if e == nil {
		writeJSON(w, http.StatusOK, map[string]any{"font": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"font": legacyFontMeta{
		Name: e.Name, Ext: e.Ext, Size: e.Size, UpdatedAt: e.AddedAt,
	}})
}

// handleLegacyFontFile 旧版：输出第一个字体。GET /api/font/file
func (s *Server) handleLegacyFontFile(w http.ResponseWriter, r *http.Request) {
	e := s.legacyFirstFont()
	if e == nil {
		writeError(w, http.StatusNotFound, "not_found", "尚未上传字体")
		return
	}
	r.SetPathValue("id", e.ID)
	s.handleFontFile(w, r)
}

// handleLegacyFontUpload 旧版上传：等价于 POST /api/fonts。POST /api/font
func (s *Server) handleLegacyFontUpload(w http.ResponseWriter, r *http.Request) {
	s.handleFontUpload(w, r)
}

// handleLegacyFontDelete 旧版删除：删掉列表里的第一个字体。DELETE /api/font
func (s *Server) handleLegacyFontDelete(w http.ResponseWriter, r *http.Request) {
	e := s.legacyFirstFont()
	if e == nil {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	r.SetPathValue("id", e.ID)
	s.handleFontDelete(w, r)
}
