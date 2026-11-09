package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"hachi/internal/config"
	"hachi/internal/store"
	"hachi/internal/wkk"
)

// ---------------------------------------------------------------- 健康检查

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"version":       Version,
		"tokenRequired": s.currentToken() != "",
		"wenku8": map[string]any{
			"login":  s.wk.IsLoggedIn(),
			"host":   s.wk.Host(),
			"cookie": string(s.wk.CookieSource()),
		},
	})
}

// ---------------------------------------------------------------- 账号

// handleLogin 用账号密码登录 wenku8，成功后写入 data/wenku8.json（0600）。
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		// Cookie 直填：账号登录被验证码挡住时可以直接粘贴浏览器里的 Cookie
		Cookie string `json:"cookie"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "请求体格式错误")
		return
	}

	if strings.TrimSpace(body.Cookie) != "" {
		s.wk.SetCookie(strings.TrimSpace(body.Cookie))
		_ = config.SaveCookie(s.cfg.DataDir, strings.TrimSpace(body.Cookie))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": "cookie"})
		return
	}

	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" || body.Password == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "用户名和密码都不能为空")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	s.wk.SetCredentials(body.Username, body.Password)
	if err := s.wk.Login(ctx); err != nil {
		s.wk.SetCredentials("", "")
		writeError(w, http.StatusBadRequest, "login_failed", err.Error())
		return
	}
	if err := config.SaveCredentials(s.cfg.DataDir, config.Credentials{
		Username: body.Username, Password: body.Password,
	}); err != nil {
		log.Printf("[login] 凭据保存失败: %v", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "username": body.Username})
}

// handleLogout 退出登录并删除本地凭据。
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.wk.Logout()
	if err := config.ClearCredentials(s.cfg.DataDir); err != nil {
		log.Printf("[logout] 删除凭据失败: %v", err)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---------------------------------------------------------------- 发现

func (s *Server) handleTops(w http.ResponseWriter, r *http.Request) {
	sort := r.URL.Query().Get("sort")
	page := queryInt(r, "page", 1)
	res, err := s.wk.TopList(r.Context(), sort, page)
	if err != nil {
		s.writeUpstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleAllList(w http.ResponseWriter, r *http.Request) {
	full := r.URL.Query().Get("full") == "1"
	page := queryInt(r, "page", 1)
	res, err := s.wk.AllList(r.Context(), full, page)
	if err != nil {
		s.writeUpstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleTagList(w http.ResponseWriter, r *http.Request) {
	tag := r.URL.Query().Get("t")
	if tag == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "缺少标签参数 t")
		return
	}
	res, err := s.wk.TagList(r.Context(), tag, r.URL.Query().Get("v"), queryInt(r, "page", 1))
	if err != nil {
		s.writeUpstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"tags": wkk.Tags})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "请输入搜索关键词")
		return
	}
	res, err := s.wk.Search(r.Context(), q, r.URL.Query().Get("type"), queryInt(r, "page", 1))
	if err != nil {
		s.writeUpstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// ---------------------------------------------------------------- 书籍

func (s *Server) handleBook(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cached, _ := s.st.GetBook(id)

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	book, err := s.wk.Book(ctx, id)
	if err != nil {
		if cached != nil {
			// 抓取失败时降级用缓存，保证离线可读
			writeJSON(w, http.StatusOK, cached)
			return
		}
		s.writeUpstreamError(w, err)
		return
	}

	// 保留本地已有的卷章统计
	if vols, verr := s.st.GetVolumes(id); verr == nil && len(vols) > 0 {
		book.VolumeCount = len(vols)
		n := 0
		for _, v := range vols {
			n += len(v.Chapters)
		}
		book.ChapterCount = n
	}
	if err := s.st.UpsertBook(book); err != nil {
		log.Printf("[book] 保存失败: %v", err)
	}
	// 用户看过详情页，就算"已看到更新"，清掉红点
	_ = s.st.MarkSeen(id)
	writeJSON(w, http.StatusOK, book)
}

func (s *Server) handleVolumes(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	refresh := r.URL.Query().Get("refresh") == "1"

	if !refresh {
		if vols, err := s.st.GetVolumes(id); err == nil && len(vols) > 0 {
			writeJSON(w, http.StatusOK, map[string]any{"volumes": vols})
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	vols, err := s.wk.Volumes(ctx, id)
	if err != nil {
		if cached, _ := s.st.GetVolumes(id); len(cached) > 0 {
			writeJSON(w, http.StatusOK, map[string]any{"volumes": cached})
			return
		}
		s.writeUpstreamError(w, err)
		return
	}
	if err := s.st.SaveVolumes(id, vols); err != nil {
		log.Printf("[volumes] 保存失败: %v", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"volumes": vols})
}

func (s *Server) handleChapter(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cid := r.PathValue("cid")
	refresh := r.URL.Query().Get("refresh") == "1"

	var cc *wkk.ChapterContent

	if !refresh {
		if blocks, ok, err := s.st.GetChapter(id, cid); err == nil && ok {
			cc = &wkk.ChapterContent{ID: cid, Blocks: blocks}
		}
	}

	if cc == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		fetched, err := s.wk.Chapter(ctx, id, cid)
		if err != nil {
			s.writeUpstreamError(w, err)
			return
		}
		cc = fetched
		if err := s.st.SaveChapter(id, cid, cc.Blocks); err != nil {
			log.Printf("[chapter] 保存失败: %v", err)
		}
	}

	// 用本地目录校准标题、序号、上下章
	prev, next, index, total, title, err := s.st.ChapterNeighbors(id, cid)
	if err == nil && total > 0 {
		cc.Index, cc.Total = index, total
		if title != "" {
			cc.Title = title
		}
		cc.Prev, cc.Next = prev, next
	} else if cc.Prev == "" && cc.Next == "" {
		cc.Prev, cc.Next = prev, next
	}
	if cc.Title == "" {
		cc.Title = "第 " + strconv.Itoa(cc.Index+1) + " 章"
	}
	writeJSON(w, http.StatusOK, cc)
}

// ---------------------------------------------------------------- 阅读进度

func (s *Server) handleGetState(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, err := s.st.GetState(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	read, _ := s.st.ReadChapters(id)
	if read == nil {
		read = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"chapterId":    p.ChapterID,
		"index":        p.Index,
		"progress":     p.Progress,
		"readChapters": read,
		"readCount":    p.ReadCount,
		"totalCount":   p.TotalCount,
	})
}

func (s *Server) handlePutState(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		ChapterID string  `json:"chapterId"`
		Index     int     `json:"index"`
		Progress  float64 `json:"progress"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "请求体格式错误")
		return
	}
	if err := s.st.SaveState(id, body.ChapterID, body.Index, body.Progress); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleMarkRead(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		ChapterID string `json:"chapterId"`
		Read      *bool  `json:"read"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ChapterID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "缺少 chapterId")
		return
	}
	read := true
	if body.Read != nil {
		read = *body.Read
	}
	if err := s.st.MarkRead(id, body.ChapterID, read); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleMarkAllRead(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.st.MarkAllRead(id); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---------------------------------------------------------------- 书架

func (s *Server) handleShelves(w http.ResponseWriter, r *http.Request) {
	shelves, err := s.st.Shelves()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, shelves)
}

func (s *Server) handleCreateShelf(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "请求体格式错误")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "书架名称不能为空")
		return
	}
	id, err := s.st.CreateShelf(body.Name)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeError(w, http.StatusConflict, "conflict", "已存在同名书架")
			return
		}
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "name": body.Name})
}

func (s *Server) handleUpdateShelf(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "书架 id 无效")
		return
	}
	var body struct {
		Name   *string `json:"name"`
		Pinned *bool   `json:"pinned"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "请求体格式错误")
		return
	}
	if body.Name != nil {
		n := strings.TrimSpace(*body.Name)
		if n == "" {
			writeError(w, http.StatusBadRequest, "bad_request", "书架名称不能为空")
			return
		}
		body.Name = &n
	}
	if err := s.st.UpdateShelf(id, body.Name, body.Pinned); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleDeleteShelf(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "书架 id 无效")
		return
	}
	if err := s.st.DeleteShelf(id); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAddToShelf(w http.ResponseWriter, r *http.Request) {
	shelfID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "书架 id 无效")
		return
	}
	var body struct {
		BookID string `json:"bookId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.BookID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "缺少 bookId")
		return
	}

	// 先确保书籍元信息在本地，否则书架列表显示不出封面与书名
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()

	if existing, _ := s.st.GetBook(body.BookID); existing == nil {
		if book, berr := s.wk.Book(ctx, body.BookID); berr == nil {
			_ = s.st.UpsertBook(book)
		}
	}
	// 顺便把目录抓回来，书架才能立刻显示「已读 x/y」而不是只有「已读 x」
	if vols, verr := s.st.GetVolumes(body.BookID); verr != nil || len(vols) == 0 {
		if fetched, ferr := s.wk.Volumes(ctx, body.BookID); ferr == nil {
			_ = s.st.SaveVolumes(body.BookID, fetched)
		}
	}

	if err := s.st.AddToShelf(shelfID, body.BookID); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRemoveFromShelf(w http.ResponseWriter, r *http.Request) {
	shelfID, err1 := strconv.ParseInt(r.PathValue("id"), 10, 64)
	bookID := r.PathValue("bookId")
	if err1 != nil || bookID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "参数无效")
		return
	}
	if err := s.st.RemoveFromShelf(shelfID, bookID); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleLibrary(w http.ResponseWriter, r *http.Request) {
	entries, err := s.st.Library()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

// ---------------------------------------------------------------- 统计

func (s *Server) handleAddSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BookID    string `json:"bookId"`
		ChapterID string `json:"chapterId"`
		Seconds   int64  `json:"seconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.BookID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "缺少 bookId")
		return
	}
	if err := s.st.AddSession(body.BookID, body.ChapterID, body.Seconds); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleStatsSummary(w http.ResponseWriter, r *http.Request) {
	sum, err := s.st.StatsSummary(r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sum)
}

