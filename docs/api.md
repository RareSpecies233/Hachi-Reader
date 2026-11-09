# Hachi Reader — HTTP API 契约

所有接口前缀 `/api`，请求与响应均为 `application/json; charset=utf-8`（图片代理除外）。

## 鉴权

单用户私有部署。若服务端配置了 `HACHI_TOKEN`，则每个请求需带上下列任一：

- `Authorization: Bearer <token>`
- Cookie: `hachi_token=<token>`
- Query: `?token=<token>`

未配置 token 时不做校验（仅建议在可信局域网这样跑）。

## 错误格式

非 2xx 响应体统一为：

```json
{ "error": { "code": "login_required", "message": "需要登录 wenku8 账号" } }
```

常见 `code`：`bad_request` `not_found` `upstream_error` `login_required` `rate_limited` `unauthorized`。

## 数据模型

### BookCard

```json
{
  "id": "1",
  "title": "文学少女",
  "subtitle": "",
  "author": "野村美月",
  "publisher": "Fami通文库",
  "cover": "https://img.wenku8.com/image/0/1/1s.jpg",
  "description": "...",
  "tags": ["校园", "悬疑"],
  "wordCount": 2015475,
  "updatedAt": "2022-02-27",
  "isComplete": true,
  "isAnime": true
}
```

### Volume / Chapter

```json
{ "volumes": [ { "id": "1", "title": "第一卷 渴望死亡的小丑",
  "chapters": [ { "id": "2", "title": "序章 ...", "index": 0 } ] } ] }
```

`index` 为全书连续的章节序号，从 0 开始。

### ChapterContent

```json
{
  "id": "2", "title": "序章 ...", "index": 0, "total": 213,
  "blocks": [
    { "type": "text", "text": "台版 转自 天使动漫论坛" },
    { "type": "text", "text": "　　我这辈子做了太多丢脸的事情。" },
    { "type": "image", "src": "/api/img?u=https%3A%2F%2Fpic..." }
  ],
  "prev": "1", "next": "3"
}
```

`prev` / `next` 为相邻章节 id，无则为 `null`。

## 接口

### 健康检查

`GET /api/health` → `{ "ok": true, "version": "0.1.0", "wenku8": { "login": false, "host": "www.wenku8.net" } }`

### 发现

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/explore/tops?sort=allvisit&page=1` | 排行榜，`sort` ∈ `allvisit`(热门) `anime`(动画化) `lastupdate`(今日更新) `postdate`(新书) |
| GET | `/api/explore/list?full=1&page=1&pub=&size=&status=` | 全部轻小说，`full=1` 为完结全本 |
| GET | `/api/explore/tag?t=校园&v=&page=1` | 标签列表，`v` ∈ `""` `1`(热度) `3`(仅动画化) |
| GET | `/api/tags` | `{ "tags": ["校园", ...] }` 内置标签 |
| GET | `/api/search?q=文学少女&type=articlename&page=1` | 搜索，命中单本时返回 `single` |

列表响应统一为 `{ "items": [BookCard], "page": 1, "hasMore": true }`。

**需要 wenku8 登录**；未登录返回 403 `login_required`。

### 书籍

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/book/{id}` | BookCard + `{ "volumeCount": 18, "chapterCount": 213 }` |
| GET | `/api/book/{id}/volumes` | 分卷目录 |
| GET | `/api/book/{id}/chapter/{cid}` | ChapterContent |
| GET | `/api/book/{id}/state` | 阅读进度 `{ chapterId, index, progress, readChapters: [] }` |
| PUT | `/api/book/{id}/state` | 保存进度 `{ chapterId, index, progress }` |
| POST | `/api/book/{id}/read` | `{ chapterId, read: true }` 标记单章 |
| POST | `/api/book/{id}/read-all` | 全部标为已读 |

### 书架

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/shelves` | `[{ id, name, pinned, sort, count }]` |
| POST | `/api/shelves` | `{ name }` |
| PATCH | `/api/shelves/{id}` | `{ name?, pinned? }` |
| DELETE | `/api/shelves/{id}` | 连书一并移除（不删云端缓存） |
| POST | `/api/shelves/{id}/books` | `{ bookId }` |
| DELETE | `/api/shelves/{id}/books/{bookId}` | |
| GET | `/api/library` | 所有书架里的书 `[{ book: BookCard, shelves: [id], state, hasUpdate }]` |

### 统计

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/stats/session` | `{ bookId, chapterId, seconds }` 上报阅读时长 |
| GET | `/api/stats/summary?from=&to=` | `{ totalSeconds, byDay: [{date,seconds}], byBook: [{bookId,title,seconds}] }` |
| GET | `/api/stats/calendar?year=2026` | `{ days: [{date,seconds}] }` |

### 更新提醒

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/updates` | 基于书架缓存比对 `[{ bookId, title, latestChapter, newCount }]` |
| POST | `/api/updates/check` | 主动刷新并返回同样结构 |

### 缓存与设置

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/cache/{id}` | 整本缓存，返回 `{ queued: true }` |
| GET | `/api/cache` | 缓存占用 `{ books: [{ bookId, title, chapters, bytes }], totalBytes }` |
| DELETE | `/api/cache/{id}` | 清除某书缓存 |
| GET | `/api/settings` | 服务端设置（阅读偏好默认值） |
| PUT | `/api/settings` | 同上 |

### 图片代理

`GET /api/img?u=<urlencoded absolute url>` → 图片字节，服务端落盘缓存，`Cache-Control: public, max-age=31536000, immutable`。

只允许 `wenku8.net` / `wenku8.cc` / `wenku8.com` / `img.wenku8.com` / `pic.*` 等白名单域名，防止被当成开放代理。

## 契约细节（联调时确认过的语义）

| 字段 | 语义 |
|---|---|
| `search.single` | **完整的 Book 对象**（不是 id）。命中单本时才出现；否则只有 `items`。前端两种写法都兼容，但以对象为准。 |
| `state.progress` | **0~1 的小数**（不是百分比）。翻页模式表示当前页在章内的比例，滚动模式表示滚动位置比例。 |
| `state.readChapters` | **章节 id 字符串数组**，与 `volumes[].chapters[].id` 同源。 |
| `state.index` | 全书连续章节序号，从 0 开始。 |
| `library[].lastReadAt` | Unix 秒。没有阅读记录时为 0；「最近阅读」按它倒序。 |
| `library[].book.chapterCount` | 总章数，用于显示「已读 12/213」。探索列表里的 Book 不带该字段。 |
| `library[].state.readCount` | 已读章节数。 |
| `updates[].newCount` | 数字（新增章节数）。 |
| `hasUpdate` | 由 `last_chapter != seen_chapter` 推出；打开书籍详情（`GET /api/book/{id}`）会把它清零。 |

### 认证补充

`POST /api/login` 与 `POST /api/logout` 走同一套令牌校验（配置了 `HACHI_TOKEN` 时也要带）。登录成功后凭据写入 `data/wenku8.json`（0600），重启后自动恢复。
