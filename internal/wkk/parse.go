package wkk

// HTML 解析。所有选择器都基于 2026-11 对真实页面的核对结果：
//
//   书籍页  /book/{id}.htm
//     #content > div > table[0] : tr[0] 书名, tr[1] 文库/作者/状态/更新/字数
//     #content > div > table[1] : td[0] 封面, td[1] 标签 / 简介
//   目录页  /novel/{id/1000}/{id}/index.htm
//     table.css tr > td.vcss[vid]  卷标题
//                   td.ccss > a      章节（href 形如 2.htm）
//   正文页  /novel/{id/1000}/{id}/{cid}.htm
//     #title 标题, #content 正文（文本 + br + div.divimage）, #foottext 上一页/下一页

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"golang.org/x/net/html"
	"golang.org/x/text/encoding/simplifiedchinese"
)

var (
	reSubtitle  = regexp.MustCompile(`^(.+?)\s*[（(](.+?)[）)]\s*$`)
	reAuthor    = regexp.MustCompile(`小说作者[：:]\s*([^/|]+)`)
	rePublisher = regexp.MustCompile(`文库分类[：:]\s*([^/|]+)`)
	reWordCount = regexp.MustCompile(`全文长度[：:]\s*(\d+)`)
	reUpdated   = regexp.MustCompile(`最后更新[：:]\s*(\d{4}-\d{2}-\d{2})`)
	reTags      = regexp.MustCompile(`作品Tags[：:]\s*([^\n]+)`)
	reDesc      = regexp.MustCompile(`简介[：:]\s*([^\n]+)`)
	reBookID    = regexp.MustCompile(`/book/(\d+)\.htm`)
)

// ---------------------------------------------------------------- 书籍信息

func (c *Client) Book(ctx context.Context, id string) (*Book, error) {
	doc, err := c.fetchDoc(ctx, "/book/"+id+".htm")
	if err != nil {
		return nil, err
	}
	return parseBook(doc, id)
}

func parseBook(doc *goquery.Document, id string) (*Book, error) {
	body := doc.Find("#content")
	if body.Length() == 0 {
		return nil, ErrNotFound
	}
	plain := body.Text()
	if strings.Contains(plain, "因版权问题") {
		return nil, ErrCopyright
	}

	// 注意：页面里表格是嵌套的（封面表在简介表的 td 里），
	// 必须只取直接子节点，否则 Find("tr") 会先把内层表格的行算进来。
	container := body.ChildrenFiltered("div").Eq(0)
	tables := container.ChildrenFiltered("table")
	if tables.Length() == 0 {
		tables = container.Find("table")
	}
	if tables.Length() == 0 {
		return nil, fmt.Errorf("页面结构异常，未找到书籍信息表 (id=%s)", id)
	}
	head := tables.Eq(0)
	rows := directRows(head)

	title := clean(rows.Eq(0).Find("span b").First().Text())
	if title == "" {
		title = clean(rows.Eq(0).Find("td").Eq(0).Text())
	}
	if title == "" {
		return nil, fmt.Errorf("无法解析书名 (id=%s)", id)
	}

	b := &Book{ID: id, Title: title}
	if m := reSubtitle.FindStringSubmatch(title); m != nil {
		b.Title = clean(m[1])
		b.Subtitle = clean(m[2])
	}

	// 元信息行：文库 / 作者 / 状态 / 更新 / 字数
	rows.Eq(1).ChildrenFiltered("td").Each(func(i int, td *goquery.Selection) {
		t := clean(td.Text())
		switch {
		case strings.Contains(t, "文库分类"):
			b.Publisher = afterColon(t)
		case strings.Contains(t, "小说作者"):
			b.Author = afterColon(t)
		case strings.Contains(t, "文章状态"):
			b.IsComplete = strings.Contains(t, "已完结")
		case strings.Contains(t, "最后更新"):
			b.UpdatedAt = afterColon(t)
		case strings.Contains(t, "全文长度"):
			b.WordCount = atoi(strings.TrimSuffix(afterColon(t), "字"))
		}
	})

	// 封面与简介
	if tables.Length() > 1 {
		second := tables.Eq(1)
		if src, ok := second.Find("img").First().Attr("src"); ok {
			b.Cover = strings.TrimSpace(src)
		}
		second.Find("span").EachWithBreak(func(i int, s *goquery.Selection) bool {
			if strings.Contains(clean(s.Text()), "内容简介") {
				nxt := s.NextAllFiltered("span").First()
				if nxt.Length() > 0 {
					b.Description = clean(nxt.Text())
				}
				return false
			}
			return true
		})
	}

	// 标签
	body.Find("span").EachWithBreak(func(i int, s *goquery.Selection) bool {
		t := clean(s.Text())
		if strings.Contains(t, "作品Tags") {
			v := afterColon(t)
			b.Tags = splitTags(v)
			return false
		}
		return true
	})

	b.IsAnime = strings.Contains(plain, "本作已动画化")
	if b.Description == "" {
		if m := reDesc.FindStringSubmatch(plain); m != nil {
			b.Description = clean(m[1])
		}
	}

	return b, nil
}

