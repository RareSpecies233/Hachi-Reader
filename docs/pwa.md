# PWA 技术方案

这份文档说明 Hachi Reader 为什么做成 PWA、具体怎么实现、以及在 iOS 上有哪些绕不开的限制。

## 1. 为什么是 PWA

需求是"在 iPhone 上舒服地读，服务端自己托管"。三选一：

| 方案 | 结论 |
|---|---|
| 原生 App（Swift） | 只覆盖 iOS，要签名/TestFlight/上架，迭代慢；服务端同源能力用不上 |
| 跨端框架（React Native 等） | 仍是原生 App，仍要分发，仍然与 Go 服务端两份代码 |
| **PWA** | 手机加主屏即用、桌面也能用、与 Go 同源同构、更新即刷新 |

关键是**同源**：PWA 和 API 在同一个域名下，没有 CORS，Service Worker 能直接接管 `/api/*` 的缓存与离线回退。这是原生 App 拿不到的便利。

## 2. 分层结构

```
┌─────────────────────────────────────────────┐
│ App Shell（index.html + 4 个 CSS + core JS）│  预缓存，离线可开
├─────────────────────────────────────────────┤
│ 视图 / 阅读器（按需动态 import）             │  运行时缓存
├─────────────────────────────────────────────┤
│ Service Worker（sw.js）                      │  4 个缓存分区 + 路由策略
├─────────────────────────────────────────────┤
│ Go 服务端（抓取 + SQLite + 图片磁盘缓存）     │  真正的数据源与真相
└─────────────────────────────────────────────┘
```

**原则：PWA 是显示层，不是数据层。** 书架、进度、统计、缓存正文都在服务端 SQLite 里；浏览器只缓存"能加速的"和"能离线看的"，所以清缓存/换设备都不会丢数据。

## 3. 可安装性

`manifest.webmanifest`：

| 字段 | 值 |
|---|---|
| `name` / `short_name` | Hachi Reader / Hachi |
| `start_url` | `/#/shelf` |
| `scope` | `/` |
| `display` | `standalone`（无地址栏） |
| `orientation` | `portrait` |
| `background_color` / `theme_color` | `#f6f1e7` |
| `icons` | 192/512 `any` + 192/512 `maskable` |
| `shortcuts` | 书架、探索 |

`index.html` 里补 iOS 专用 meta：`apple-mobile-web-app-capable`、`apple-mobile-web-app-status-bar-style`、`apple-touch-icon`（180px）、`viewport-fit=cover`（配合 `env(safe-area-inset-*)`）。

**iOS 没有 `beforeinstallprompt`**，只能引导用户：Safari 分享 → 添加到主屏幕。`pwa.js` 的 `installHint()` 会区分 iOS/Android/桌面并返回对应文案，非安全上下文时明确提示原因。

## 4. Service Worker 缓存策略

四个分区，互不干扰，`SW_VERSION` 变更时整体淘汰：

| 分区 | 内容 | 策略 |
|---|---|---|
| `hachi-shell` | index.html、CSS、core JS、manifest、图标 | 安装时预缓存 |
| `hachi-static` | 视图/阅读器等按需加载的 JS、其余静态资源 | stale-while-revalidate |
| `hachi-api` | `GET /api/*`（图片除外） | network-first + 有条件超时 |
| `hachi-img` | `/api/img` | cache-first + 配额 |

### 路由判定顺序

```
非 GET            → 完全不拦截（写操作必须直达服务端）
跨域              → 不拦截（交给浏览器）
mode === navigate → 导航策略（network-first，6s 超时回退外壳）
/api/img          → 图片 cache-first
/api/*            → 接口策略
静态后缀          → stale-while-revalidate
其他              → 直连不干预
```

### 导航

网络优先，6 秒超时后用缓存的 `/index.html` 兜底；连外壳都没缓存时返回一个自绘的离线页。这样"服务器挂了但手机里有外壳"也能打开并看到已缓存的书。

### 接口：有缓存才设超时

这是整个方案里最需要拿捏的一处：

```js
if (cached) {
  // 3 秒拿不到网络就先给旧数据，网络请求继续在后台跑完并写缓存
  return await Promise.race([network, timeout]);
}
// 冷缓存不设超时：服务端此刻可能正在现场抓 wenku8，可能要好几秒
return await network;
```

原因是服务端抓 wenku8 的首次请求可能要 2–5 秒（含 Cloudflare 指纹握手、GBK 解码、解析）。如果对冷缓存也设 3 秒，第一次打开一本书会被误判为失败。有缓存时则可以激进一点，用旧数据换速度。

只缓存 **2xx 且非 `no-store`** 的 GET 响应；`401/403/500` 一律不落盘——否则令牌失效后会把错误页缓存成"正常数据"。

### 图片：cache-first

