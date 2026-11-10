package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hachi/internal/config"
)

/* ---------------------------------------------------------------- 测试辅助 */

func newTestFontServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	s := &Server{cfg: config.Config{DataDir: dir}, mux: http.NewServeMux()}
	s.routes()
	return s, dir
}

func fontUploadBody(t *testing.T, name string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(data); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	return &buf, mw.FormDataContentType()
}

func doFontReq(s *Server, method, path, contentType string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	return rec
}

func uploadTestFont(t *testing.T, s *Server, name string, data []byte) fontUploadResp {
	t.Helper()
	body, ct := fontUploadBody(t, name, data)
	rec := doFontReq(s, http.MethodPost, "/api/fonts", ct, body.Bytes())
	if rec.Code != http.StatusOK {
		t.Fatalf("上传 %s 失败: %d %s", name, rec.Code, rec.Body.String())
	}
	var resp fontUploadResp
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("解析上传响应: %v", err)
	}
	return resp
}

func listTestFonts(t *testing.T, s *Server) []FontEntry {
	t.Helper()
	rec := doFontReq(s, http.MethodGet, "/api/fonts", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("列表失败: %d", rec.Code)
	}
	var resp struct {
		Fonts []FontEntry `json:"fonts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("解析列表: %v", err)
	}
	return resp.Fonts
}

type fontUploadResp struct {
	Font     FontEntry   `json:"font"`
	Fonts    []FontEntry `json:"fonts"`
	Replaced bool        `json:"replaced"`
}

// 合法的最小 TTF 头 + 一点负载；服务端只校验魔数，不解析字形。
func fakeTTF(payload string) []byte {
	return append([]byte{0x00, 0x01, 0x00, 0x00}, []byte(payload)...)
}

/* ---------------------------------------------------------------- 用例 */

func TestFontUploadListFileDelete(t *testing.T) {
	s, dir := newTestFontServer(t)
	data := fakeTTF("hello-font")

	resp := uploadTestFont(t, s, "MySong.ttf", data)
	if resp.Font.ID == "" {
		t.Fatal("上传响应缺少 id")
	}
	if resp.Font.Name != "MySong.ttf" || resp.Font.Ext != "ttf" || resp.Font.Size != int64(len(data)) {
		t.Fatalf("元信息不对: %+v", resp.Font)
	}
	if len(resp.Fonts) != 1 {
		t.Fatalf("列表长度应为 1，实际 %d", len(resp.Fonts))
	}

	list := listTestFonts(t, s)
	if len(list) != 1 || list[0].ID != resp.Font.ID {
		t.Fatalf("列表内容不对: %+v", list)
	}

	rec := doFontReq(s, http.MethodGet, "/api/fonts/"+resp.Font.ID+"/file?v=1", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("取文件失败: %d", rec.Code)
	}
	if !bytes.Equal(rec.Body.Bytes(), data) {
		t.Fatal("返回的字体内容与上传不一致")
	}
	if ct := rec.Header().Get("Content-Type"); ct != "font/ttf" {
		t.Fatalf("Content-Type 应为 font/ttf，实际 %q", ct)
	}
	if rec.Header().Get("ETag") == "" {
		t.Fatal("字体文件应带 ETag")
	}
	if _, err := os.Stat(filepath.Join(dir, "fonts", resp.Font.ID+".ttf")); err != nil {
		t.Fatalf("字体文件未落盘: %v", err)
	}

	rec = doFontReq(s, http.MethodDelete, "/api/fonts/"+resp.Font.ID, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("删除失败: %d %s", rec.Code, rec.Body.String())
	}
	var delResp struct {
		Fonts []FontEntry `json:"fonts"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &delResp)
	if len(delResp.Fonts) != 0 {
		t.Fatalf("删除后列表应为空，实际 %+v", delResp.Fonts)
	}
	if _, err := os.Stat(filepath.Join(dir, "fonts", resp.Font.ID+".ttf")); !os.IsNotExist(err) {
		t.Fatal("删除后字体文件应被移除")
	}
	if rec := doFontReq(s, http.MethodGet, "/api/fonts/"+resp.Font.ID+"/file", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("删除后取文件应为 404，实际 %d", rec.Code)
	}
}

func TestFontRejectsNonFontMagic(t *testing.T) {
	s, _ := newTestFontServer(t)
	body, ct := fontUploadBody(t, "evil.ttf", []byte("this is definitely not a font"))
	rec := doFontReq(s, http.MethodPost, "/api/fonts", ct, body.Bytes())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("非字体文件应返回 400，实际 %d", rec.Code)
	}
	if list := listTestFonts(t, s); len(list) != 0 {
		t.Fatalf("被拒绝的上传不应留下记录: %+v", list)
	}
}

