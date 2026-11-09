package store

// SQLite 持久化。用 modernc.org/sqlite（纯 Go），保证 CGO_ENABLED=0 也能交叉编译到
// Windows / Linux / macOS —— 这是本项目"一个二进制跑三平台"的前提。

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"hachi/internal/wkk"
)

type Store struct {
	db *sql.DB
}

type Shelf struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Pinned   bool   `json:"pinned"`
	Position int    `json:"position"`
	Count    int    `json:"count"`
}

type Progress struct {
	BookID     string  `json:"bookId"`
	ChapterID  string  `json:"chapterId"`
	Index      int     `json:"index"`
	Progress   float64 `json:"progress"`
	UpdatedAt  int64   `json:"updatedAt"`
	ReadCount  int     `json:"readCount"`
	TotalCount int     `json:"totalCount"`
}

type LibraryEntry struct {
	Book       wkk.Book  `json:"book"`
	Shelves    []int64   `json:"shelves"`
	State      *Progress `json:"state,omitempty"`
	HasUpdate  bool      `json:"hasUpdate"`
	LastReadAt int64     `json:"lastReadAt"`
}

type CacheEntry struct {
	BookID   string `json:"bookId"`
	Title    string `json:"title"`
	Chapters int    `json:"chapters"`
	Bytes    int64  `json:"bytes"`
	CachedAt int64  `json:"cachedAt"`
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(8000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // modernc 的写并发有限，单连接最稳
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS books (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  subtitle       TEXT DEFAULT '',
  author         TEXT DEFAULT '',
  publisher      TEXT DEFAULT '',
  cover          TEXT DEFAULT '',
  description    TEXT DEFAULT '',
  tags           TEXT DEFAULT '[]',
  word_count     INTEGER DEFAULT 0,
  updated_at     TEXT DEFAULT '',
  is_complete    INTEGER DEFAULT 0,
  is_anime       INTEGER DEFAULT 0,
  volume_count   INTEGER DEFAULT 0,
  chapter_count  INTEGER DEFAULT 0,
  last_chapter   TEXT DEFAULT '',
  seen_chapter   TEXT DEFAULT '',
  fetched_at     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS volumes (
  book_id TEXT NOT NULL,
  id      TEXT NOT NULL,
  title   TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (book_id, id)
);

CREATE TABLE IF NOT EXISTS chapters (
  book_id   TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  id        TEXT NOT NULL,
  title     TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  PRIMARY KEY (book_id, id)
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, idx);

CREATE TABLE IF NOT EXISTS chapter_contents (
  book_id    TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  payload    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (book_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS shelves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  pinned     INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shelf_books (
  shelf_id INTEGER NOT NULL,
  book_id  TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (shelf_id, book_id)
);

CREATE TABLE IF NOT EXISTS read_state (
  book_id       TEXT PRIMARY KEY,
  chapter_id    TEXT DEFAULT '',
  chapter_index INTEGER DEFAULT 0,
  progress      REAL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS read_chapters (
  book_id    TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  read_at    INTEGER NOT NULL,
  PRIMARY KEY (book_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    TEXT NOT NULL,
  chapter_id TEXT DEFAULT '',
  seconds    INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_end ON sessions(ended_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)
	return err
}

// ---------------------------------------------------------------- 书籍

func (s *Store) UpsertBook(b *wkk.Book) error {
	tags, _ := json.Marshal(b.Tags)
	if b.Tags == nil {
		tags = []byte("[]")
	}
	_, err := s.db.Exec(`
INSERT INTO books (id, title, subtitle, author, publisher, cover, description, tags,
                   word_count, updated_at, is_complete, is_anime, volume_count, chapter_count, fetched_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  title=excluded.title, subtitle=excluded.subtitle, author=excluded.author,
  publisher=excluded.publisher, cover=excluded.cover, description=excluded.description,
  tags=excluded.tags, word_count=excluded.word_count, updated_at=excluded.updated_at,
  is_complete=excluded.is_complete, is_anime=excluded.is_anime,
  volume_count=CASE WHEN excluded.volume_count>0 THEN excluded.volume_count ELSE volume_count END,
  chapter_count=CASE WHEN excluded.chapter_count>0 THEN excluded.chapter_count ELSE chapter_count END,
  fetched_at=excluded.fetched_at`,
		b.ID, b.Title, b.Subtitle, b.Author, b.Publisher, b.Cover, b.Description, string(tags),
		b.WordCount, b.UpdatedAt, boolInt(b.IsComplete), boolInt(b.IsAnime),
		b.VolumeCount, b.ChapterCount, time.Now().Unix())
	return err
}

func (s *Store) GetBook(id string) (*wkk.Book, error) {
	row := s.db.QueryRow(`SELECT id,title,subtitle,author,publisher,cover,description,tags,
		word_count,updated_at,is_complete,is_anime,volume_count,chapter_count FROM books WHERE id=?`, id)
	var (
		b        wkk.Book
		tags     string
		complete int
		anime    int
	)
	err := row.Scan(&b.ID, &b.Title, &b.Subtitle, &b.Author, &b.Publisher, &b.Cover,
		&b.Description, &tags, &b.WordCount, &b.UpdatedAt, &complete, &anime,
		&b.VolumeCount, &b.ChapterCount)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	b.IsComplete = complete == 1
	b.IsAnime = anime == 1
	_ = json.Unmarshal([]byte(tags), &b.Tags)
	if b.Tags == nil {
		b.Tags = []string{}
	}
	return &b, nil
}

func (s *Store) SaveVolumes(bookID string, vols []wkk.Volume) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM volumes WHERE book_id=?`, bookID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM chapters WHERE book_id=?`, bookID); err != nil {
		return err
	}

	vs, err := tx.Prepare(`INSERT INTO volumes (book_id,id,title,ordinal) VALUES (?,?,?,?)`)
	if err != nil {
		return err
	}
	defer vs.Close()
	cs, err := tx.Prepare(`INSERT INTO chapters (book_id,volume_id,id,title,idx) VALUES (?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer cs.Close()

	total := 0
	lastID := ""
	for i, v := range vols {
		if _, err := vs.Exec(bookID, v.ID, v.Title, i); err != nil {
			return err
		}
		for _, ch := range v.Chapters {
			if _, err := cs.Exec(bookID, v.ID, ch.ID, ch.Title, ch.Index); err != nil {
				return err
			}
			total++
			lastID = ch.ID
		}
	}

	if _, err := tx.Exec(`UPDATE books SET volume_count=?, chapter_count=?, last_chapter=? WHERE id=?`,
		len(vols), total, lastID, bookID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) GetVolumes(bookID string) ([]wkk.Volume, error) {
	rows, err := s.db.Query(`SELECT id,title FROM volumes WHERE book_id=? ORDER BY ordinal`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var vols []wkk.Volume
	index := map[string]int{}
	for rows.Next() {
		var v wkk.Volume
		if err := rows.Scan(&v.ID, &v.Title); err != nil {
			return nil, err
		}
		v.Chapters = []wkk.Chapter{}
		index[v.ID] = len(vols)
		vols = append(vols, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	crows, err := s.db.Query(`SELECT volume_id,id,title,idx FROM chapters WHERE book_id=? ORDER BY idx`, bookID)
	if err != nil {
		return nil, err
	}
	defer crows.Close()
	for crows.Next() {
		var (
			vid string
			ch  wkk.Chapter
		)
		if err := crows.Scan(&vid, &ch.ID, &ch.Title, &ch.Index); err != nil {
			return nil, err
		}
		if i, ok := index[vid]; ok {
			vols[i].Chapters = append(vols[i].Chapters, ch)
		}
	}
	return vols, nil
}

// ChapterMeta 取章节序号与总数，用于正文响应
func (s *Store) ChapterMeta(bookID, chapterID string) (index, total int, title string, err error) {
	if err = s.db.QueryRow(`SELECT idx, title FROM chapters WHERE book_id=? AND id=?`, bookID, chapterID).
		Scan(&index, &title); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, 0, "", nil
		}
		return
	}
	err = s.db.QueryRow(`SELECT COUNT(*) FROM chapters WHERE book_id=?`, bookID).Scan(&total)
	return
}

// ChapterNeighbors 以本地目录为准推算相邻章节，比网页上的"上一页/下一页"更可靠
// （首页的上一页会指向目录页，网页值不可用时用这里兜底）。
func (s *Store) ChapterNeighbors(bookID, chapterID string) (prev, next string, index, total int, title string, err error) {
	rows, err := s.db.Query(`SELECT id,title,idx FROM chapters WHERE book_id=? ORDER BY idx`, bookID)
	if err != nil {
		return
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id, t string
		var idx int
		if err = rows.Scan(&id, &t, &idx); err != nil {
			return
		}
		if id == chapterID {
			index = idx
			title = t
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		return
	}
	total = len(ids)
	for i, id := range ids {
		if id != chapterID {
			continue
		}
		if i > 0 {
			prev = ids[i-1]
		}
		if i < len(ids)-1 {
			next = ids[i+1]
		}
		break
	}
	return
}

// ---------------------------------------------------------------- 正文缓存

func (s *Store) SaveChapter(bookID, chapterID string, blocks []wkk.Block) error {
	payload, err := json.Marshal(blocks)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO chapter_contents (book_id,chapter_id,payload,fetched_at)
		VALUES (?,?,?,?)
		ON CONFLICT(book_id,chapter_id) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`,
		bookID, chapterID, string(payload), time.Now().Unix())
	return err
}

func (s *Store) GetChapter(bookID, chapterID string) ([]wkk.Block, bool, error) {
	var payload string
	err := s.db.QueryRow(`SELECT payload FROM chapter_contents WHERE book_id=? AND chapter_id=?`,
		bookID, chapterID).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var blocks []wkk.Block
	if err := json.Unmarshal([]byte(payload), &blocks); err != nil {
		return nil, false, err
	}
	return blocks, true, nil
}

func (s *Store) CachedChapterIDs(bookID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT chapter_id FROM chapter_contents WHERE book_id=?`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) DeleteBookCache(bookID string) error {
	_, err := s.db.Exec(`DELETE FROM chapter_contents WHERE book_id=?`, bookID)
	return err
}

func (s *Store) CacheStats() ([]CacheEntry, int64, error) {
	rows, err := s.db.Query(`
SELECT c.book_id, COALESCE(b.title,''), COUNT(*), COALESCE(SUM(LENGTH(c.payload)),0), COALESCE(MAX(c.fetched_at),0)
FROM chapter_contents c LEFT JOIN books b ON b.id=c.book_id
GROUP BY c.book_id ORDER BY 4 DESC`)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var (
		out   []CacheEntry
		total int64
	)
	for rows.Next() {
		var e CacheEntry
		if err := rows.Scan(&e.BookID, &e.Title, &e.Chapters, &e.Bytes, &e.CachedAt); err != nil {
			return nil, 0, err
		}
		total += e.Bytes
		out = append(out, e)
	}
	return out, total, rows.Err()
}

// ---------------------------------------------------------------- 书架

func (s *Store) Shelves() ([]Shelf, error) {
	rows, err := s.db.Query(`
SELECT s.id, s.name, s.pinned, s.position, COUNT(sb.book_id)
FROM shelves s LEFT JOIN shelf_books sb ON sb.shelf_id=s.id
GROUP BY s.id ORDER BY s.pinned DESC, s.position, s.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Shelf{}
	for rows.Next() {
		var sh Shelf
		var pinned int
		if err := rows.Scan(&sh.ID, &sh.Name, &pinned, &sh.Position, &sh.Count); err != nil {
			return nil, err
		}
		sh.Pinned = pinned == 1
		out = append(out, sh)
	}
	return out, rows.Err()
}

func (s *Store) CreateShelf(name string) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO shelves (name,position,created_at) VALUES (?,?,?)`,
		name, time.Now().Unix(), time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateShelf(id int64, name *string, pinned *bool) error {
	if name != nil {
		if _, err := s.db.Exec(`UPDATE shelves SET name=? WHERE id=?`, *name, id); err != nil {
			return err
		}
	}
	if pinned != nil {
		if _, err := s.db.Exec(`UPDATE shelves SET pinned=? WHERE id=?`, boolInt(*pinned), id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) DeleteShelf(id int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM shelf_books WHERE shelf_id=?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM shelves WHERE id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) AddToShelf(shelfID int64, bookID string) error {
	_, err := s.db.Exec(`INSERT INTO shelf_books (shelf_id,book_id,added_at) VALUES (?,?,?)
		ON CONFLICT DO NOTHING`, shelfID, bookID, time.Now().Unix())
	return err
}

func (s *Store) RemoveFromShelf(shelfID int64, bookID string) error {
	_, err := s.db.Exec(`DELETE FROM shelf_books WHERE shelf_id=? AND book_id=?`, shelfID, bookID)
	return err
}

func (s *Store) Library() ([]LibraryEntry, error) {
	rows, err := s.db.Query(`
SELECT b.id,b.title,b.subtitle,b.author,b.publisher,b.cover,b.description,b.tags,
       b.word_count,b.updated_at,b.is_complete,b.is_anime,b.volume_count,b.chapter_count,
       b.last_chapter,b.seen_chapter,
       COALESCE(r.chapter_id,''), COALESCE(r.chapter_index,0), COALESCE(r.progress,0),
       COALESCE(r.updated_at,0),
       (SELECT COUNT(*) FROM read_chapters rc WHERE rc.book_id=b.id)
FROM books b
JOIN shelf_books sb ON sb.book_id=b.id
LEFT JOIN read_state r ON r.book_id=b.id
GROUP BY b.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byID := map[string]*LibraryEntry{}
	order := []string{}

	for rows.Next() {
		var (
			e         LibraryEntry
			tags      string
			complete  int
			anime     int
			lastChap  string
			seenChap  string
			chapID    string
			sIndex    int
			sProgress float64
			sUpdated  int64
			readCount int
		)
		if err := rows.Scan(&e.Book.ID, &e.Book.Title, &e.Book.Subtitle, &e.Book.Author,
			&e.Book.Publisher, &e.Book.Cover, &e.Book.Description, &tags,
			&e.Book.WordCount, &e.Book.UpdatedAt, &complete, &anime,
			&e.Book.VolumeCount, &e.Book.ChapterCount, &lastChap, &seenChap,
			&chapID, &sIndex, &sProgress, &e.LastReadAt, &readCount); err != nil {
			return nil, err
		}
		e.Book.IsComplete = complete == 1
		e.Book.IsAnime = anime == 1
		_ = json.Unmarshal([]byte(tags), &e.Book.Tags)
		if e.Book.Tags == nil {
			e.Book.Tags = []string{}
		}
		e.HasUpdate = lastChap != "" && seenChap != "" && lastChap != seenChap
		e.State = &Progress{
			BookID:     e.Book.ID,
			ChapterID:  chapID,
			Index:      sIndex,
			Progress:   sProgress,
			UpdatedAt:  sUpdated,
			ReadCount:  readCount,
			TotalCount: e.Book.ChapterCount,
		}

		copyE := e
		byID[e.Book.ID] = &copyE
		order = append(order, e.Book.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 书架归属
	srows, err := s.db.Query(`SELECT shelf_id, book_id FROM shelf_books`)
	if err != nil {
		return nil, err
	}
	defer srows.Close()
	for srows.Next() {
		var sid int64
		var bid string
		if err := srows.Scan(&sid, &bid); err != nil {
			return nil, err
		}
		if e, ok := byID[bid]; ok {
			e.Shelves = append(e.Shelves, sid)
		}
	}

	out := make([]LibraryEntry, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, nil
}

// MarkSeen 记录用户已看过的最新章节，用于"有更新"红点。
func (s *Store) MarkSeen(bookID string) error {
	_, err := s.db.Exec(`UPDATE books SET seen_chapter = last_chapter WHERE id = ? AND last_chapter <> ''`, bookID)
	return err
}

// ---------------------------------------------------------------- 阅读进度

func (s *Store) GetState(bookID string) (*Progress, error) {
	p := &Progress{BookID: bookID}
	err := s.db.QueryRow(`SELECT COALESCE(chapter_id,''), COALESCE(chapter_index,0),
		COALESCE(progress,0), COALESCE(updated_at,0) FROM read_state WHERE book_id=?`, bookID).
		Scan(&p.ChapterID, &p.Index, &p.Progress, &p.UpdatedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	// 没有阅读记录也要带上已读章节数与总章数，前端才能画进度条
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM read_chapters WHERE book_id=?`, bookID).Scan(&p.ReadCount)
	_ = s.db.QueryRow(`SELECT COALESCE(chapter_count,0) FROM books WHERE id=?`, bookID).Scan(&p.TotalCount)
	return p, nil
}

func (s *Store) SaveState(bookID, chapterID string, index int, progress float64) error {
	_, err := s.db.Exec(`INSERT INTO read_state (book_id,chapter_id,chapter_index,progress,updated_at)
		VALUES (?,?,?,?,?)
		ON CONFLICT(book_id) DO UPDATE SET chapter_id=excluded.chapter_id,
		  chapter_index=excluded.chapter_index, progress=excluded.progress, updated_at=excluded.updated_at`,
		bookID, chapterID, index, progress, time.Now().Unix())
	return err
}

func (s *Store) MarkRead(bookID, chapterID string, read bool) error {
	if read {
		_, err := s.db.Exec(`INSERT INTO read_chapters (book_id,chapter_id,read_at) VALUES (?,?,?)
			ON CONFLICT DO NOTHING`, bookID, chapterID, time.Now().Unix())
		return err
	}
	_, err := s.db.Exec(`DELETE FROM read_chapters WHERE book_id=? AND chapter_id=?`, bookID, chapterID)
	return err
}

func (s *Store) MarkAllRead(bookID string) error {
	_, err := s.db.Exec(`INSERT INTO read_chapters (book_id,chapter_id,read_at)
		SELECT book_id, id, ? FROM chapters WHERE book_id=? AND id NOT IN
		(SELECT chapter_id FROM read_chapters WHERE book_id=?)
		ON CONFLICT DO NOTHING`, time.Now().Unix(), bookID, bookID)
	return err
}

func (s *Store) ReadChapters(bookID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT chapter_id FROM read_chapters WHERE book_id=?`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- 统计

func (s *Store) AddSession(bookID, chapterID string, seconds int64) error {
	if seconds <= 0 {
		return nil
	}
	if seconds > 3600*6 { // 明显异常的挂机数据，截断
		seconds = 3600 * 6
	}
	now := time.Now().Unix()
	_, err := s.db.Exec(`INSERT INTO sessions (book_id,chapter_id,seconds,started_at,ended_at)
		VALUES (?,?,?,?,?)`, bookID, chapterID, seconds, now-seconds, now)
	return err
}

type DayStat struct {
	Date    string `json:"date"`
	Seconds int64  `json:"seconds"`
}

type BookStat struct {
	BookID  string `json:"bookId"`
	Title   string `json:"title"`
	Seconds int64  `json:"seconds"`
}

type StatsSummary struct {
	TotalSeconds int64      `json:"totalSeconds"`
	Days         int        `json:"days"`
	ByDay        []DayStat  `json:"byDay"`
	ByBook       []BookStat `json:"byBook"`
}

func (s *Store) StatsSummary(from, to string) (*StatsSummary, error) {
	out := &StatsSummary{ByDay: []DayStat{}, ByBook: []BookStat{}}

	where := "WHERE ended_at >= ? AND ended_at <= ?"
	args := []any{parseDay(from, false), parseDay(to, true)}

	if err := s.db.QueryRow(`SELECT COALESCE(SUM(seconds),0), COUNT(DISTINCT date(ended_at,'unixepoch','localtime'))
		FROM sessions `+where, args...).Scan(&out.TotalSeconds, &out.Days); err != nil {
		return nil, err
	}

	rows, err := s.db.Query(`SELECT date(ended_at,'unixepoch','localtime') d, SUM(seconds)
		FROM sessions `+where+` GROUP BY d ORDER BY d`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d DayStat
		if err := rows.Scan(&d.Date, &d.Seconds); err != nil {
			return nil, err
		}
		out.ByDay = append(out.ByDay, d)
	}

	brows, err := s.db.Query(`SELECT s.book_id, COALESCE(b.title,''), SUM(s.seconds)
		FROM sessions s LEFT JOIN books b ON b.id=s.book_id `+strings.Replace(where, "ended_at", "s.ended_at", 1)+`
		GROUP BY s.book_id ORDER BY 3 DESC LIMIT 30`, args...)
	if err != nil {
		return nil, err
	}
	defer brows.Close()
	for brows.Next() {
		var b BookStat
		if err := brows.Scan(&b.BookID, &b.Title, &b.Seconds); err != nil {
			return nil, err
		}
		out.ByBook = append(out.ByBook, b)
	}
	return out, nil
}

func (s *Store) Calendar(year int) ([]DayStat, error) {
	start := time.Date(year, 1, 1, 0, 0, 0, 0, time.Local).Unix()
	end := time.Date(year+1, 1, 1, 0, 0, 0, 0, time.Local).Unix()
	rows, err := s.db.Query(`SELECT date(ended_at,'unixepoch','localtime') d, SUM(seconds)
		FROM sessions WHERE ended_at>=? AND ended_at<?
		GROUP BY d ORDER BY d`, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DayStat{}
	for rows.Next() {
		var d DayStat
		if err := rows.Scan(&d.Date, &d.Seconds); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- 设置

func (s *Store) Settings() (map[string]string, error) {
	rows, err := s.db.Query(`SELECT key, value FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

func (s *Store) SaveSettings(kv map[string]string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for k, v := range kv {
		if _, err := tx.Exec(`INSERT INTO settings (key,value) VALUES (?,?)
			ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, v); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---------------------------------------------------------------- 工具

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// parseDay 把 "2026-01-02" 解析为本地时间戳；空字符串取今天。
func parseDay(s string, endOfDay bool) int64 {
	if s == "" {
		now := time.Now()
		if endOfDay {
			return time.Date(now.Year(), now.Month(), now.Day(), 23, 59, 59, 0, time.Local).Unix()
		}
		return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local).Unix()
	}
	t, err := time.ParseInLocation("2006-01-02", s, time.Local)
	if err != nil {
		return 0
	}
	if endOfDay {
		return t.Add(24*time.Hour - time.Second).Unix()
	}
	return t.Unix()
}
