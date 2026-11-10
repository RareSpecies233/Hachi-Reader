package wkk

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

// 联网集成测试。默认跳过，避免 CI 打站点：
//
//	HACHI_LIVE=1 go test ./internal/wkk/ -run Live -v
func liveClient(t *testing.T) *Client {
	t.Helper()
	if os.Getenv("HACHI_LIVE") == "" {
		t.Skip("跳过联网测试（设置 HACHI_LIVE=1 启用）")
	}
	c, err := NewClient(Options{Timeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

// skipIfRateLimited 把上游限流标记为 Skip 而不是 FAIL：
// 429 是 Cloudflare 对出口 IP 的限制，不是代码回归。
func skipIfRateLimited(t *testing.T, err error) {
	t.Helper()
	if errors.Is(err, ErrRateLimited) {
		t.Skipf("上游限流，跳过: %v", err)
	}
}

func TestLiveBook(t *testing.T) {
	c := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	book, err := c.Book(ctx, "1")
	if err != nil {
		skipIfRateLimited(t, err)
		t.Fatalf("Book(1): %v", err)
	}
	if book.Title != "文学少女" {
		t.Errorf("标题 = %q", book.Title)
	}
	if book.Author == "" || book.Cover == "" {
		t.Errorf("元信息不全: %+v", book)
	}
	t.Logf("书名=%s 作者=%s 文库=%s 字数=%d 更新=%s 完结=%v",
		book.Title, book.Author, book.Publisher, book.WordCount, book.UpdatedAt, book.IsComplete)
}

func TestLiveVolumesAndChapter(t *testing.T) {
	c := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	vols, err := c.Volumes(ctx, "1")
	if err != nil {
		skipIfRateLimited(t, err)
		t.Fatalf("Volumes(1): %v", err)
	}
	if len(vols) == 0 {
		t.Fatal("目录为空")
	}
	total := 0
	for _, v := range vols {
		total += len(v.Chapters)
	}
	t.Logf("卷数=%d 章节数=%d", len(vols), total)

	first := vols[0].Chapters[0]
	cc, err := c.Chapter(ctx, "1", first.ID)
	if err != nil {
		skipIfRateLimited(t, err)
		t.Fatalf("Chapter(%s): %v", first.ID, err)
	}
	if len(cc.Blocks) < 10 {
		t.Errorf("正文段落过少: %d", len(cc.Blocks))
	}
	t.Logf("章节=%s 段落=%d next=%s", cc.Title, len(cc.Blocks), cc.Next)
}

func TestLiveLoginRequired(t *testing.T) {
	c := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 未登录访问排行榜，应明确返回 ErrLoginRequired 而不是解析出空列表。
	_, err := c.TopList(ctx, "allvisit", 1)
	if err == nil {
		t.Skip("当前站点允许匿名访问排行榜，跳过断言")
	}
	skipIfRateLimited(t, err)
	if !errors.Is(err, ErrLoginRequired) {
		t.Errorf("期望 ErrLoginRequired，实际: %v", err)
	}
}

// 验证内置公共 Cookie 能让列表/搜索通过登录校验。
func TestLiveBundledCookie(t *testing.T) {
	if os.Getenv("HACHI_LIVE") == "" {
		t.Skip("跳过联网测试（设置 HACHI_LIVE=1 启用）")
	}
	c, err := NewClient(Options{Timeout: 30 * time.Second, UseBundledCookie: true})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if c.CookieSource() != CookieBundled {
		t.Fatalf("凭据来源 = %s, 期望 bundled", c.CookieSource())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	res, err := c.TopList(ctx, "allvisit", 1)
	if err != nil {
		skipIfRateLimited(t, err)
		t.Fatalf("TopList: %v", err)
	}
	if len(res.Items) == 0 {
		t.Fatal("排行榜为空")
	}
	t.Logf("内置 Cookie 打开排行榜：%d 本，第一本《%s》", len(res.Items), res.Items[0].Title)

	sres, err := c.Search(ctx, "文学少女", "articlename", 1)
	if err != nil {
		skipIfRateLimited(t, err)
		t.Fatalf("Search: %v", err)
	}
	if sres.Single != nil {
		t.Logf("搜索命中单本：%s (id=%s)", sres.Single.Title, sres.Single.ID)
	} else {
		t.Logf("搜索结果：%d 本", len(sres.Items))
	}
}
