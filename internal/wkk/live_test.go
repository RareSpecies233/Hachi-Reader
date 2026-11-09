package wkk

import (
	"context"
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

func TestLiveBook(t *testing.T) {
	c := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	book, err := c.Book(ctx, "1")
	if err != nil {
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
	if err != ErrLoginRequired {
		t.Errorf("期望 ErrLoginRequired，实际: %v", err)
	}
}