func TestFontDuplicateNameReplacesEntry(t *testing.T) {
	s, dir := newTestFontServer(t)
	first := fakeTTF("version-one")
	second := fakeTTF("version-two-longer")

	r1 := uploadTestFont(t, s, "Same.ttf", first)
	if r1.Replaced {
		t.Fatal("首次上传不应标记为替换")
	}
	r2 := uploadTestFont(t, s, "same.ttf", second) // 大小写不同也算同名
	if !r2.Replaced {
		t.Fatal("同名上传应标记为替换")
	}
	if r2.Font.ID != r1.Font.ID {
		t.Fatalf("替换应沿用原 id，%s != %s", r2.Font.ID, r1.Font.ID)
	}
	list := listTestFonts(t, s)
	if len(list) != 1 {
		t.Fatalf("同名上传后列表应仍为 1，实际 %d", len(list))
	}
	if list[0].Size != int64(len(second)) {
		t.Fatalf("替换后 size 应为新文件大小，实际 %d", list[0].Size)
	}

	rec := doFontReq(s, http.MethodGet, "/api/fonts/"+r1.Font.ID+"/file", "", nil)
	if !bytes.Equal(rec.Body.Bytes(), second) {
		t.Fatal("替换后应返回新字体内容")
	}

	// 目录里只应留下 index.json + 一个字体文件
	entries, _ := os.ReadDir(filepath.Join(dir, "fonts"))
	fontFiles := 0
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".ttf") || strings.HasSuffix(e.Name(), ".otf") ||
			strings.HasSuffix(e.Name(), ".woff") || strings.HasSuffix(e.Name(), ".woff2") {
			fontFiles++
		}
	}
	if fontFiles != 1 {
		t.Fatalf("字体文件数应为 1，实际 %d", fontFiles)
	}
}

func TestFontSameNameDifferentExtReplaces(t *testing.T) {
	s, dir := newTestFontServer(t)
	r1 := uploadTestFont(t, s, "Dup.ttf", fakeTTF("ttf"))
	woff := append([]byte("wOFF"), []byte("woff-body")...)
	r2 := uploadTestFont(t, s, "Dup.ttf", woff)
	if r2.Font.ID != r1.Font.ID || r2.Font.Ext != "woff" {
		t.Fatalf("换扩展名替换异常: %+v", r2.Font)
	}
	if _, err := os.Stat(filepath.Join(dir, "fonts", r1.Font.ID+".ttf")); !os.IsNotExist(err) {
		t.Fatal("替换后旧扩展名文件应被删除")
	}
}

func TestFontLegacyMigration(t *testing.T) {
	s, dir := newTestFontServer(t)
	fontsDir := filepath.Join(dir, "fonts")
	if err := os.MkdirAll(fontsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := fakeTTF("legacy-font")
	if err := os.WriteFile(filepath.Join(fontsDir, "custom.ttf"), legacy, 0o644); err != nil {
		t.Fatal(err)
	}
	meta := `{"name":"OldFont.ttf","ext":"ttf","size":` + itoa(len(legacy)) + `,"updatedAt":1700000000}`
	if err := os.WriteFile(filepath.Join(fontsDir, "meta.json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}

	list := listTestFonts(t, s)
	if len(list) != 1 {
		t.Fatalf("迁移后应有 1 条记录，实际 %d", len(list))
	}
	if list[0].Name != "OldFont.ttf" || list[0].Size != int64(len(legacy)) || list[0].AddedAt != 1700000000 {
		t.Fatalf("迁移后的元信息不对: %+v", list[0])
	}
	if _, err := os.Stat(filepath.Join(fontsDir, "custom.ttf")); !os.IsNotExist(err) {
		t.Fatal("迁移后旧文件应被改名")
	}
	if _, err := os.Stat(filepath.Join(fontsDir, "meta.json")); !os.IsNotExist(err) {
		t.Fatal("迁移后旧 meta.json 应被删除")
	}
	if _, err := os.Stat(filepath.Join(fontsDir, "index.json")); err != nil {
		t.Fatalf("迁移后应写入 index.json: %v", err)
	}
	rec := doFontReq(s, http.MethodGet, "/api/fonts/"+list[0].ID+"/file", "", nil)
	if !bytes.Equal(rec.Body.Bytes(), legacy) {
		t.Fatal("迁移后字体内容应保持不变")
	}
}

func TestFontLegacyEndpoints(t *testing.T) {
	s, _ := newTestFontServer(t)
	data := fakeTTF("legacy-api")

	body, ct := fontUploadBody(t, "Legacy.ttf", data)
	rec := doFontReq(s, http.MethodPost, "/api/font", ct, body.Bytes())
	if rec.Code != http.StatusOK {
		t.Fatalf("旧上传接口失败: %d %s", rec.Code, rec.Body.String())
	}

	rec = doFontReq(s, http.MethodGet, "/api/font", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("旧信息接口失败: %d", rec.Code)
	}
	var info struct {
		Font *legacyFontMeta `json:"font"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &info)
	if info.Font == nil || info.Font.Name != "Legacy.ttf" || info.Font.UpdatedAt == 0 {
		t.Fatalf("旧信息接口字段不对: %+v", info.Font)
	}

	rec = doFontReq(s, http.MethodGet, "/api/font/file", "", nil)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), data) {
		t.Fatalf("旧文件接口异常: %d", rec.Code)
	}

	if rec := doFontReq(s, http.MethodDelete, "/api/font", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("旧删除接口失败: %d", rec.Code)
	}
	if list := listTestFonts(t, s); len(list) != 0 {
		t.Fatalf("旧删除接口后列表应为空: %+v", list)
	}
}

func TestFontDeleteMissingAndBadID(t *testing.T) {
	s, _ := newTestFontServer(t)
	if rec := doFontReq(s, http.MethodDelete, "/api/fonts/nope", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("删除不存在的字体应 404，实际 %d", rec.Code)
	}
	if rec := doFontReq(s, http.MethodGet, "/api/fonts/nope/file", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("取不存在的字体应 404，实际 %d", rec.Code)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
