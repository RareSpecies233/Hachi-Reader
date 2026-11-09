#Requires -Version 5.1
<#
.SYNOPSIS
  把 Hachi Reader 注册成 Windows 服务（NSSM 或 sc.exe），并放行防火墙。

.DESCRIPTION
  - 首次运行：创建数据目录、注册服务、设置环境变量、启动并做健康检查。
  - 重复运行：先停掉旧服务再重装（幂等），不会丢 /data 里的数据。
  - 用 NSSM 时自动接管日志轮转；用 sc.exe 时通过服务注册表的 Environment 传环境变量。
  - 卸载只删服务和防火墙规则，默认保留数据目录。

  注意：iOS 把网页「添加到主屏幕」并要求 Service Worker 时，必须是 HTTPS。
  本脚本注册的服务默认监听 :8080，局域网内用 http://192.168.x.x:8080 能打开网页，
  但不能注册 Service Worker。请配 Caddy 反代 + 证书，或参见 docs/deploy.md 的三种方案。

.PARAMETER BinaryPath
  hachi.exe 的绝对路径。默认 C:\Program Files\Hachi\hachi.exe

.PARAMETER DataDir
  数据目录（SQLite / 缓存 / 图片）。默认 C:\ProgramData\Hachi

.PARAMETER ListenAddr
  监听地址。默认 ":8080"（所有网卡）。只想给本机反代用就传 "127.0.0.1:8080"。

.PARAMETER Token
  可选，设置 HACHI_TOKEN，启用单用户鉴权。

.PARAMETER Method
  Auto（默认）/ NSSM / SC。

.PARAMETER Uninstall
  卸载服务与防火墙规则（保留 DataDir）。

.PARAMETER SkipFirewall
  不创建防火墙规则。

.EXAMPLE
  .\install-windows.ps1 -BinaryPath 'C:\Hachi\hachi.exe'

.EXAMPLE
  .\install-windows.ps1 -BinaryPath 'C:\Hachi\hachi.exe' -ListenAddr '127.0.0.1:8080' -Token 'long-random-token'

.EXAMPLE
  .\install-windows.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$BinaryPath = (Join-Path $env:ProgramFiles 'Hachi\hachi.exe'),
  [string]$DataDir = (Join-Path $env:ProgramData 'Hachi'),
  [string]$ListenAddr = ':8080',
  [string]$Token = '',
  [ValidateSet('Auto', 'NSSM', 'SC')]
  [string]$Method = 'Auto',
  [string]$ServiceName = 'HachiReader',
  [switch]$Uninstall,
  [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
$DisplayName = 'Hachi Reader'
$FirewallRule = "Hachi Reader (TCP)"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '需要管理员权限：请右键「以管理员身份运行」PowerShell 后再执行。'
  }
}

