package wkk

import (
	"os"
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
	"golang.org/x/text/encoding/simplifiedchinese"
)

// 离线解析测试：夹具是 2026-11 从站上抓下来的真实页面（GBK 原文）。
func loadDoc(t *testing.T, name string) *goquery.Document {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("读取夹具 %s 失败: %v", name, err)
	}
	utf8Body, err := simplifiedchinese.GBK.NewDecoder().Bytes(raw)
	if err != nil {
		t.Fatalf("GBK 解码失败: %v", err)
	}
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(string(utf8Body)))
	if err != nil {
		t.Fatalf("解析 HTML 失败: %v", err)
	}
	return doc
}

func TestParseBook(t *testing.T) {
	doc := loadDoc(t, "book_1.html")
	book, err := parseBook(doc, "1")
	if err != nil {
		t.Fatalf("parseBook: %v", err)
	}

	cases := []struct {
		name string
		got  string
		want string
	}{
		{"标题", book.Title, "文学少女"},
		{"作者", book.Author, "野村美月"},
		{"文库", book.Publisher, "Fami通文库"},
		{"更新日期", book.UpdatedAt, "2022-02-27"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s = %q, 期望 %q", c.name, c.got, c.want)
		}
	}

	if book.WordCount != 2015475 {
		t.Errorf("字数 = %d, 期望 2015475", book.WordCount)
	}
	if !book.IsComplete {
		t.Error("应为已完结")
	}
	if !book.IsAnime {
		t.Error("应识别为已动画化")
	}
	if !strings.HasPrefix(book.Cover, "http") {
		t.Errorf("封面地址异常: %q", book.Cover)
	}
	if !strings.Contains(book.Description, "文艺社") {
		t.Errorf("简介未解析出来: %q", truncate(book.Description, 60))
	}
	if len(book.Tags) < 3 {
		t.Errorf("标签数量异常: %v", book.Tags)
	}
}

func TestParseVolumes(t *testing.T) {
	doc := loadDoc(t, "index_1.html")
	vols, err := parseVolumes(doc)
	if err != nil {
		t.Fatalf("parseVolumes: %v", err)
	}
	if len(vols) != 18 {
		t.Fatalf("卷数 = %d, 期望 18", len(vols))
	}
	if !strings.Contains(vols[0].Title, "渴望死亡的小丑") {
		t.Errorf("第一卷标题异常: %q", vols[0].Title)
	}

	total := 0
	seen := map[string]bool{}
	lastIndex := -1
	for _, v := range vols {
		for _, ch := range v.Chapters {
			if seen[ch.ID] {
				t.Errorf("章节 %s 重复", ch.ID)
			}
			seen[ch.ID] = true
			if ch.Index != lastIndex+1 {
				t.Errorf("章节序号不连续: %s 的 index=%d, 上一个=%d", ch.Title, ch.Index, lastIndex)
			}
			lastIndex = ch.Index
			total++
		}
	}
	if total != 213 {
		t.Errorf("章节总数 = %d, 期望 213", total)
	}
	if vols[0].ID == "" {
		t.Error("卷 id 为空")
	}
}

func TestParseChapter(t *testing.T) {
	doc := loadDoc(t, "chapter_2.html")
	cc, err := parseChapter(doc, "2")
	if err != nil {
		t.Fatalf("parseChapter: %v", err)
	}

	if !strings.Contains(cc.Title, "序章") {
		t.Errorf("标题异常: %q", cc.Title)
	}
	if len(cc.Blocks) < 20 {
		t.Errorf("段落数过少: %d", len(cc.Blocks))
	}

	// 首段应是录入组声明，且不应包含站点水印
	if cc.Blocks[0].Type != "text" {
		t.Errorf("首块类型 = %q", cc.Blocks[0].Type)
	}
	for _, b := range cc.Blocks {
		if strings.Contains(b.Text, "本文来自 轻小说文库") {
			t.Errorf("站点水印未清洗: %q", b.Text)
		}
		if strings.Contains(b.Text, "\u00a0") {
			t.Errorf("残留不间断空格: %q", b.Text)
		}
	}

	if cc.Next != "3" {
		t.Errorf("next = %q, 期望 3", cc.Next)
	}
	// 第一章的"上一页"指向 index.htm，应被丢弃
	if cc.Prev != "" {
		t.Errorf("prev = %q, 期望空", cc.Prev)
	}
}

func TestParseChapterWithImages(t *testing.T) {
	doc := loadDoc(t, "chapter_ill.html")
	cc, err := parseChapter(doc, "24315")
	if err != nil {
		t.Fatalf("parseChapter: %v", err)
	}
	images := 0
	for _, b := range cc.Blocks {
		if b.Type == "image" {
			images++
			if !strings.HasPrefix(b.Src, "http") {
				t.Errorf("插图地址异常: %q", b.Src)
			}
		}
	}
	if images != 14 {
		t.Errorf("插图数 = %d, 期望 14", images)
	}
}

func TestURLEncodeGBK(t *testing.T) {
	got := urlEncodeGBK("文学少女")
	// GBK: 文=0xCEC4 学=0xD1A7 少=0xC9D9 女=0xC5AE
	want := "%CE%C4%D1%A7%C9%D9%C5%AE"
	if got != want {
		t.Errorf("urlEncodeGBK = %q, 期望 %q", got, want)
	}
}

func TestBookShard(t *testing.T) {
	for id, want := range map[string]string{"1": "0", "999": "0", "1000": "1", "24315": "24"} {
		if got := bookShard(id); got != want {
			t.Errorf("bookShard(%s) = %s, 期望 %s", id, got, want)
		}
	}
}
