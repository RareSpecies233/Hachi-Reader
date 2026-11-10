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

常见 `code`：

| code | HTTP | 含义 |
|---|---|---|
| `bad_request` | 400 | 参数错误 |
| `unauthorized` | 401 | 访问令牌无效 |
| `login_required` | 403 | 未配置 wenku8 凭据，或已配置但登录态失效（列表返回登录页/空内容） |
| `copyright` | 403 | 版权原因不可获取 |
| `not_found` | 404 | 书籍/章节不存在 |
| `rate_limited` | 429 | 被上游 Cloudflare 限流（error 1015）；响应带 `Retry-After` |
| `upstream_blocked` | 502 | 被 Cloudflare 403/挑战页拦截 |
| `upstream_error` | 502 | 其它上游错误（超时、5xx 等） |

> 说明：`login_required` 同时覆盖"没配凭据"和"配了但登录态失效"。
> 区分方式见 `GET /api/wk8/status` 的 `source` 与 `lastProbeOk`；
> 失效时 message 会明确提示"登录态已失效"。

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

`GET /api/health`（免鉴权）：

```json
{
  "ok": true,
  "version": "0.1.0",
  "tokenRequired": true,
  "dev": false,
  "wenku8": {
    "login": false,
    "host": "https://www.wenku8.net",
    "cookie": "bundled",
    "hosts": ["https://www.wenku8.net", "https://www.wenku8.cc"],
    "cookieHosts": ["https://www.wenku8.net", "https://www.wenku8.cc"],
    "requests": 12,
    "failed": 3,
    "rejected": 40,
    "successRate": 0.75,
    "recentSuccessRate": 0.6,
    "lastError": "wenku8 当前限流（Cloudflare 1015，已退避 10 秒）",
    "lastErrorAt": "2026-11-10T15:34:23+08:00",
    "blocked": false,
    "blockedUntil": "",
    "backoffSeconds": 0,
    "lastProbeAt": "2026-11-10T15:34:30+08:00",
    "lastProbeOk": false,
    "lastProbeNote": "wenku8 当前限流：还需等待约 3 秒"
  }
}
```

原有 `login` / `host` / `cookie` 字段保持不变，其余为新增的可观测性信息，可安全忽略。

### wenku8 状态

`GET /api/wk8/status`（需鉴权）返回同一份 wenku8 上游快照，字段与 health 里的 `wenku8` 对象一致，另外包含 `strikes`（连续触发次数）。

```json
{
  "source": "bundled",
  "host": "https://www.wenku8.net",
  "hosts": ["https://www.wenku8.net", "https://www.wenku8.cc"],
  "cookieHosts": ["https://www.wenku8.net", "https://www.wenku8.cc"],
  "login": false,
  "requests": 12,
  "success": 9,
  "failed": 3,
  "rejected": 40,
  "successRate": 0.75,
  "recentSuccessRate": 0.6,
  "lastError": "wenku8 当前限流（Cloudflare 1015，已退避 10 秒）",
  "lastErrorAt": "2026-11-10T15:34:23+08:00",
  "blocked": false,
  "blockedUntil": "",
  "backoffSeconds": 0,
  "strikes": 1,
  "lastProbeAt": "2026-11-10T15:34:30+08:00",
  "lastProbeOk": false,
  "lastProbeNote": "wenku8 当前限流：还需等待约 3 秒"
}
```

字段含义：

- `source`：`bundled`（内置公共 Cookie）/ `cookie`（自定义 Cookie）/ `account`（账号登录）/ `none`
- `cookieHosts`：cookie jar 里真正带登录 Cookie 的 host（用于确认域切换是否丢登录态）
- `requests` / `success` / `failed`：只统计真正发到上游的请求
- `rejected`：退避期内被本地快速拒绝的请求数（未打到上游）
- `recentSuccessRate`：最近 20 次上游请求的成功率
- `blocked` / `backoffSeconds` / `strikes`：Cloudflare 限流退避状态
- `lastProbeAt` / `lastProbeOk` / `lastProbeNote`：最近一次列表探测的时间、结果与详情

