# Hachi Reader

在 iOS（以及任何现代浏览器）上舒适阅读 [轻小说文库 wenku8](https://www.wenku8.net) 的自托管阅读器。

一个 Go 二进制：内嵌前端、服务端抓取与缓存、SQLite 持久化、可安装为 PWA。
界面遵循 **Material Design 3**（三套主题），启动时打印 FIGlet 横幅与扫码二维码。

```
┌──────────────────────────────┐
│  iPhone Safari / 主屏幕 PWA  │
│  · 书架 · 探索 · 阅读器       │
└──────────────┬───────────────┘
               │ HTTPS
┌──────────────▼───────────────┐
│        hachi (Go, 单文件)     │
│  API · 静态资源(embed)        │
│  抓取层(浏览器指纹伪装)        │
│  SQLite · 图片磁盘缓存         │
└──────────────┬───────────────┘
               │
        wenku8.net (Cloudflare)
```

## 快速开始

```bash
# 需要 Go 1.22+
go build -o hachi ./cmd/hachi

# 开发模式：前端直接读 ./web，改完刷新即可
HACHI_DEV=1 ./hachi -addr :8080 -data ./data

# 生产模式：前端已嵌入二进制
./hachi -addr :8080 -data ./data
```

打开 <http://localhost:8080>。要装到 iPhone 主屏幕，必须通过 **HTTPS** 访问（iOS 只在安全上下文注册 Service Worker），见 [部署文档](docs/deploy.md)。

## 配置

全部通过环境变量，便于 Docker / systemd / launchd / Windows 服务统一注入。

| 变量 | 默认 | 说明 |
|---|---|---|
| `HACHI_ADDR` | `:8080` | 监听地址 |
| `HACHI_DATA` | `./data` | 数据目录（SQLite、图片缓存、凭据） |
| `HACHI_TOKEN` | 自动生成 | 访问令牌。留空时读取 `data/token`，不存在则自动生成 256 位并打印 |
| `HACHI_WK8_USER` | 空 | wenku8 用户名。**探索与搜索必需** |
| `HACHI_WK8_PASS` | 空 | wenku8 密码 |
| `HACHI_WK8_COOKIE` | 空 | 直接注入 Cookie，绕开账号登录（有验证码时用） |
| `HACHI_NO_BUNDLED_COOKIE` | 空 | 设为 `1` 关闭内置公共 Cookie 兜底 |
| `HACHI_NO_AUTH` | 空 | 设为 `1` 关闭令牌校验（仅限可信局域网） |
| `HACHI_PROXY` | 空 | 抓取走的代理，如 `http://127.0.0.1:7890` |
| `HACHI_PROFILE` | `safari_ios` | TLS 指纹：`safari_ios` / `safari` / `chrome` |
| `HACHI_DEV` | 空 | 为 `1` 时前端从磁盘 `web/` 读取且不缓存 |
| `HACHI_TIMEOUT` | `25` | 单次抓取超时（秒） |
| `HACHI_CACHE_TTL` | `600` | 服务端内容缓存秒数（0=关闭）。重复请求直接命中，不打扰 wenku8 |
| `HACHI_CACHE_SIZE` | `512` | 缓存条目上限 |

命令行参数：`-addr`、`-data`、`-token`、`-no-auth`。

也可以在 App 的「设置 → wenku8 账号」里填账号或 Cookie，会保存到 `data/wenku8.json` / `data/wenku8.cookie`（权限 0600）。**环境变量与参数优先。**

### 启动与扫码

启动后会打印 FIGlet 横幅、访问令牌，以及一张**终端二维码**：

```
手机扫码直接进入（相机对准下方二维码）：
████████████████ ...
   http://192.168.1.20:8080?token=xxxxx
```

手机相机扫一下就会带着令牌打开，并自动写进 HttpOnly Cookie，**之后不再需要输入**。二维码地址优先取 `HACHI_PUBLIC_URL`，否则自动探测局域网 IP。

### 访问令牌

首次启动会打印 FIGlet 横幅并生成一个 256 位令牌：

```
   访问令牌: 47lic_tAjkLIj3GEauH4nvNdRAEiHB6cWwb88KRTVoU
```

- 打开网页会看到解锁页，粘贴令牌即可；也可以用 `https://你的域名/?token=…` 直接进入（会自动从地址栏清除）。
- 令牌以 **HttpOnly Cookie** 形式固化在浏览器里（有效期一年），JS 读不到、XSS 偷不走，图片请求也不需要再拼参数。
- 令牌在「设置 → 访问令牌」里可查看、复制、**重新生成**（旧令牌立即失效）。
- 令牌保存在 `data/token`（0600），忘了就 `cat data/token`。
- 想关掉：`-no-auth` 或 `HACHI_NO_AUTH=1`。

## 界面

Material Design 3 风格，浅色 / 护眼米黄 / 深色三套主题。

| 书架 | 书籍详情 | 探索 |
|---|---|---|
| ![书架](docs/screenshots/md3-shelf-light.png) | ![详情](docs/screenshots/md3-book-light.png) | ![探索](docs/screenshots/md3-explore-light.png) |

| 阅读器（翻页动画中） | 阅读器（深色） | 设置 |
|---|---|---|
| ![翻页](docs/screenshots/reader-flip-slide-mid.png) | ![深色阅读](docs/screenshots/reader-scroll-dark.png) | ![设置](docs/screenshots/md3-settings-light.png) |

| 统计 | 访问令牌 | 解锁页 |
|---|---|---|
| ![统计](docs/screenshots/md3-stats-light.png) | ![令牌](docs/screenshots/md3-settings-token-dark.png) | ![解锁](docs/screenshots/md3-gate-dark.png) |

## 功能

**字体**
- 字体库：可上传多个 TTF / OTF / WOFF / WOFF2（每个 ≤80MB），列表里单选、删除、同名替换
- 上传/切换立即生效，不需要刷新；删除当前字体自动回落到系统默认
- 运行时探测设备是否真的有宋体（iOS 上 `Songti SC` 未必对网页可用）：命中才用衬线，否则保持系统字体并提示
- 阅读设置里有独立的「正文字体」子面板：系统默认 / 宋体 / 黑体 / 已上传字体一处切换

**阅读器**
- 滚动 / 翻页双模式；翻页用 CSS 多列自动分页，纯位移过渡，**不加实体书页阴影**（刻意为之：阴影在移动端拖慢合成且干扰阅读）
- 无痕滚动：滚到章末无缝追加下一章，不跳位
- 点击分区翻页、左右滑动翻页、章末自动跳转
- 返回误触拦截（不拦截 / 双击 / 完全阻止）
- 字号、行距、字距、段首缩进、衬线/无衬线
- 自动边距与手动四边距
- 主题：14 套配色，跟随系统或独立指定深浅；纸张颗粒可开关、可调强度、颜色随配色
- 指示器：时间、章节名、阅读进度，可独立开关
- 繁简转换、自定义正则替换规则
- 章节选择面板（按卷分组、已读标记、当前章高亮）
- 阅读进度与时长自动上报

**书库**
- 多书架、排序（默认/最近更新/名称/字数）、固定、反向
- 最近阅读、未读过滤、更新红点
- 书籍详情：分卷目录、已读标记、整本缓存

**发现**
- 排行榜（热门 / 动画化 / 今日更新 / 新书）
- 标签分类（49 个标签）、完结筛选
- 关键词搜索（书名 / 作者）、搜索历史
- 以上均需要 wenku8 登录

**其他**
- 阅读统计：总时长、日历热力图、按书排行
- 章节与图片服务端缓存，离线可读
- PWA：离线外壳、图片缓存、旧章节回退

## 为什么抓取层要伪装浏览器指纹

这不是多余的一层。实测（2026-11）：

- 桌面 Chrome UA 请求 wenku8 直接返回 `403 Just a moment...`（Cloudflare 挑战页）；
- 换成 iPhone Safari UA 后 `curl` 能通，但 **Go 原生 `net/http` 仍然 403**——即使 uTLS 伪装了 TLS 指纹也不行，因为 Cloudflare 还看 HTTP/2 帧指纹与请求头顺序；
- 最终用 [`bogdanfinn/tls-client`](https://github.com/bogdanfinn/tls-client) 完整伪装 Safari iOS 的 TLS + HTTP2 指纹才稳定通过。

细节见 [架构说明](docs/architecture.md)，PWA 侧方案见 [PWA 技术方案](docs/pwa.md)。

## 已知边界

- **探索 / 搜索依赖登录态**：站点对列表页做了登录限制，未登录返回"本站正式关闭"的提示页。默认使用 LightNovelReader 项目内置的公共 Cookie 兜底（可能随时失效），可用自己的账号或 Cookie 覆盖。
- **iOS 无法读取电量**；时间也不再在阅读器里显示（PWA 顶部系统状态栏本来就有），
  状态栏只保留章节名、页码与进度，宽度尽量留给较长的章节标题。
- **iOS 上的宋体（Songti SC）可能不被 WebKit 暴露**：已用运行时像素探测尽量选可用衬线字体，
  若设备上没有可用的宋体，阅读设置会提示；此时请上传自定义字体解决（已知限制，暂不继续追）。
- **屏幕常亮**依赖 Wake Lock API，iOS Safari 支持不稳定，不支持时静默降级。
- **阅读器未在真机 iOS 上验证**（开发环境为 macOS + Chromium），安全区与手势冲突建议装机后重点回归。
- 本书不存储任何书籍文件，所有内容实时来自 wenku8，仅做本地缓存加速。

## 目录结构

```
cmd/hachi/         入口
internal/api/      HTTP 接口、静态托管、图片代理
internal/wkk/      wenku8 抓取与解析（含离线测试夹具）
internal/store/    SQLite 持久化
internal/config/   环境变量与凭据
web/               前端（原生 ES 模块，无构建步骤）
  js/core/         路由、API、状态、DOM 工具
  js/views/        书架 / 探索 / 搜索 / 详情 / 统计 / 设置
  js/reader/       阅读器内核
docs/              API 契约、架构、部署
deploy/            systemd / launchd / Windows / Caddy / compose
```

## 测试

```bash
go test ./...                                  # 离线单测（解析夹具 + 存储）
HACHI_LIVE=1 go test ./internal/wkk/ -run Live  # 联网集成测试
```

## 许可

仅供个人学习与自用。书籍版权归原作者与出版社所有，请支持正版。