图片不可变，直接命中缓存返回。落盘前检查体积（单张 ≤ 2MB）并限制总条数（240），避免 iOS 的存储配额被图片撑爆。

**缓存键会剔除 `?token=`**：令牌轮换后不会把同一张图重新存一份。

### 预缓存用 `allSettled` 逐条添加

某个文件暂时缺失（例如开发中的 `reader.css`）只告警，不让整个 SW 安装失败——否则一次 404 就会让 PWA 永远装不上。

## 5. 离线能力分级

| 场景 | 表现 |
|---|---|
| 服务器在线 | 全功能 |
| 断网，外壳已缓存 | 能打开，书架/详情显示上次数据 |
| 断网，章节已缓存 | 正常阅读（正文来自服务端 SQLite，经 `/api` 缓存或网络） |
| 断网，章节未缓存 | 阅读器显示可读错误 + 重试按钮 |

真正的"整本离线"靠服务端缓存（`POST /api/cache/{id}` 后台抓完存 SQLite）+ 浏览器 SW 对 `/api` 的缓存。iOS 的存储可能被系统回收，所以**不把浏览器当作唯一存储**。

## 6. 更新策略：故意不 `skipWaiting`

新的 SW 装好后进入 waiting，不会立刻接管页面。`pwa.js` 监听 `updatefound`，检测到新版本就 toast 提示"新版本已就绪，刷新后生效"。

原因：阅读器正在翻页时如果资源被中途替换，会出现章节错配、样式闪变。宁可让用户自己选时机刷新。

发布新版本时把 `sw.js` 里的 `SW_VERSION` 加一，激活阶段会清掉所有旧分区。

## 7. iOS 的硬限制与对策

| 限制 | 影响 | 对策 |
|---|---|---|
| 必须 HTTPS/localhost | `http://192.168.x.x` 无法注册 SW，装不了 | 域名 + Caddy / Cloudflare Tunnel / Tailscale；文档给了三条路 |
| 无 `beforeinstallprompt` | 不能一键安装 | 检测 iOS，展示四步图文引导 |
| 无 Web Push（16.4 起才有，且需主屏 + 用户手势） | 后台更新提醒不可靠 | 更新检查放在服务端，打开 App 时提示 |
| 无 `navigator.wakeLock`（支持不稳定） | "屏幕常亮"可能无效 | 特性检测，不支持时静默降级 |
| 拿不到电量 | 电池指示器做不了 | 只保留时间/章节/进度三个指示器 |
| 存储可能被系统回收 | 浏览器缓存不可靠 | 数据以服务端 SQLite 为准 |
| 无常驻后台 | 不能后台预取 | 预取只在阅读时进行，串行、可取消 |
| `100vh` 含地址栏 | 布局跳动 | 统一 `100dvh` + 安全区变量 |
| 长按选词/双击缩放会抢手势 | 翻页误触 | `user-select: none` + `touch-action` 分模式设置 |

## 8. 与令牌机制的配合

- 令牌走 `Authorization: Bearer`（`<img>` 无法设头，所以图片用 `?token=`）。
- SW **不会**缓存 401 响应，令牌失效后不会出现"看起来正常但全是旧数据"的假象。
- 令牌轮换后，页面上的 `hachi:unauthorized` 事件会立刻弹出解锁页。
- 外壳（HTML/CSS/JS）本身不含任何秘密，公开无妨；**所有数据接口都在令牌后面**。

## 9. 性能预算（实测）

| 项 | 体积 |
|---|---|
| 外壳 HTML + 4 CSS + core JS | ≈ 91 KB（未压缩） |
| 视图按需加载 | 4 个文件，共 ≈ 66 KB |
| 阅读器按需加载 | 6 个模块 + reader.css ≈ 60 KB |
| 图标 | 5 个 PNG，共 ≈ 54 KB |

首屏只加载外壳与当前视图，阅读器只在进入阅读时加载。没有打包器、没有 polyfill、没有运行时框架。

## 10. 已知取舍

- **没有离线编辑队列**：书架增删、进度上报都要求在线，失败就提示。单用户场景下这样更简单、不会产生冲突。
- **没有 IndexedDB 正文库**：正文缓存放在服务端，浏览器侧只靠 SW 的 HTTP 缓存。好处是三端共享、清缓存不丢；代价是首次断网只有读过的章节能看。
- **SW 缓存的是 API 响应而不是结构化数据**：省事，但意味着"缓存命中"依赖 URL 一致（包括查询参数）。

## 11. 如果要继续演进

1. 用 IndexedDB 存"已下载的整本"，支持真正的离线书架。
2. 服务端定期检查更新 + Web Push（iOS 16.4+）做真正的更新提醒。
3. 把 `hachi-api` 的缓存策略改成 stale-while-revalidate，让翻页时的请求永不阻塞。