// ---------------------------------------------------------------- 分卷目录

func (c *Client) Volumes(ctx context.Context, id string) ([]Volume, error) {
	doc, err := c.fetchDoc(ctx, fmt.Sprintf("/novel/%s/%s/index.htm", bookShard(id), id))
	if err != nil {
		return nil, err
	}
	return parseVolumes(doc)
}

func bookShard(id string) string {
	n, err := strconv.Atoi(id)
	if err != nil {
		return "0"
	}
	return strconv.Itoa(n / 1000)
}

func parseVolumes(doc *goquery.Document) ([]Volume, error) {
	var (
		volumes []Volume
		cur     *Volume
		index   int
	)

	rows := doc.Find("table.css tr")
	if rows.Length() == 0 {
		rows = doc.Find("table tr")
	}

	rows.Each(func(_ int, tr *goquery.Selection) {
		if td := tr.Find("td.vcss").First(); td.Length() > 0 {
			volumes = append(volumes, Volume{
				ID:    td.AttrOr("vid", ""),
				Title: clean(td.Text()),
			})
			cur = &volumes[len(volumes)-1]
			return
		}
		tr.Find("td.ccss a").Each(func(_ int, a *goquery.Selection) {
			href := strings.TrimSpace(a.AttrOr("href", ""))
			if href == "" || strings.Contains(href, "javascript") {
				return
			}
			cid := strings.TrimSuffix(href, ".htm")
			if cid == "" || cid == href {
				return
			}
			title := clean(a.Text())
			if title == "" {
				return
			}
			if cur == nil {
				volumes = append(volumes, Volume{ID: "0", Title: "正文"})
				cur = &volumes[len(volumes)-1]
			}
			cur.Chapters = append(cur.Chapters, Chapter{ID: cid, Title: title, Index: index})
			index++
		})
	})

	// 去重：同一个 table 可能被上面两个选择器重复命中
	seen := map[string]bool{}
	out := make([]Volume, 0, len(volumes))
	n := 0
	for _, v := range volumes {
		vv := Volume{ID: v.ID, Title: v.Title}
		for _, ch := range v.Chapters {
			if seen[ch.ID] {
				continue
			}
			seen[ch.ID] = true
			ch.Index = n
			n++
			vv.Chapters = append(vv.Chapters, ch)
		}
		if len(vv.Chapters) > 0 {
			out = append(out, vv)
		}
	}
	if len(seen) == 0 {
		return nil, fmt.Errorf("目录为空，可能被版权限制")
	}
	return out, nil
}

// ---------------------------------------------------------------- 章节正文

func (c *Client) Chapter(ctx context.Context, bookID, chapterID string) (*ChapterContent, error) {
	doc, err := c.fetchDoc(ctx, fmt.Sprintf("/novel/%s/%s/%s.htm", bookShard(bookID), bookID, chapterID))
	if err != nil {
		return nil, err
	}
	return parseChapter(doc, chapterID)
}

