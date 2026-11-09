package store

import (
	"path/filepath"
	"testing"

	"hachi/internal/wkk"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestBookRoundTrip(t *testing.T) {
	s := newTestStore(t)
	book := &wkk.Book{
		ID: "1", Title: "文学少女", Author: "野村美月", Publisher: "Fami通文库",
		Cover: "http://img/1.jpg", Description: "简介", Tags: []string{"校园", "悬疑"},
		WordCount: 1000, UpdatedAt: "2022-02-27", IsComplete: true, IsAnime: true,
	}
	if err := s.UpsertBook(book); err != nil {
		t.Fatalf("UpsertBook: %v", err)
	}
	got, err := s.GetBook("1")
	if err != nil || got == nil {
		t.Fatalf("GetBook: %v %v", got, err)
	}
	if got.Title != book.Title || got.Author != book.Author || !got.IsAnime || len(got.Tags) != 2 {
		t.Errorf("读回不一致: %+v", got)
	}

	// 再次 upsert 不应把已有的卷章计数清零
	if err := s.SaveVolumes("1", []wkk.Volume{{
		ID: "v1", Title: "第一卷",
		Chapters: []wkk.Chapter{{ID: "2", Title: "序章", Index: 0}, {ID: "3", Title: "第一章", Index: 1}},
	}}); err != nil {
		t.Fatalf("SaveVolumes: %v", err)
	}
	_ = s.UpsertBook(&wkk.Book{ID: "1", Title: "文学少女"})
	got, _ = s.GetBook("1")
	if got.ChapterCount != 2 || got.VolumeCount != 1 {
		t.Errorf("计数被覆盖: chapter=%d volume=%d", got.ChapterCount, got.VolumeCount)
	}
}

func TestVolumesAndNeighbors(t *testing.T) {
	s := newTestStore(t)
	_ = s.UpsertBook(&wkk.Book{ID: "1", Title: "T"})
	vols := []wkk.Volume{
		{ID: "v1", Title: "第一卷", Chapters: []wkk.Chapter{
			{ID: "2", Title: "序章", Index: 0},
			{ID: "3", Title: "第一章", Index: 1},
		}},
		{ID: "v2", Title: "第二卷", Chapters: []wkk.Chapter{
			{ID: "4", Title: "第二章", Index: 2},
		}},
	}
	if err := s.SaveVolumes("1", vols); err != nil {
		t.Fatalf("SaveVolumes: %v", err)
	}

	got, err := s.GetVolumes("1")
	if err != nil {
		t.Fatalf("GetVolumes: %v", err)
	}
	if len(got) != 2 || len(got[0].Chapters) != 2 || len(got[1].Chapters) != 1 {
		t.Fatalf("卷章结构错误: %+v", got)
	}

	prev, next, index, total, title, err := s.ChapterNeighbors("1", "3")
	if err != nil {
		t.Fatalf("ChapterNeighbors: %v", err)
	}
	if prev != "2" || next != "4" || index != 1 || total != 3 || title != "第一章" {
		t.Errorf("相邻章节错误: prev=%s next=%s idx=%d total=%d title=%s", prev, next, index, total, title)
	}

	// 首章无上一章，末章无下一章
	prev, _, _, _, _, _ = s.ChapterNeighbors("1", "2")
	if prev != "" {
		t.Errorf("首章 prev 应为空，实际 %q", prev)
	}
	_, next, _, _, _, _ = s.ChapterNeighbors("1", "4")
	if next != "" {
		t.Errorf("末章 next 应为空，实际 %q", next)
	}
}

func TestChapterCache(t *testing.T) {
	s := newTestStore(t)
	blocks := []wkk.Block{{Type: "text", Text: "第一段"}, {Type: "image", Src: "http://x/1.jpg"}}
	if err := s.SaveChapter("1", "2", blocks); err != nil {
		t.Fatalf("SaveChapter: %v", err)
	}
	got, ok, err := s.GetChapter("1", "2")
	if err != nil || !ok {
		t.Fatalf("GetChapter: ok=%v err=%v", ok, err)
	}
	if len(got) != 2 || got[0].Text != "第一段" || got[1].Src != "http://x/1.jpg" {
		t.Errorf("正文读回错误: %+v", got)
	}

	ids, _ := s.CachedChapterIDs("1")
	if len(ids) != 1 || ids[0] != "2" {
		t.Errorf("缓存章节列表错误: %v", ids)
	}

	entries, total, err := s.CacheStats()
	if err != nil {
		t.Fatalf("CacheStats: %v", err)
	}
	if len(entries) != 1 || total <= 0 {
		t.Errorf("缓存统计错误: %+v total=%d", entries, total)
	}

	if err := s.DeleteBookCache("1"); err != nil {
		t.Fatalf("DeleteBookCache: %v", err)
	}
	if _, ok, _ := s.GetChapter("1", "2"); ok {
		t.Error("缓存应已删除")
	}
}

func TestShelvesAndLibrary(t *testing.T) {
	s := newTestStore(t)
	_ = s.UpsertBook(&wkk.Book{ID: "1", Title: "文学少女", Author: "野村美月"})

	id, err := s.CreateShelf("在读")
	if err != nil {
		t.Fatalf("CreateShelf: %v", err)
	}
	if _, err := s.CreateShelf("在读"); err == nil {
		t.Error("同名书架应报错")
	}
	if err := s.AddToShelf(id, "1"); err != nil {
		t.Fatalf("AddToShelf: %v", err)
	}
	if err := s.AddToShelf(id, "1"); err != nil {
		t.Errorf("重复添加应幂等: %v", err)
	}

	shelves, err := s.Shelves()
	if err != nil || len(shelves) != 1 || shelves[0].Count != 1 {
		t.Fatalf("Shelves: %+v err=%v", shelves, err)
	}

	lib, err := s.Library()
	if err != nil {
		t.Fatalf("Library: %v", err)
	}
	if len(lib) != 1 || lib[0].Book.Title != "文学少女" || len(lib[0].Shelves) != 1 {
		t.Fatalf("Library: %+v", lib)
	}

	if err := s.RemoveFromShelf(id, "1"); err != nil {
		t.Fatalf("RemoveFromShelf: %v", err)
	}
	lib, _ = s.Library()
	if len(lib) != 0 {
		t.Errorf("移除后书库应为空，实际 %d", len(lib))
	}

	if err := s.DeleteShelf(id); err != nil {
		t.Fatalf("DeleteShelf: %v", err)
	}
	shelves, _ = s.Shelves()
	if len(shelves) != 0 {
		t.Error("书架应已删除")
	}
}

func TestStateAndReadMarks(t *testing.T) {
	s := newTestStore(t)
	_ = s.UpsertBook(&wkk.Book{ID: "1", Title: "T"})
	_ = s.SaveVolumes("1", []wkk.Volume{{ID: "v", Title: "卷", Chapters: []wkk.Chapter{
		{ID: "2", Title: "a", Index: 0}, {ID: "3", Title: "b", Index: 1},
	}}})

	p, err := s.GetState("1")
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if p.TotalCount != 2 {
		t.Errorf("未读时也应返回总章数，实际 %d", p.TotalCount)
	}

	if err := s.SaveState("1", "3", 1, 0.5); err != nil {
		t.Fatalf("SaveState: %v", err)
	}
	p, _ = s.GetState("1")
	if p.ChapterID != "3" || p.Index != 1 || p.Progress != 0.5 {
		t.Errorf("进度读回错误: %+v", p)
	}

	_ = s.MarkRead("1", "2", true)
	p, _ = s.GetState("1")
	if p.ReadCount != 1 {
		t.Errorf("已读数 = %d", p.ReadCount)
	}

	_ = s.MarkAllRead("1")
	p, _ = s.GetState("1")
	if p.ReadCount != 2 {
		t.Errorf("全部已读后 = %d", p.ReadCount)
	}

	_ = s.MarkRead("1", "3", false)
	p, _ = s.GetState("1")
	if p.ReadCount != 1 {
		t.Errorf("取消已读后 = %d", p.ReadCount)
	}
}

func TestStats(t *testing.T) {
	s := newTestStore(t)
	_ = s.UpsertBook(&wkk.Book{ID: "1", Title: "T"})

	_ = s.AddSession("1", "2", 300)
	_ = s.AddSession("1", "2", 200)
	_ = s.AddSession("1", "2", 0) // 应被忽略

	sum, err := s.StatsSummary("", "")
	if err != nil {
		t.Fatalf("StatsSummary: %v", err)
	}
	if sum.TotalSeconds != 500 {
		t.Errorf("总时长 = %d, 期望 500", sum.TotalSeconds)
	}
	if len(sum.ByDay) != 1 {
		t.Errorf("按天 = %d 条", len(sum.ByDay))
	}
	if len(sum.ByBook) != 1 || sum.ByBook[0].Seconds != 500 {
		t.Errorf("按书: %+v", sum.ByBook)
	}

	days, err := s.Calendar(2000)
	if err != nil {
		t.Fatalf("Calendar: %v", err)
	}
	if len(days) != 0 {
		t.Errorf("2000 年不应有数据，实际 %d", len(days))
	}
}

func TestSettings(t *testing.T) {
	s := newTestStore(t)
	if err := s.SaveSettings(map[string]string{"fontSize": "20", "theme": "sepia"}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	got, err := s.Settings()
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if got["fontSize"] != "20" || got["theme"] != "sepia" {
		t.Errorf("设置读回错误: %+v", got)
	}
}
