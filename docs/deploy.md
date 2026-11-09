# Hachi Reader 部署手册

面向单用户私有部署：服务端 Go 负责抓取 / 缓存 / API，前端是**无构建步骤**的原生 ES 模块，
由 Go 用 `embed` 打进二进制。你要准备的只有：Go 1.27+（仅构建时）、一台常开的机器、
一个能终止 TLS 的反向代理（iOS 装 PWA 的硬性要求）。

> 一句话记住三件事：
> 1. **改了 `web/` 里的任何文件，都必须重新 `go build`**，否则二进制里还是旧前端。
> 2. **iOS 只有在 HTTPS（或 localhost）下才会注册 Service Worker**，`http://192.168.x.x` 不行。
> 3. 服务默认监听 `:8080`，可用 `HACHI_ADDR` 覆盖；数据目录是 `HACHI_DATA`，生产环境务必挂载/备份。

---

## 目录

1. [构建](#1-构建)
2. [Docker 部署](#2-docker-部署)
3. [Linux + systemd](#3-linux--systemd)
4. [Windows 服务](#4-windows-服务)
5. [macOS + launchd](#5-macos--launchd)
6. [HTTPS 与反向代理（Caddy）](#6-https-与反向代理caddy)
7. [局域网访问：为什么 http://192.168.x.x 不行](#7-局域网访问为什么-http192168xx-不行)
8. [验证清单](#8-验证清单)
9. [故障排查](#9-故障排查)
10. [升级、回滚与备份](#10-升级回滚与备份)
11. [附录：环境变量与文件清单](#11-附录环境变量与文件清单)

---

## 1. 构建

### 1.1 本机构建

项目根目录执行（macOS 上 Homebrew 装的 Go 需要补 PATH）：

```bash
export PATH=/opt/homebrew/bin:$PATH
go version            # 需要 go1.27 或更新
go build -trimpath -ldflags "-s -w" -o hachi ./cmd/hachi
./hachi               # 前台试跑，默认 :8080
curl -s http://127.0.0.1:8080/api/health
```

数据目录默认是服务端自己的配置（通常可用 `HACHI_DATA` 指定），本地试跑建议显式给一个：

```bash
HACHI_DATA=./data HACHI_ADDR=127.0.0.1:8080 ./hachi
```

### 1.2 交叉编译（CGO 必须为 0）

`CGO_ENABLED=0` 才能得到真正静态、可直接丢到任何 Linux 的二进制（项目用纯 Go 的 SQLite，
不需要 cgo）。一次生成全部产物：

```bash
export PATH=/opt/homebrew/bin:$PATH
mkdir -p dist

CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o dist/hachi-linux-amd64   ./cmd/hachi
CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o dist/hachi-linux-arm64   ./cmd/hachi
CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o dist/hachi-darwin-arm64  ./cmd/hachi
CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o dist/hachi-darwin-amd64  ./cmd/hachi
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o dist/hachi.exe            ./cmd/hachi

file dist/hachi-linux-amd64     # 应显示 statically linked
```

macOS 想要一个通用二进制：

```bash
lipo -create -output dist/hachi-macos-universal dist/hachi-darwin-arm64 dist/hachi-darwin-amd64
```

> 重新构建的触发条件很粗暴：**只要 `web/` 变了就重新 build**。`sw.js`、图标、CSS 全在 embed 里。

### 1.3 版本号（可选）

如果服务端定义了 `main.version`，构建时可以注入：

```bash
go build -trimpath -ldflags "-s -w -X main.version=0.1.0" -o hachi ./cmd/hachi
```

未定义该符号时 Go 会忽略这个 `-X`，不会报错；Dockerfile 里也是同样的写法。

---

## 2. Docker 部署

### 2.1 直接 `docker run`

```bash
# 构建（前端已 embed，无需 npm）
docker build -t hachi-reader:local .

# 运行：只绑本机 8080，前面交给 Caddy 做 HTTPS
docker run -d --name hachi --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v hachi-data:/data \
  -e HACHI_ADDR=:8080 \
  -e HACHI_DATA=/data \
  -e TZ=Asia/Shanghai \
  hachi-reader:local

curl -s http://127.0.0.1:8080/api/health
docker logs -f hachi
```

镜像细节：

- 构建阶段 `golang:1.27-alpine`，`CGO_ENABLED=0`、`-trimpath`、`-ldflags "-s -w"`；
- 运行阶段 `alpine:3.22`，非 root（uid/gid **10001**），`EXPOSE 8080`，`VOLUME /data`；
- `HEALTHCHECK` 每 30 秒打一次 `/api/health`（用的是 busybox 的 `wget`）。

### 2.2 docker compose

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f
docker compose -f deploy/docker-compose.yml down
```

compose 里默认开启了只读根文件系统 + 独立 `/tmp` + `cap_drop: ALL`；
`hachi-data` 命名卷负责持久化。

### 2.3 几个容易踩的点

**监听地址**：容器内必须监听所有网卡，所以 `HACHI_ADDR=:8080`；宿主机端口映射再决定对外暴露范围：

```bash
-p 127.0.0.1:8080:8080   # 只有宿主机能访问（配反代用这个）
-p 8080:8080             # 局域网可访问（但仍然没有 HTTPS，iOS 不能装 PWA）
```

**绑定挂载的权限**：容器以 uid 10001 运行。用目录挂载时要先改属主，否则数据写不进去：

```bash
sudo install -d -o 10001 -g 10001 /srv/hachi-data
docker run -d --name hachi -p 127.0.0.1:8080:8080 \
  -v /srv/hachi-data:/data -e HACHI_ADDR=:8080 -e HACHI_DATA=/data \
  hachi-reader:local
```

**只读根文件系统**：

```bash
docker run -d --name hachi --read-only --tmpfs /tmp:size=64m \
  -p 127.0.0.1:8080:8080 -v hachi-data:/data hachi-reader:local
```

**换了端口记得改 healthcheck**：

```bash
docker run ... -e HACHI_ADDR=:9000 -p 127.0.0.1:9000:9000 \
  --health-cmd 'wget -q -O /dev/null http://127.0.0.1:9000/api/health' \
  hachi-reader:local
```

**ARM 机器**（树莓派 / Apple Silicon）：

```bash
docker buildx build --platform linux/arm64 -t hachi-reader:local --load .
```

---

## 3. Linux + systemd

以 Debian / Ubuntu 为例，从零到跑起来：

### 3.1 拷二进制、建用户与目录

```bash
# 在开发机上
scp dist/hachi-linux-amd64 you@server:/tmp/hachi

# 在服务器上
sudo install -m 0755 /tmp/hachi /usr/local/bin/hachi
sudo useradd --system --home-dir /var/lib/hachi --shell /usr/sbin/nologin hachi
sudo install -d -o hachi -g hachi -m 0750 /var/lib/hachi
sudo install -d -m 0750 /etc/hachi
sudo install -m 0640 -o root -g hachi deploy/hachi.env.example /etc/hachi/hachi.env
sudoedit /etc/hachi/hachi.env        # 可选：改 HACHI_TOKEN / HACHI_ADDR
```

> 注意：`/etc/hachi/hachi.env` 里的 `HACHI_DATA` 必须与 unit 里的 `ReadWritePaths` 一致（默认
> `/var/lib/hachi`）。想换数据目录，要同时改 unit 的 `StateDirectory` / `ReadWritePaths`。

### 3.2 安装服务

```bash
sudo install -m 0644 deploy/hachi.service /etc/systemd/system/hachi.service
sudo systemctl daemon-reload
sudo systemctl enable --now hachi
systemctl status hachi --no-pager
journalctl -u hachi -f
curl -s http://127.0.0.1:8080/api/health
```

unit 里默认 `HACHI_ADDR=127.0.0.1:8080`，由 Caddy 反代。想直接给局域网访问：

```bash
# 方式一：改 env 文件（优先级高于 unit 里的 Environment）
sudoedit /etc/hachi/hachi.env     # HACHI_ADDR=:8080
sudo systemctl restart hachi
sudo ufw allow 8080/tcp           # 或者只放行给需要的网段
```

### 3.3 只读根目录与加固

`ProtectSystem=strict` + `StateDirectory=hachi` + `ReadWritePaths=/var/lib/hachi` 的含义是：
整个文件系统只读，只有 `/var/lib/hachi`（以及 `/tmp`）可写。

如果服务起不来，先看状态码：

```bash
systemctl status hachi --no-pager
# 203/EXEC           → 二进制路径不对 / 没有执行权限
# 226/NAMESPACE      → 某个沙箱选项与当前内核不兼容
# 217/USER           → hachi 用户不存在
```

临时排障可以把 `SystemCallFilter=@system-service`、`MemoryDenyWriteExecute=true`
这两行注释掉再试；确认是加固导致的后，再逐项加回。

### 3.4 卸载

```bash
sudo systemctl disable --now hachi
sudo rm -f /etc/systemd/system/hachi.service /etc/hachi/hachi.env
sudo systemctl daemon-reload
# /var/lib/hachi 里的数据默认保留
```

---

## 4. Windows 服务

### 4.1 编译与放置

```bash
# 开发机（macOS/Linux）
mkdir -p dist
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o dist/hachi.exe ./cmd/hachi
```

在 Windows 上：

```powershell
New-Item -ItemType Directory -Path 'C:\Program Files\Hachi' -Force
Copy-Item .\dist\hachi.exe 'C:\Program Files\Hachi\hachi.exe'
```

数据放 `C:\ProgramData\Hachi`（脚本会自动建）。

### 4.2 安装服务（脚本，自动选 NSSM / sc.exe）

以**管理员身份**打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
cd C:\path\to\hachi-repo

.\deploy\install-windows.ps1 `
  -BinaryPath 'C:\Program Files\Hachi\hachi.exe' `
  -DataDir    'C:\ProgramData\Hachi'
```

- 有 `nssm` 就用 NSSM（自动日志轮转、崩溃重启）；
- 没有就退回 `sc.exe`（环境变量写进服务注册表的 `Environment` 值，同样支持自动重启）。

想指定 token、只监听本机给反代用：

```powershell
.\deploy\install-windows.ps1 `
  -BinaryPath 'C:\Program Files\Hachi\hachi.exe' `
  -ListenAddr '127.0.0.1:8080' `
  -Token '换成足够长的随机串' `
  -SkipFirewall
```

安装 NSSM：

```powershell
winget install NSSM.NSSM
# 或者：choco install nssm
```

### 4.3 纯手工 sc.exe 等价操作

不想用脚本时，在**管理员 cmd.exe** 里：

```bat
sc.exe create HachiReader binPath= "C:\Program Files\Hachi\hachi.exe" start= auto DisplayName= "Hachi Reader"
sc.exe description HachiReader "Hachi Reader - self-hosted wenku8 PWA reader"
sc.exe failure HachiReader reset= 86400 actions= restart/5000/restart/15000/restart/60000
```

再回到管理员 PowerShell 写环境变量并启动：

```powershell
New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\HachiReader' `
  -Name Environment -PropertyType MultiString `
  -Value @('HACHI_ADDR=:8080','HACHI_DATA=C:\ProgramData\Hachi','TZ=Asia/Shanghai') -Force

sc.exe start HachiReader
Start-Service HachiReader
Invoke-WebRequest 'http://127.0.0.1:8080/api/health' -UseBasicParsing
```

### 4.4 防火墙放行

脚本在检测到监听地址不是回环时会自动加规则（仅「专用 / 域」网络）。手工加：

```powershell
New-NetFirewallRule -DisplayName 'Hachi Reader (TCP 8080)' `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 `
  -Profile Private
```

测试端口：

```powershell
Test-NetConnection -ComputerName 192.168.1.10 -Port 8080
```

### 4.5 常用命令与卸载

```powershell
Get-Service HachiReader
Restart-Service HachiReader
Stop-Service HachiReader
Get-Content 'C:\ProgramData\Hachi\hachi.log' -Tail 50 -Wait

.\deploy\install-windows.ps1 -Uninstall      # 删服务 + 防火墙规则，保留数据目录
```

> Windows 上也可以把 Caddy 注册成第二个服务来提供 HTTPS：`caddy run --config C:\Caddy\Caddyfile`
> 手工验证通过后，用 nssm 以同样方式注册。HTTPS 是 iOS 安装 PWA 的前提。

---

## 5. macOS + launchd

### 5.1 编译

```bash
export PATH=/opt/homebrew/bin:$PATH
mkdir -p dist
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o dist/hachi ./cmd/hachi
# Intel Mac 用 GOARCH=amd64；要通用二进制见 1.2 的 lipo 命令
```

### 5.2 建隐藏用户 `_hachi`

launchd 的 daemon 如果指定了 `UserName`，该用户必须已存在。先确认 401 没被占用：

```bash
dscl . -list /Users UniqueID | awk '$2==401 {print}'
```

然后创建：

```bash
sudo dscl . -create /Groups/_hachi
sudo dscl . -create /Groups/_hachi PrimaryGroupID 401
sudo dscl . -create /Groups/_hachi RealName "Hachi Reader"

sudo dscl . -create /Users/_hachi
sudo dscl . -create /Users/_hachi UserShell /usr/bin/false
sudo dscl . -create /Users/_hachi RealName "Hachi Reader"
sudo dscl . -create /Users/_hachi UniqueID 401
sudo dscl . -create /Users/_hachi PrimaryGroupID 401
sudo dscl . -create /Users/_hachi NFSHomeDirectory /usr/local/var/hachi
```

> 不想建系统用户：把 `deploy/org.hachi.reader.plist` 里的 `UserName` / `GroupName` 两段删掉，
> 服务会以 root 运行——能用，但不推荐。

### 5.3 安装二进制、目录与 plist

```bash
sudo install -d -m 0755 /usr/local/bin
sudo install -m 0755 dist/hachi /usr/local/bin/hachi

sudo install -d -o _hachi -g _hachi -m 0750 /usr/local/var/hachi
sudo install -d -o _hachi -g _hachi -m 0755 /usr/local/var/log
sudo touch /usr/local/var/log/hachi.log
sudo chown _hachi:_hachi /usr/local/var/log/hachi.log

sudo install -m 0644 -o root -g wheel deploy/org.hachi.reader.plist \
  /Library/LaunchDaemons/org.hachi.reader.plist
```

### 5.4 加载与自启

```bash
# 先卸掉可能存在的旧实例，再加载（bootstrap 是 macOS 10.15+ 的写法）
sudo launchctl bootout system/org.hachi.reader 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/org.hachi.reader.plist
sudo launchctl enable system/org.hachi.reader
sudo launchctl kickstart -k system/org.hachi.reader

# 状态与日志
sudo launchctl print system/org.hachi.reader | head -40
tail -f /usr/local/var/log/hachi.log
curl -s http://127.0.0.1:8080/api/health
```

改了 plist 之后要重新加载：

```bash
sudo launchctl bootout system/org.hachi.reader
sudo launchctl bootstrap system /Library/LaunchDaemons/org.hachi.reader.plist
```

> 只给当前登录用户用（不用 sudo）也可以：把 plist 放到 `~/Library/LaunchAgents/`，
> 删掉 `UserName` / `GroupName`，然后
> `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.hachi.reader.plist`。

### 5.5 卸载

```bash
sudo launchctl bootout system/org.hachi.reader
sudo rm -f /Library/LaunchDaemons/org.hachi.reader.plist
# /usr/local/var/hachi 数据按需保留
```

macOS 防火墙：如果只监听 `127.0.0.1`，系统不会弹权限框；改成 `:8080` 后
系统设置 → 网络 → 防火墙 里会提示是否允许 `hachi` 接受连接，记得放行。

---

## 6. HTTPS 与反向代理（Caddy）

### 6.1 为什么必须 HTTPS

iOS Safari 只在**安全上下文**（HTTPS，或 `localhost`）里允许 `navigator.serviceWorker.register()`。
在 `http://192.168.1.10:8080` 下打开，页面能显示，但：

- Service Worker 注册直接失败 → 没有离线缓存、没有更新提示；
- iOS 没有 `beforeinstallprompt`，「添加到主屏幕」只能靠分享菜单，行为也退化；
- iOS 16.4+ 的 Web Push 更要求「已安装 + HTTPS」。

### 6.2 安装 Caddy

macOS：

```bash
brew install caddy
```

Debian / Ubuntu（官方源）：

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

### 6.3 配置反代到 127.0.0.1:8080

```bash
# 1) 复制示例
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile

# 2) 把占位域名和邮箱换成自己的
sudo nano /etc/caddy/Caddyfile

# 3) 先校验再重载
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

关键点（示例文件里都写了）：

- `reverse_proxy 127.0.0.1:8080`：hachi 只绑回环，公网只暴露 Caddy；
- `/sw.js` 强制 `Cache-Control: no-cache, no-store, must-revalidate`，否则 iOS 上更新永远不生效；
- `/manifest.webmanifest` 给 `application/manifest+json`；
- `/css/* /js/* /icons/*` 短缓存即可（文件名没有内容哈希，别设 immutable）；
- `/api/img*` 可以长缓存（服务端本身就是 immutable）。

DNS 与端口：把域名 A/AAAA 记录指向服务器公网 IP，路由器放行 80 与 443
（HTTP-01 需要 80；用 DNS-01 则不需要 80）。

验证：

```bash
curl -sI https://hachi.example.com/ | head
curl -sI https://hachi.example.com/sw.js | grep -i -E 'http/|content-type|cache-control'
curl -s  https://hachi.example.com/api/health
```

> 套了 Cloudflare 之类 CDN 时，务必给 `/sw.js` 配 bypass / 不缓存规则，
> 否则你改了 `SW_VERSION` 也推不到客户端。

---

## 7. 局域网访问：为什么 http://192.168.x.x 不行

`192.168.x.x` 属于私有地址，浏览器不会把它当安全上下文（`window.isSecureContext === false`），
于是 `serviceWorker.register()` 抛 `SecurityError`。iOS 上这意味着**不能离线、不能可靠更新**，
「添加到主屏幕」出来的只是个普通网页快捷方式。

本项目的 `web/js/pwa.js` 会检测并静默降级：`register()` 返回 `{ ok: false, reason: 'insecure-context' }`，
设置页展示的安装指引会带上「当前不是 HTTPS」的提示。但真正要获得 PWA 能力，必须给局域网
一个**受信任的 HTTPS 地址**。下面三条路径都能做到，按推荐顺序排列。

### 7.1 方案 ③：Tailscale（首选，最省事）

原理：Tailscale 给设备一个 `100.x` 地址和 `*.ts.net` 的 MagicDNS 域名，并自动签发**公网可信**
的 TLS 证书。手机无论在家还是在外网都能用同一个 HTTPS 地址，路由器完全不用动。

服务器端（Linux）：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status

# 方式 A：让 Tailscale 直接把 8080 代理成 HTTPS（推荐，零配置证书）
tailscale serve --bg 8080
tailscale serve status
# 打开输出里的 https://<机器名>.<tailnet>.ts.net/ 验证

# 方式 B：自己导出证书给 Caddy 用
sudo tailscale cert <机器名>.<tailnet>.ts.net
# 然后在 Caddyfile 里：
#   hachi.<tailnet>.ts.net {
#     tls /path/<机器名>.<tailnet>.ts.net.crt /path/<机器名>.<tailnet>.ts.net.key
#     reverse_proxy 127.0.0.1:8080
#   }
```

macOS 服务器端：`brew install tailscale` 或 App Store 版，`sudo tailscaled` 后 `tailscale up`。

iPhone：

1. App Store 安装 Tailscale，登录同一账号，打开 VPN 开关；
2. Safari 打开 `https://<机器名>.<tailnet>.ts.net/`；
3. 分享 → 添加到主屏幕。

注意：

- 需要进 tailnet 管理后台确认已启用 HTTPS 证书（`tailscale cert` 依赖它）；
- `tailscale serve` 默认只对 tailnet 内可见，不会暴露到公网，正合适；
- iOS 上 Tailscale 的 VPN 图标必须在，否则域名解析不到。

### 7.2 方案 ②：Caddy 内部 CA + iOS 安装根证书

原理：Caddy 用自建 CA 给内网域名（如 `hachi.lan`）签证书，把根证书装进 iOS 并「完全信任」。
完全本地、不依赖任何第三方，但每台设备都要装一次证书。

Caddyfile：

```caddyfile
hachi.lan {
	tls internal
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080

	@sw path /sw.js
	header @sw Cache-Control "no-cache, no-store, must-revalidate"
}
```

步骤：

```bash
# 1) 局域网 DNS：把 hachi.lan 指向服务器内网 IP
#    在路由器的 DHCP/DNS 设置里加静态解析，或跑 dnsmasq / Pi-hole：
#    address=/hachi.lan/192.168.1.10

# 2) 加载 Caddy 配置
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

# 3) 导出根证书，临时用 HTTP 提供给 iPhone 下载
sudo cp /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt /tmp/hachi-root.crt
cd /tmp && python3 -m http.server 8099
# iPhone Safari 打开 http://192.168.1.10:8099/hachi-root.crt，允许下载描述文件
```

iOS 装证书（这一步不做完，Safari 永远报「此连接非私人连接」）：

1. 设置 → 通用 → **VPN 与设备管理** → 已下载的描述文件 → 安装；
2. 设置 → 通用 → **关于本机** → **证书信任设置** → 打开 `Hachi` 根证书的**完全信任**；
3. Safari 打开 `https://hachi.lan/`，确认地址栏是锁；
4. 分享 → 添加到主屏幕。

注意：

- iPhone 不能改 hosts，所以必须有局域网 DNS（路由器或 Pi-hole）把域名指到内网 IP；
- 换设备要重装一次根证书；根证书有效期很长，但如果哪天突然报错，重新导出安装即可；
- 这个域名只在局域网有效，出门用不了（要出门用 → 选 ③ 或 ①）。

### 7.3 方案 ①：公网域名 + DNS-01 证书（已有域名时最优雅）

原理：用自己域名（如 `hachi.example.com`），A 记录可以直接写**内网私有 IP**
（公网 DNS 允许这么填；Let's Encrypt 用 DNS-01 校验时只看 TXT 记录，不看 A 记录），
这样内网访问时流量不出门，证书又是公网可信的。

```caddyfile
hachi.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:8080
}
```

- Caddy 默认不带 DNS 插件，需要自己加（或直接用它内置的 HTTP-01 + 端口转发）：

```bash
xcaddy build --with github.com/caddy-dns/cloudflare
sudo mv caddy /usr/bin/caddy
```

- 用 HTTP-01 也可以，但要求 80 端口能被公网访问；A 记录写内网 IP 时公网访问不到，
  内网访问时又需要 **NAT 回环（hairpin NAT）**，很多家用路由器不支持，见下。

**hairpin NAT / 分域 DNS 的坑**：

- A 记录写**公网 IP** 时，内网设备访问域名会「出去再回来」，需要路由器支持 NAT loopback；
  不支持时表现为：外面能开、家里打不开或超时。
- 解决办法是**分域 DNS**：路由器（dnsmasq / Pi-hole / AdGuard Home）里加一条
  `hachi.example.com → 192.168.1.10`，内网设备拿内网地址，外网仍走公网。
- 改完 DNS 后 iOS 可能缓存旧地址：切飞行模式再切回，或「设置 → Safari → 清除历史与网站数据」。
- 公网暴露必须配合 `HACHI_TOKEN`，并只放行 80/443；不要把 `:8080` 直接暴露到公网。

### 7.4 三条路径对比

| | 前置条件 | 覆盖范围 | 证书是否公网可信 | iOS 额外步骤 | 维护成本 | 推荐度 |
|---|---|---|---|---|---|---|
| **③ Tailscale** | 装 App、注册账号 | 内网 + 外网 | 是（`*.ts.net`） | 开 VPN | 低 | ★★★★★ |
| **② Caddy 内部 CA** | 局域网 DNS + Caddy | 仅内网 | 否（需装根证书） | 装描述文件 + 完全信任 | 中 | ★★★☆ |
| **① 域名 + DNS-01** | 域名、DNS API、端口/分域 DNS | 内网 + 外网 | 是（Let's Encrypt） | 无（分域 DNS 正常时） | 中高 | ★★★（已有域名时 ★★★★） |

**推荐顺序：③ → ② → ①。** 只是在家用、想最快跑通选 ③；完全不想依赖第三方、只要内网选 ②；
已经有域名、希望家里和外面用同一个地址，并且愿意折腾 DNS 记录/分域解析，选 ①。

> 只想先验证 iPhone 上的安装流程：`cloudflared tunnel --url http://127.0.0.1:8080`
> 会给一个临时 HTTPS 域名（证书有效、SW 可用），适合做一次性冒烟测试，不适合长期使用。

---

## 8. 验证清单

### 8.1 命令行

```bash
# 健康检查
curl -s http://127.0.0.1:8080/api/health | python3 -m json.tool

# manifest：200 + application/manifest+json + 合法 JSON
# 注意 MIME：Chrome 的安装性检查只认 JSON 类型；如果直接访问 Go 服务看到
# text/plain，就会报 manifest MIME 不受支持。Caddyfile 里已经帮你覆盖成
# application/manifest+json，直连 8080 调试时请留意这一项。
curl -sI https://hachi.example.com/manifest.webmanifest
curl -s  https://hachi.example.com/manifest.webmanifest | python3 -m json.tool

# sw.js：200 + no-cache（这是更新能否生效的关键）
curl -sI https://hachi.example.com/sw.js

# 图标：PNG + 正确尺寸
curl -s https://hachi.example.com/icons/icon-192.png -o /tmp/i.png && file /tmp/i.png
```

### 8.2 桌面浏览器

Chrome / Edge 打开站点，DevTools：

- **Application → Manifest**：图标齐全、可安装（Installability 无报错）；
- **Application → Service Workers**：状态 `activated`，Scope 为 `/`；
- **Application → Cache Storage**：应能看到 `hachi-shell-v1`、`hachi-static-v1`（打开过页面后
  还会出现 `hachi-api-v1`，看过图后有 `hachi-img-v1`）；
- Network 面板切 **Offline** 后刷新：应能从缓存打开外壳（不是恐龙页）。

### 8.3 iPhone

1. Safari 打开 `https://你的域名/`；
2. 分享 → 添加到主屏幕 → 添加；
3. 从桌面图标启动（应无 Safari 地址栏；控制台 `navigator.standalone` 为 true）；
4. 打开几本书的目录和章节（让 API 进缓存）；
5. 开飞行模式，从图标启动 → 已访问内容应能打开；
6. 设置页能看到「添加到主屏幕 / 已安装」的正确状态（由 `installHint()` 返回）。

### 8.4 更新链路

```bash
# 1) 改 web/sw.js 里的 SW_VERSION（例如 v1 → v2）并重新部署
# 2) 设备上刷新两次，应出现 toast「新版本已就绪，刷新后生效」
# 3) 再刷新一次，Cache Storage 里应变成 hachi-shell-v2
```

如果没出现提示，见 [9.5](#95-service-worker-更新不生效)。

---

## 9. 故障排查

### 9.1 证书问题

**症状**：Safari 报「此连接非私人连接」；`curl` 报 `SSL certificate problem`。

```bash
# 看服务端实际发的证书
openssl s_client -connect hachi.example.com:443 -servername hachi.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates

# Caddy 日志
sudo journalctl -u caddy -n 100 --no-pager
```

- 自签方案：检查 iOS「证书信任设置」里是否打开了**完全信任**（很多人只安装了没信任）；
- 系统时间不对会导致证书校验失败；
- 换过域名/重装过 Caddy：旧证书链对不上，重新导出根证书安装；
- 用 Cloudflare 代理时确认 SSL/TLS 模式不是「灵活」（Fully/Full strict 才对）。

### 9.2 端口与监听

**症状**：`curl: (7) Failed to connect`；局域网打不开。

```bash
# 服务到底在不在、绑在哪个地址
lsof -nP -iTCP:8080 -sTCP:LISTEN      # macOS
ss -ltnp | grep 8080                  # Linux

systemctl status hachi --no-pager     # Linux
docker ps --format '{{.Names}}\t{{.Ports}}'
```

- 服务只绑了 `127.0.0.1` → 局域网当然连不上，改 `HACHI_ADDR=:8080`；
- Docker 写了 `-p 127.0.0.1:8080:8080` → 改成 `-p 8080:8080`；
- systemd `203/EXEC` → 二进制路径/权限不对；`217/USER` → 用户没建。

### 9.3 防火墙与网络隔离

```bash
sudo ufw status                          # Ubuntu
sudo firewall-cmd --list-all             # Fedora/RHEL
```

```powershell
Get-NetFirewallRule -DisplayName '*Hachi*'
Test-NetConnection -ComputerName 192.168.1.10 -Port 443
```

- 路由器开了 **AP 隔离 / 客户端隔离**：手机和服务器互相不可见，关掉；
- 反代在宿主机、服务在容器里时，Caddy 要指到宿主机映射出来的地址，不是容器内网；
- 云服务器还有安全组，要单独放行 80/443。

### 9.4 iOS 缓存顽固

按顺序试：

1. 设置 → Safari → **清除历史记录与网站数据**（会清掉所有站点数据，注意）；
2. 或 设置 → Safari → 高级 → 网站数据 → 搜索域名 → 删除；
3. 删除桌面图标 → Safari 重新打开 → 重新「添加到主屏幕」；
4. 从上滑手势**彻底杀掉** PWA 再启动（不是切后台）；
5. 关掉 iCloud 私有中继（Private Relay）再试，它对局域网域名/自签证书很不友好；
6. 服务端确认 `/sw.js` 响应头确实是 `no-cache`，CDN 没有把它缓存住。

### 9.5 Service Worker 更新不生效

排查顺序：

1. **sw.js 内容真的变了吗**：浏览器按字节比较，只改注释也算变化；但本项目的
   `SW_VERSION` 常量决定缓存名，改策略时务必一起改；
2. **新 worker 是不是卡在 waiting**：DevTools → Application → Service Workers，
   看是否有 `waiting to activate`；本项目故意不 `skipWaiting()`，需要刷新让旧页面退出；
3. **旧页面还开着**：所有旧标签页关闭后，新 worker 才会在下次导航时接管；
   iOS 上要从多任务里彻底关闭 PWA；
4. **响应头**：`curl -sI https://你的域名/sw.js` 必须有 `Cache-Control: no-cache`；
5. **手动清一次**：DevTools → Application → Service Workers → Unregister，
   再清空 Cache Storage，然后刷新；
6. `web/js/pwa.js` 的提示只在「页面已被旧 worker 控制」时出现；首次安装不会提示，这是正常的。

### 9.6 接口 403 / login_required

- 未登录 wenku8：先完成服务端登录配置；
- 配了 `HACHI_TOKEN` 但客户端没带：设置页填 token，或 URL 加 `?token=`；
- 反代把 `Authorization` 头丢了：检查 Caddy/Nginx 配置（本项目的 Caddyfile 不会丢）。

### 9.7 数据目录不可写

```bash
# systemd
sudo ls -ld /var/lib/hachi
sudo -u hachi test -w /var/lib/hachi && echo writable

# Docker（容器内是 uid 10001）
sudo chown -R 10001:10001 /srv/hachi-data
```

SQLite 报 `database is locked` 时，确认没有同时跑两个实例（systemd + 手动启动最容易撞）。

### 9.8 图片/缓存占用过大

SW 对 `/api/img` 有硬限制：单张 ≤ 2MB、最多 240 条；超出不缓存。仍想清空：

DevTools → Application → Cache Storage → 删除 `hachi-img-*`，或换 `SW_VERSION` 重新部署。

---

## 10. 升级、回滚与备份

### 10.1 升级

```bash
# 1) 重新构建（前端 embed 在二进制里）
export PATH=/opt/homebrew/bin:$PATH
go build -trimpath -ldflags "-s -w" -o hachi ./cmd/hachi

# 2) 覆盖并重启
sudo systemctl stop hachi
sudo install -m 0755 hachi /usr/local/bin/hachi
sudo systemctl start hachi
curl -s http://127.0.0.1:8080/api/health
```

Docker：

```bash
docker build -t hachi-reader:0.2.0 .
docker compose -f deploy/docker-compose.yml up -d
```

**什么时候要改 `SW_VERSION`**：缓存策略变化、或者你希望所有客户端强制换掉旧外壳时。
只改前端页面内容（CSS/JS/视图）通常不需要，但改了缓存行为一定要加。

### 10.2 回滚

保留上一版二进制即可：

```bash
sudo systemctl stop hachi
sudo install -m 0755 hachi.previous /usr/local/bin/hachi
sudo systemctl start hachi
```

Docker 用旧 tag 重新 `up -d` 即可。

### 10.3 备份与恢复

数据都在 `HACHI_DATA`（默认 `/var/lib/hachi` 或容器卷 `/data`）。最稳的方式是停服再打包：

```bash
sudo systemctl stop hachi
sudo tar -C /var/lib -czf hachi-data-$(date +%F).tar.gz hachi
sudo systemctl start hachi
```

Docker named volume：

```bash
docker run --rm -v hachi-data:/data -v "$PWD":/backup alpine \
  tar -C /data -czf /backup/hachi-data-$(date +%F).tar.gz .
```

恢复：停服 → 解包回原目录 → 确认属主（容器是 10001）→ 启动。

---

## 11. 附录：环境变量与文件清单

### 11.1 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HACHI_ADDR` | `:8080` | 监听地址；反代场景建议 `127.0.0.1:8080` |
| `HACHI_DATA` | 服务端默认 | 数据目录：SQLite、抓取缓存、图片；容器镜像内固定 `/data` |
| `HACHI_TOKEN` | 空 | 单用户鉴权；客户端用 `Authorization: Bearer` 或 `?token=` |
| `TZ` | 系统 | 影响统计里的日期归属，建议 `Asia/Shanghai` |
| `HACHI_WENKU8_USER` / `HACHI_WENKU8_PASS` | 空 | wenku8 账号，**以服务端实际实现为准**，见 `docs/api.md` |

### 11.2 前端 PWA 文件

| 文件 | 作用 |
|---|---|
| `web/manifest.webmanifest` | 名称、`start_url "/#/shelf"`、standalone、暖纸色主题、any/maskable 图标 |
| `web/sw.js` | Service Worker；版本常量 `SW_VERSION` 是更新开关 |
| `web/js/pwa.js` | 导出 `register()` / `installHint()` / `isStandalone()` / `promptInstall()` |
| `web/icons/icon-180.png` | iOS apple-touch-icon（由 `index.html` 引用） |
| `web/icons/icon-192.png`、`icon-512.png` | manifest `purpose=any` |
| `web/icons/icon-192-maskable.png`、`icon-512-maskable.png` | manifest `purpose=maskable`（四周留安全边距） |
| `web/icons/gen_icons.py` | 图标重生成脚本（Pillow） |

重新生成图标：

```bash
python3 -m pip install Pillow
python3 web/icons/gen_icons.py
file web/icons/*.png      # 确认都是 PNG image data
```

### 11.3 部署文件

| 文件 | 用途 |
|---|---|
| `Dockerfile` | 多阶段构建，运行镜像非 root、带 HEALTHCHECK |
| `.dockerignore` | 排除 .git / docs / deploy / 本地数据 |
| `deploy/hachi.service` | Linux systemd |
| `deploy/hachi.env.example` | systemd 的 EnvironmentFile 模板 |
| `deploy/install-windows.ps1` | Windows 服务安装（NSSM / sc.exe 自动选择） |
| `deploy/org.hachi.reader.plist` | macOS launchd（RunAtLoad + KeepAlive） |
| `deploy/Caddyfile` | HTTPS 反代示例（公网证书 / 内部 CA） |
| `deploy/docker-compose.yml` | compose 示例（只读根 + 独立 /tmp + 健康检查） |

### 11.4 Service Worker 缓存一览

| 缓存名 | 内容 | 策略 | 上限 |
|---|---|---|---|
| `hachi-shell-v1` | `/`、`index.html`、3 个 CSS、app.js、core/*.js、pwa.js、manifest、图标 | 安装时预缓存；导航时顺带刷新 | — |
| `hachi-static-v1` | 运行时加载的 `views/*.js`、`reader/*.js`、图标等 | stale-while-revalidate | 160 条 |
| `hachi-api-v1` | `/api/*`（除图片）的 GET 响应 | network-first（有缓存时 3s 超时回退） | 80 条 |
| `hachi-img-v1` | `/api/img` 图片字节 | cache-first | 240 条 / 单张 2MB |

> 预缓存列表是**显式文件名**（不写死 views/reader）。如果以后新增 `js/core/*.js`，
> 记得同步加进 `web/sw.js` 的 `PRECACHE`，否则首次离线启动会缺模块。