func parseChapter(doc *goquery.Document, chapterID string) (*ChapterContent, error) {
	content := doc.Find("#content").First()
	if content.Length() == 0 {
		return nil, ErrNotFound
	}
	if strings.Contains(content.Text(), "因版权问题") {
		return nil, ErrCopyright
	}

	cc := &ChapterContent{
		ID:     chapterID,
		Title:  clean(doc.Find("#title").First().Text()),
		Blocks: make([]Block, 0, 128),
	}

	root := content.Get(0)
	for n := root.FirstChild; n != nil; n = n.NextSibling {
		switch n.Type {
		case html.TextNode:
			appendTextBlocks(cc, n.Data)
		case html.ElementNode:
			switch strings.ToLower(n.Data) {
			case "br":
				// 纯换行，忽略
			case "div":
				if hasClass(n, "divimage") {
					if src := firstImgSrc(n); src != "" {
						cc.Blocks = append(cc.Blocks, Block{Type: "image", Src: src})
					}
				}
			case "ul", "script", "style":
				// 站点声明与广告，丢弃
			case "p":
				appendTextBlocks(cc, nodeText(n))
			}
		}
	}

	// 上一页 / 下一页
	doc.Find("#foottext a").Each(func(_ int, a *goquery.Selection) {
		href := strings.TrimSpace(a.AttrOr("href", ""))
		if href == "" || strings.Contains(href, "index.htm") || strings.Contains(href, "article") {
			return
		}
		label := clean(a.Text())
		cid := strings.TrimSuffix(href, ".htm")
		if cid == href {
			return
		}
		switch {
		case strings.Contains(label, "上一页"):
			cc.Prev = cid
		case strings.Contains(label, "下一页"):
			cc.Next = cid
		}
	})

	if len(cc.Blocks) == 0 {
		return nil, fmt.Errorf("章节正文为空 (id=%s)", chapterID)
	}
	return cc, nil
}

func appendTextBlocks(cc *ChapterContent, raw string) {
	raw = strings.ReplaceAll(raw, "\u00a0", " ")
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		line = strings.Trim(line, "\u3000")
		if line == "" {
			continue
		}
		// 站点水印行
		if strings.Contains(line, "本文来自 轻小说文库") ||
			strings.Contains(line, "轻小说文库(http://www.wenku8.com)") {
			continue
		}
		cc.Blocks = append(cc.Blocks, Block{Type: "text", Text: line})
	}
}

func nodeText(n *html.Node) string {
	var sb strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.TextNode {
			sb.WriteString(c.Data)
		}
	}
	return sb.String()
}

func hasClass(n *html.Node, class string) bool {
	for _, a := range n.Attr {
		if a.Key == "class" {
			for _, f := range strings.Fields(a.Val) {
				if f == class {
					return true
				}
			}
		}
	}
	return false
}

// directRows 取表格的直接行，兼容有无 tbody 两种情况。
func directRows(table *goquery.Selection) *goquery.Selection {
	if rows := table.ChildrenFiltered("tr"); rows.Length() > 0 {
		return rows
	}
	return table.ChildrenFiltered("tbody").ChildrenFiltered("tr")
}