function Get-HachiService {
  return Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

function Remove-HachiService {
  $svc = Get-HachiService
  if ($svc) {
    if ($svc.Status -ne 'Stopped') {
      Write-Host "停止服务 $ServiceName ..."
      Stop-Service -Name $ServiceName -Force
      try {
        (Get-HachiService).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
      } catch {
        Write-Warning "等待服务停止超时，继续尝试删除：$($_.Exception.Message)"
      }
    }

    $nssm = Get-Command nssm -ErrorAction SilentlyContinue
    if ($nssm) {
      & $nssm.Source remove $ServiceName confirm | Out-Null
    }
    if (Get-HachiService) {
      sc.exe delete $ServiceName | Out-Null
      Start-Sleep -Milliseconds 500
    }
    if (Get-HachiService) {
      throw "服务 $ServiceName 删除失败，请手动执行：sc.exe delete $ServiceName"
    }
    Write-Host "已删除服务 $ServiceName"
  }

  Remove-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" `
    -Name Environment -ErrorAction SilentlyContinue
}

function Remove-HachiFirewall {
  Get-NetFirewallRule -DisplayName "$FirewallRule*" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

function Add-HachiFirewall {
  param([int]$Port)
  Remove-HachiFirewall
  New-NetFirewallRule -DisplayName "$FirewallRule $Port" `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -Profile Private, Domain | Out-Null
  Write-Host "已放行防火墙：TCP $Port（专用 / 域网络）"
}

function Install-WithNssm {
  $nssm = Get-Command nssm -ErrorAction SilentlyContinue
  if (-not $nssm) {
    throw '没有找到 nssm.exe。任选一种安装后重试：winget install NSSM.NSSM；或从 https://nssm.cc/download 解压并把目录加入 PATH。'
  }

  Write-Host "使用 NSSM 注册服务：$($nssm.Source)"
  & $nssm.Source install $ServiceName $BinaryPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm install 失败（退出码 $LASTEXITCODE）" }

  & $nssm.Source set $ServiceName AppDirectory $DataDir | Out-Null
  & $nssm.Source set $ServiceName AppEnvironmentExtra $envPairs | Out-Null
  & $nssm.Source set $ServiceName Start SERVICE_AUTO_START | Out-Null
  & $nssm.Source set $ServiceName AppStdout (Join-Path $DataDir 'hachi.log') | Out-Null
  & $nssm.Source set $ServiceName AppStderr (Join-Path $DataDir 'hachi.log') | Out-Null
  & $nssm.Source set $ServiceName AppRotateFiles 1 | Out-Null
  & $nssm.Source set $ServiceName AppRotateOnline 1 | Out-Null
  & $nssm.Source set $ServiceName AppRotateBytes 10485760 | Out-Null
  & $nssm.Source set $ServiceName AppExit Default Restart | Out-Null
  & $nssm.Source set $ServiceName AppRestartDelay 3000 | Out-Null
  & $nssm.Source set $ServiceName AppStopMethodConsole 5000 | Out-Null
  & $nssm.Source set $ServiceName AppNoConsole 1 | Out-Null
}

function Install-WithSc {
  Write-Host '使用 sc.exe 注册服务'
  # 用 cmd /c 拼命令行，避免 PowerShell 把含空格的路径二次加引号
  & cmd.exe /c "sc.exe create $ServiceName binPath= `"$BinaryPath`" start= auto DisplayName= `"$DisplayName`""
  if ($LASTEXITCODE -ne 0) { throw "sc.exe create 失败（退出码 $LASTEXITCODE）" }

  sc.exe description $ServiceName 'Hachi Reader - self-hosted wenku8 PWA reader' | Out-Null
  # 崩溃自动重启：5s / 15s / 60s，一天后重置失败计数
  sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null

  # sc.exe 不支持直接传环境变量：写到服务注册表的 Environment（REG_MULTI_SZ）
  $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
  New-ItemProperty -Path $regPath -Name Environment -PropertyType MultiString `
    -Value $envPairs -Force | Out-Null
}

function Wait-HachiHealthy {
  param([string]$Url)
  for ($i = 0; $i -lt 20; $i++) {
    try {
      $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($resp.StatusCode -eq 200) {
        Write-Host "健康检查通过：$Url"
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  Write-Warning "健康检查未通过：$Url"
  Write-Warning "排查：Get-Content '$DataDir\hachi.log' -Tail 50；或看「事件查看器 → Windows 日志 → 应用程序」。"
  return $false
}

# ---------------- 主流程 ----------------

Assert-Administrator

if ($Uninstall) {
  Remove-HachiService
  Remove-HachiFirewall
  Write-Host "卸载完成，数据仍保留在：$DataDir"
  return
}

if (-not (Test-Path -LiteralPath $BinaryPath)) {
  throw "找不到 hachi.exe：$BinaryPath`n先交叉编译并复制过去，例如：`n  CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags `"-s -w`" -o hachi.exe ./cmd/hachi"
}

if (-not (Test-Path -LiteralPath $DataDir)) {
  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  Write-Host "已创建数据目录：$DataDir"
}

$envPairs = @(
  "HACHI_ADDR=$ListenAddr",
  "HACHI_DATA=$DataDir",
  "TZ=Asia/Shanghai"
)
if ($Token) { $envPairs += "HACHI_TOKEN=$Token" }

# 首次安装或重装：先清理旧服务，保证幂等
if (Get-HachiService) {
  Write-Host "检测到已有服务 $ServiceName，先移除再重装（数据目录不动）"
  Remove-HachiService
}

if ($Method -eq 'Auto') {
  if (Get-Command nssm -ErrorAction SilentlyContinue) { $Method = 'NSSM' } else { $Method = 'SC' }
  Write-Host "自动选择服务注册方式：$Method"
}

if ($Method -eq 'NSSM') {
  Install-WithNssm
} else {
  Install-WithSc
}

if (-not (Get-HachiService)) {
  throw "服务 $ServiceName 注册后仍不存在，请检查上面的报错。"
}

# 探测端口：从监听地址里取，例如 ":8080" / "127.0.0.1:9000"
$probePort = 8080
if ($ListenAddr -match ':(\d+)\s*$') { $probePort = [int]$Matches[1] }

$isLoopbackOnly = $ListenAddr -match '^(127\.0\.0\.1|localhost|\[::1\])'
if (-not $SkipFirewall) {
  if ($isLoopbackOnly) {
    Write-Host '监听地址只绑定了本机回环，跳过防火墙放行（由反向代理对外提供 HTTPS）'
  } else {
    Add-HachiFirewall -Port $probePort
  }
}

Write-Host "启动服务 $ServiceName ..."
try {
  Start-Service -Name $ServiceName
  (Get-HachiService).WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
} catch {
  Write-Warning "服务启动失败：$($_.Exception.Message)"
}

$healthy = Wait-HachiHealthy -Url "http://127.0.0.1:$probePort/api/health"

$lanIp = ''
try {
  $lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1).IPAddress
} catch {
  $lanIp = ''
}

Write-Host ''
Write-Host '================ Hachi Reader 已注册为 Windows 服务 ================'
Write-Host "  服务名   : $ServiceName（$Method）"
Write-Host "  程序     : $BinaryPath"
Write-Host "  数据目录 : $DataDir"
Write-Host "  日志     : $(Join-Path $DataDir 'hachi.log')"
Write-Host "  本机访问 : http://127.0.0.1:$probePort"
if ($lanIp -and -not $isLoopbackOnly) {
  Write-Host "  局域网   : http://${lanIp}:$probePort"
}
Write-Host ''
Write-Host '  管理命令：'
Write-Host "    Start-Service $ServiceName"
Write-Host "    Stop-Service $ServiceName"
Write-Host "    Restart-Service $ServiceName"
Write-Host "    .\install-windows.ps1 -Uninstall"
Write-Host ''
Write-Host "  iPhone 安装 PWA 必须走 HTTPS：请用 Caddy 反代到 127.0.0.1:$probePort"
Write-Host '  或参考 docs/deploy.md 的「局域网访问」三种方案。'
if (-not $healthy) {
  Write-Host ''
  Write-Warning '服务已注册，但健康检查没通过，先看日志再继续。'
  exit 2
}