启动时服务会自动做一次排行榜第 1 页探测；失败会在日志里明确提示（可用 `HACHI_NO_STARTUP_PROBE=1` 关闭）。

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
已配置凭据但登录态失效（列表页返回登录页或 HTTP 200 空内容）同样返回 403 `login_required`，message 会说明"登录态已失效"，不会伪装成空列表。

上游限流时返回 429 `rate_limited` 并带 `Retry-After`；服务端会本地退避，期间请求快速失败（不消耗上游配额）。

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

## 访问令牌接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/token` | 返回当前令牌 `{ token, required }`（需鉴权） |
| POST | `/api/token/rotate` | 重新生成 256 位令牌并落盘，旧令牌立即失效（需鉴权） |

`GET /api/health` 是唯一免鉴权接口，返回 `tokenRequired` 布尔值，前端据此决定是否弹解锁页。

令牌传递方式（任选其一）：`Authorization: Bearer <token>`、`?token=<token>`、Cookie `hachi_token`。图片代理无法带请求头，所以前端对 `/api/img` 用查询参数。

### 登录接口补充

`POST /api/login` 除 `{username,password}` 外，也接受 `{cookie}` 直接注入 Cookie 头（账号登录遇到验证码时使用），成功后保存到 `data/wenku8.cookie`。

## 字体库接口

字体保存在 `data/fonts/`：文件 `<id>.<ext>` + `index.json`（`[{id,name,ext,size,addedAt}]`）。
旧版单字体数据（`custom.*` + `meta.json`）会在首次读取时自动迁移成一条记录。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/fonts` | `{ fonts: [{id,name,ext,size,addedAt}] }`，**no-store** |
| POST | `/api/fonts` | `multipart/form-data`，字段 `file`；上限 80MB，按魔数校验格式；同名（忽略大小写）视为替换并沿用原 id；返回 `{ font, fonts, replaced }` |
| DELETE | `/api/fonts/{id}` | 删除一个字体，返回 `{ ok: true, fonts: [...] }`；不存在返回 404 |
| GET | `/api/fonts/{id}/file` | 字体文件本体（`font/ttf` 等），长缓存 + ETag；前端 URL 带 `?v=<addedAt>`，内容变化时 URL 跟着变 |

兼容接口（都映射到列表里的第一个字体，老客户端仍可用）：`GET /api/font`、`GET /api/font/file`、`POST /api/font`、`DELETE /api/font`。

前端为每个字体注入 `@font-face { font-family: "HachiFont-<id>" }`，选中项存在 `settings.customFontId`，
`--font-read` 覆盖为 `"HachiFont-<id>", <衬线栈>`。

**衬线字体运行时探测**：iOS WebKit 不一定暴露 `"Songti SC"` 这个 family 名，直接写 CSS 会整篇落到 PingFang。
前端用 canvas 以 `64px "<候选>"` 与两个参考系（必然缺失的字体、`"PingFang SC"`）各画同一个汉字，
比较 ImageData 的 alpha 签名：与任一参考系完全相同即视为没命中。候选覆盖 `Songti SC`、
`STSongti-SC-Regular`、`STSongti-SC`、`STSong`、`Songti TC`、`Kaiti SC`、`Hiragino Mincho ProN`，
取第一个真正命中的 family 拼进 `--font-read`；一个都没有时保持系统字体并提示上传自定义字体。
结果缓存在 `localStorage['hachi.fontprobe.v1']`（候选列表/算法版本变化时自动失效重算）。

## 缓存语义

服务端按接口语义显式区分，供 Service Worker 与浏览器正确缓存：

- **可缓存**（内容类）：`/api/book/*`（不含 `/state`、`/read`）、`/api/explore/*`、`/api/search`、`/api/tags`、`/api/img`
- **`Cache-Control: no-store`**（状态/机密类）：`/api/health`、`/api/token*`、`/api/unlock`、`/api/lock`、`/api/font*`（字体列表与上传；`/api/fonts/{id}/file` 本身走长缓存）、`/api/shelves*`、`/api/library`、`/api/updates*`、`/api/cache*`、`/api/settings`、`/api/stats/*`

不区分会出现"加了书但书架不更新"这类幽灵问题。