func firstImgSrc(n *html.Node) string {
	if n.Type == html.ElementNode && n.Data == "img" {
		for _, a := range n.Attr {
			if a.Key == "src" {
				return strings.TrimSpace(a.Val)
			}
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if s := firstImgSrc(c); s != "" {
			return s
		}
	}
	return ""
}

// ---------------------------------------------------------------- 列表 / 搜索

// parseBookCards 从任意列表容器里抽出书卡。
// 站点列表页结构未登录不可见，这里用"锚点 + 祖先文本"的保守策略，尽量不依赖具体层级。
func parseBookCards(scope *goquery.Selection) []Book {
	var out []Book
	seen := map[string]bool{}

	scope.Find(`a[href*="/book/"]`).Each(func(_ int, a *goquery.Selection) {
		href := a.AttrOr("href", "")
		m := reBookID.FindStringSubmatch(href)
		if m == nil {
			return
		}
		id := m[1]
		if seen[id] {
			return
		}

		title := clean(a.AttrOr("title", ""))
		if title == "" {
			title = clean(a.Text())
		}
		if title == "" {
			return
		}

		card := cardContainer(a)
		text := clean(card.Text())
		if text == "" {
			text = clean(a.Closest("div").Text())
		}

		bk := Book{ID: id, Title: title}
		if mm := reSubtitle.FindStringSubmatch(title); mm != nil {
			bk.Title = clean(mm[1])
			bk.Subtitle = clean(mm[2])
		}
		if src, ok := a.Find("img").First().Attr("src"); ok {
			bk.Cover = strings.TrimSpace(src)
		} else if src, ok := card.Find("img").First().Attr("src"); ok {
			bk.Cover = strings.TrimSpace(src)
		}

		if mm := reAuthor.FindStringSubmatch(text); mm != nil {
			bk.Author = clean(mm[1])
		}
		if mm := rePublisher.FindStringSubmatch(text); mm != nil {
			bk.Publisher = clean(mm[1])
		}
		if mm := reWordCount.FindStringSubmatch(text); mm != nil {
			bk.WordCount = atoi(mm[1])
		}
		if mm := reUpdated.FindStringSubmatch(text); mm != nil {
			bk.UpdatedAt = mm[1]
		}
		if mm := reTags.FindStringSubmatch(text); mm != nil {
			bk.Tags = splitTags(mm[1])
		}
		if mm := reDesc.FindStringSubmatch(text); mm != nil {
			bk.Description = truncate(clean(mm[1]), 200)
		}
		bk.IsComplete = strings.Contains(text, "已完结") && !strings.Contains(text, "未完结")

		seen[id] = true
		out = append(out, bk)
	})
	return out
}

// cardContainer 向上找 3 层，取第一个"像整张书卡"的祖先。
func cardContainer(a *goquery.Selection) *goquery.Selection {
	cur := a.Closest("div")
	best := cur
	for i := 0; i < 3 && cur.Length() > 0; i++ {
		if len(clean(cur.Text())) > 40 {
			best = cur
			break
		}
		cur = cur.Parent()
	}
	return best
}

// ---------------------------------------------------------------- 列表接口

func (c *Client) TopList(ctx context.Context, sort string, page int) (*ListPage, error) {
	switch sort {
	case "allvisit", "anime", "lastupdate", "postdate":
	default:
		sort = "allvisit"
	}
	path := fmt.Sprintf("/modules/article/toplist.php?sort=%s&page=%d", sort, page)
	return c.listPage(ctx, path)
}

func (c *Client) AllList(ctx context.Context, full bool, page int) (*ListPage, error) {
	path := fmt.Sprintf("/modules/article/articlelist.php?page=%d", page)
	if full {
		path += "&fullflag=1"
	}
	return c.listPage(ctx, path)
}

func (c *Client) TagList(ctx context.Context, tag, v string, page int) (*ListPage, error) {
	path := fmt.Sprintf("/modules/article/tags.php?t=%s&v=%s&page=%d",
		urlEncodeGBK(tag), urlEncodeGBK(v), page)
	return c.listPage(ctx, path)
}

func (c *Client) listPage(ctx context.Context, path string) (*ListPage, error) {
	doc, err := c.fetchDoc(ctx, path)
	if err != nil {
		c.noteProbe(false, err.Error())
		return nil, err
	}
	content := doc.Find("#content")
	items := parseBookCards(content)
	p, hasMore := pagination(doc, len(items))

	// HTTP 200 + 空列表 ≠ "这里没书"。首页遇到空内容基本都是登录页/风控页
	// 被当成正常页面解析了，必须明确报错，不能把"空"当成成功返回给前端。
	if len(items) == 0 && p <= 1 {
		var err error
		if c.CookieSource() == CookieNone {
			err = ErrLoginRequired
		} else {
			err = fmt.Errorf("%w：列表页没有内容（HTTP 200），可能是登录态失效或被上游拦截", ErrLoginStale)
		}
		c.markLoginInvalid()
		c.noteProbe(false, err.Error())
		return nil, err
	}

	c.noteProbe(true, fmt.Sprintf("列表第 %d 页 %d 条", p, len(items)))
	return &ListPage{Items: items, Page: p, HasMore: hasMore}, nil
}

func pagination(doc *goquery.Document, cur int) (int, bool) {
	em := clean(doc.Find("#pagelink em").First().Text())
	// 形如 "1/5"
	if i := strings.Index(em, "/"); i > 0 {
		curPage := atoi(strings.TrimSpace(em[:i]))
		total := atoi(strings.TrimSpace(em[i+1:]))
		if curPage == 0 {
			curPage = 1
		}
		return curPage, curPage < total
	}
	return 1, false
}

// ---------------------------------------------------------------- 搜索

type SearchResult struct {
	Single *Book `json:"single,omitempty"`
	ListPage
}

func (c *Client) Search(ctx context.Context, keyword, searchType string, page int) (*SearchResult, error) {
	if searchType != "author" {
		searchType = "articlename"
	}

	// 锁必须覆盖"等待 + 真正发请求 + 收尾"，只锁等待会让并发搜索在
	// 同一个 5 秒窗口里一起放行，触发站点的搜索频率限制。
	c.searchGate.Lock()
	defer func() {
		// 以请求结束时间重新计时，保证下一次搜索距离本次"完成"至少 5 秒。
		c.lastSearch = time.Now()
		c.searchGate.Unlock()
	}()
	if err := c.waitSearchGap(ctx); err != nil {
		return nil, err
	}

	path := fmt.Sprintf("/modules/article/search.php?searchtype=%s&searchkey=%s&page=%d",
		searchType, urlEncodeGBK(keyword), page)
	doc, err := c.fetchDoc(ctx, path)
	if err != nil {
		return nil, err
	}

	// 命中单本：页面上会出现"小说目录"入口
	var singleID string
	doc.Find("a").EachWithBreak(func(_ int, a *goquery.Selection) bool {
		if strings.Contains(clean(a.Text()), "小说目录") {
			href := a.AttrOr("href", "")
			parts := strings.Split(strings.Trim(href, "/"), "/")
			if len(parts) >= 2 {
				singleID = parts[len(parts)-2]
				return false
			}
		}
		return true
	})
	if singleID != "" {
		bk, err := c.Book(ctx, singleID)
		if err == nil {
			return &SearchResult{Single: bk}, nil
		}
		return &SearchResult{Single: &Book{ID: singleID, Title: keyword}}, nil
	}

	items := parseBookCards(doc.Find("#content"))
	p, hasMore := pagination(doc, len(items))
	return &SearchResult{ListPage: ListPage{Items: items, Page: p, HasMore: hasMore}}, nil
}

// ---------------------------------------------------------------- 小工具

func splitTags(s string) []string {
	s = clean(s)
	var out []string
	for _, f := range strings.Fields(s) {
		f = clean(f)
		if f != "" && !strings.Contains(f, "：") && !strings.Contains(f, ":") {
			out = append(out, f)
		}
	}
	return out
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// urlEncodeGBK 按 GBK 做百分号编码。站点的搜索/标签参数都吃 GBK，直接 UTF-8 会查不到。
func urlEncodeGBK(s string) string {
	enc, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte(s))
	if err != nil {
		enc = []byte(s)
	}
	var sb strings.Builder
	sb.Grow(len(enc) * 3)
	for _, b := range enc {
		switch {
		case b >= 'a' && b <= 'z', b >= 'A' && b <= 'Z', b >= '0' && b <= '9',
			b == '-', b == '_', b == '.', b == '~':
			sb.WriteByte(b)
		default:
			fmt.Fprintf(&sb, "%%%02X", b)
		}
	}
	return sb.String()
}