func (s *Server) handleCalendar(w http.ResponseWriter, r *http.Request) {
	year := queryInt(r, "year", time.Now().Year())
	days, err := s.st.Calendar(year)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"year": year, "days": days})
}

// ---------------------------------------------------------------- 更新

func (s *Server) handleUpdates(w http.ResponseWriter, r *http.Request) {
	entries, err := s.st.Library()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	out := []map[string]any{}
	for _, e := range entries {
		if !e.HasUpdate {
			continue
		}
		out = append(out, map[string]any{
			"bookId":   e.Book.ID,
			"title":    e.Book.Title,
			"cover":    e.Book.Cover,
			"chapters": e.Book.ChapterCount,
			"unread":   e.Book.ChapterCount - e.State.ReadCount,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleCheckUpdates 重新抓取书架内每本书的目录，判断是否有新章节。
func (s *Server) handleCheckUpdates(w http.ResponseWriter, r *http.Request) {
	entries, err := s.st.Library()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	var (
		mu      sync.Mutex
		updated []map[string]any
		wg      sync.WaitGroup
		sem     = make(chan struct{}, 3)
	)

	for _, e := range entries {
		e := e
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			vols, verr := s.wk.Volumes(ctx, e.Book.ID)
			if verr != nil {
				return
			}
			if err := s.st.SaveVolumes(e.Book.ID, vols); err != nil {
				return
			}

			// 与用户上次看过的最新章节比较
			total := 0
			for _, v := range vols {
				total += len(v.Chapters)
			}
			prev, _ := s.st.GetBook(e.Book.ID)
			if prev == nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			if prev.ChapterCount > e.Book.ChapterCount && e.Book.ChapterCount > 0 {
				updated = append(updated, map[string]any{
					"bookId":   e.Book.ID,
					"title":    e.Book.Title,
					"newCount": prev.ChapterCount - e.Book.ChapterCount,
					"chapters": total,
				})
			}
		}()
	}
	wg.Wait()

	if updated == nil {
		updated = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, updated)
}

// ---------------------------------------------------------------- 缓存

func (s *Server) handleCacheInfo(w http.ResponseWriter, r *http.Request) {
	entries, total, err := s.st.CacheStats()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	if entries == nil {
		entries = []store.CacheEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"books":      entries,
		"totalBytes": total,
	})
}

func (s *Server) handleClearCache(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.st.DeleteBookCache(id); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleCacheBook 后台缓存整本。重复请求不会开第二个任务。
func (s *Server) handleCacheBook(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.jobs.begin("cache:" + id) {
		writeJSON(w, http.StatusAccepted, map[string]any{"queued": false, "running": true})
		return
	}

	go func() {
		defer s.jobs.end("cache:" + id)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()

		if _, err := s.st.GetVolumes(id); err != nil {
			return
		}
		vols, err := s.st.GetVolumes(id)
		if err != nil || len(vols) == 0 {
			vols, err = s.wk.Volumes(ctx, id)
			if err != nil {
				log.Printf("[cache] 取目录失败 %s: %v", id, err)
				return
			}
			_ = s.st.SaveVolumes(id, vols)
		}

		cached, _ := s.st.CachedChapterIDs(id)
		have := map[string]bool{}
		for _, c := range cached {
			have[c] = true
		}

		count := 0
		for _, v := range vols {
			for _, ch := range v.Chapters {
				if have[ch.ID] {
					continue
				}
				select {
				case <-ctx.Done():
					return
				default:
				}
				cc, cerr := s.wk.Chapter(ctx, id, ch.ID)
				if cerr != nil {
					log.Printf("[cache] %s/%s 失败: %v", id, ch.ID, cerr)
					continue
				}
				if err := s.st.SaveChapter(id, ch.ID, cc.Blocks); err != nil {
					log.Printf("[cache] 保存 %s/%s 失败: %v", id, ch.ID, err)
					continue
				}
				count++
			}
		}
		log.Printf("[cache] 完成 %s，新增 %d 章", id, count)
	}()

	writeJSON(w, http.StatusAccepted, map[string]any{"queued": true})
}

// ---------------------------------------------------------------- 设置

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	kv, err := s.st.Settings()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, kv)
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var kv map[string]string
	if err := json.NewDecoder(r.Body).Decode(&kv); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "请求体格式错误")
		return
	}
	if err := s.st.SaveSettings(kv); err != nil {
		writeError(w, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---------------------------------------------------------------- 工具

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

// ---------------------------------------------------------------- 任务登记

type jobRegistry struct {
	mu   sync.Mutex
	live map[string]bool
}

func newJobRegistry() *jobRegistry {
	return &jobRegistry{live: map[string]bool{}}
}

func (j *jobRegistry) begin(key string) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.live[key] {
		return false
	}
	j.live[key] = true
	return true
}

func (j *jobRegistry) end(key string) {
	j.mu.Lock()
	delete(j.live, key)
	j.mu.Unlock()
}

// ---------------------------------------------------------------- 访问令牌

// handleGetToken 返回当前令牌，供设置页展示与复制（该接口本身需要鉴权）。
func (s *Server) handleGetToken(w http.ResponseWriter, r *http.Request) {
	tok := s.currentToken()
	if tok == "" {
		writeError(w, http.StatusBadRequest, "token_disabled", "当前未启用访问令牌")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":    tok,
		"required": true,
	})
}

