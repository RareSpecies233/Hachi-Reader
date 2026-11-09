# 架构说明

## 为什么是"服务端抓取 + PWA 渲染"

三条硬约束决定了这个架构：

1. **CORS**：浏览器直接 `fetch` wenku8 会跨域失败，站点不会给我们的域名开 CORS。
2. **Cloudflare**：站点在 Cloudflare 后面，抓取需要伪装浏览器指纹（见下节），而浏览器里的 `fetch` 做不到，反而会因为同源策略连响应都读不到。
3. **离线与一致性**：iOS PWA 的存储可能被系统回收，阅读进度、书架这类数据放服务端才不会丢。

所以服务端负责"取"，PWA 负责"显示"，中间的 SQLite + 磁盘缓存负责"快"和"离线"。

## Cloudflare 与 TLS 指纹

这是本项目最大的技术坑，记录下来避免以后重复踩。

### 现象

| 客户端 | 结果 |
|---|---|
| `curl` + 桌面 Chrome UA | `403 Just a moment...` |
| `curl` + iPhone Safari UA | `200` |
| Go `net/http` + iPhone Safari UA | `403` |
| Go + uTLS（`HelloSafari_Auto`，ALPN 仅 h1） | 读到 HTTP/2 帧，报 malformed response |
| Go + uTLS + `http2.Transport` | `403` |
| Go + `bogdanfinn/tls-client`（Safari iOS 配置） | **`200`** |

### 结论

Cloudflare 的判定不只看 UA，而是综合 TLS ClientHello（JA3/JA4）、HTTP/2 SETTINGS 与优先级帧、请求头顺序与大小写。`net/http` 的指纹是公开且高度特征的，会被直接打上挑战页；uTLS 只解决了 TLS 层，HTTP/2 层仍然是 Go 的默认特征，所以照样被拦。

`tls-client` 同时伪造 TLS 与 HTTP/2 层，因此能通过。它内部用 uTLS + 自定义 `fhttp`，纯 Go，`CGO_ENABLED=0` 可交叉编译到三平台——这满足"一个二进制跑 Windows/Linux/macOS"的要求。

### 代价与对策

- 依赖体积变大（uTLS、fhttp、quic-go）。可接受，因为换来的是能稳定读到内容。
- 指纹配置可切换：`HACHI_PROFILE=safari_ios|safari|chrome`。站点规则变化时可以换一个再试。
- 被拦时错误会映射为 `upstream_blocked`，前端提示"可配置代理或稍后重试"，而不是白屏。

## 抓取层

```
Client
 ├─ 域名轮换   www.wenku8.net ↔ www.wenku8.cc（失败即换）
 ├─ 并发上限   3（Semaphore）
 ├─ 页面间隔   120ms；搜索额外强制 5.2s（站点提示"间隔不得少于 5 秒"）
 ├─ 编码       GBK → UTF-8
 ├─ 重试       403/挑战页/网络错误 → 换域名重试
 └─ 登录       可选，Cookie 由 tls-client 的 jar 管理
```

### 页面结构（2026-11 实测）

| 页面 | 路径 | 关键结构 |
|---|---|---|
| 书籍 | `/book/{id}.htm` | `#content > div > table[0]` 首行书名、次行元信息；`table[1]` 封面与简介 |
| 目录 | `/novel/{id/1000}/{id}/index.htm` | `td.vcss[vid]` 为卷，`td.ccss > a` 为章 |
| 正文 | `/novel/{id/1000}/{id}/{cid}.htm` | `#title` 标题、`#content` 正文、`#foottext` 上下章 |
| 搜索 | `/modules/article/search.php` | 需登录；命中单本时出现"小说目录"入口 |

正文里 `<br/>` 是换行、`&nbsp;×4` 是缩进、`div.divimage` 是插图；`ul#contentdp` 是站点水印，`#adv*` 是广告，解析时丢弃。

### 未登录的限制

书籍详情 / 目录 / 正文匿名可读；但 `toplist.php`、`articlelist.php`、`tags.php`、`search.php` 未登录会返回一个"本站正式关闭"的登录页（HTTP 仍是 200）。抓取层会识别这段文案并抛出 `ErrLoginRequired`，API 映射为 `403 login_required`，前端显示引导卡片而不是错误。

## 存储

单文件 SQLite（`modernc.org/sqlite`，纯 Go，无 CGO）。

```
books            书籍元信息 + 卷章计数 + last_chapter/seen_chapter（更新红点）
volumes          分卷
chapters         章节（idx 为全书连续序号，用于上下章与进度）
chapter_contents 正文缓存（JSON blocks）
shelves          书架
shelf_books      书架×书
read_state       每本书的阅读位置
read_chapters    已读章节
sessions         阅读会话（统计）
settings         服务端设置
```

要点：

- `books` 的 `volume_count` / `chapter_count` 在只更新元信息时不会被清零（UPSERT 里用 `CASE WHEN > 0`）。
- 正文以 `[{type,text}|{type,image,src}]` 的块数组存 JSON，前端直接渲染，避免二次解析 HTML。
- 上下章以本地目录为准推算，不依赖网页上的"上一页/下一页"（首章的"上一页"会指向目录）。

## 前端

无构建步骤的原生 ES 模块，`go:embed` 进二进制。

- `js/core/router.js`：hash 路由，`#/shelf`、`#/book/:id`、`#/read/:bookId/:chapterId`。
- `js/core/api.js`：统一 `ApiError{code,message}`，`login_required` 等语义错误由视图分别处理。
- `js/core/store.js`：阅读偏好存 localStorage（秒开、离线可用），服务端只存默认值。
- `js/views/*.js`：每页导出 `render(root, ctx)` 与可选 `destroy()`。
- `js/reader/`：`scroll-mode` 分片渲染 + 无缝追加；`flip-mode` 用 `column-width` 多列分页 + `translate3d` 翻页，不测行高。

### 主题

`applyTheme()` 在 `<html>` 上写 `data-theme="light|sepia|dark"`，CSS 用属性选择器消费令牌；`prefers-color-scheme` 只作为 JS 执行前的兜底，避免首屏闪白。

### PWA

- 外壳预缓存（逐条 `allSettled`，缺文件不阻断安装）
- 静态资源 stale-while-revalidate
- 导航 network-first，离线回退缓存的外壳
- `/api/img` cache-first（长期不变），`/api/*` network-first + 有缓存时 3 秒超时回退
- 非 GET 不拦截、不缓存

## 演进方向

- 书籍更新检查目前是按需触发（`POST /api/updates/check`），可加定时任务。
- 多用户：当前是单用户单令牌，多用户需要给 `shelves`/`read_state` 加 owner 维度。
- 数据源抽象：`internal/wkk` 的接口形状已经接近可替换，接入第二个站点时把 `Client` 抽象成接口即可。