// handleRotateToken 重新生成 256 位令牌并落盘，旧令牌立即失效。
func (s *Server) handleRotateToken(w http.ResponseWriter, r *http.Request) {
	if s.currentToken() == "" {
		writeError(w, http.StatusBadRequest, "token_disabled", "当前未启用访问令牌")
		return
	}
	tok, err := config.GenerateToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "生成令牌失败")
		return
	}
	if err := config.SaveToken(s.cfg.DataDir, tok); err != nil {
		log.Printf("[token] 保存失败: %v", err)
		writeError(w, http.StatusInternalServerError, "internal", "令牌保存失败")
		return
	}
	s.setToken(tok)
	// 当前浏览器直接换用新 Cookie，避免把自己踢下线
	setAuthCookie(w, r, tok)
	log.Printf("[token] 访问令牌已重新生成")
	writeJSON(w, http.StatusOK, map[string]any{"token": tok})
}

// handleUnlock 校验令牌并写入 HttpOnly Cookie，之后整站免输入。
func (s *Server) handleUnlock(w http.ResponseWriter, r *http.Request) {
	want := s.currentToken()
	if want == "" {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "请求体格式错误")
		return
	}
	got := strings.TrimSpace(body.Token)
	if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized", "令牌不正确")
		return
	}
	setAuthCookie(w, r, want)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleLock 清除本机令牌 Cookie。
func (s *Server) handleLock(w http.ResponseWriter, r *http.Request) {
	clearAuthCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
