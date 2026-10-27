# 天枢启动器：run.ps1            普通启动（服务 + 悬浮小窗）
#                    run.ps1 --holo     全息控制台（J.A.R.V.I.S）
$ErrorActionPreference = "SilentlyContinue"
$holo = ($args -contains "--holo") -or ($args -contains "-holo") -or ($args -contains "holo")
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $root

function Test-Hub {
  try { $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:7311/api/stats" -TimeoutSec 2; return ($r.StatusCode -eq 200) } catch { return $false }
}

if (-not (Test-Hub)) {
  Write-Host "[1/2] 启动本地中枢服务 ..." -ForegroundColor Cyan
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Host "没找到 node，请先装 Node.js" -ForegroundColor Red; exit 1 }
  $out = Join-Path $root "data\server.out.log"; $err = Join-Path $root "data\server.err.log"
  Start-Process -FilePath $node -ArgumentList "src/server.mjs" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 400; if (Test-Hub) { $ok = $true; break } }
  if (-not $ok) { Write-Host "服务没起来，看 data\server.err.log" -ForegroundColor Red; exit 1 }
} else { Write-Host "[1/2] 本地中枢已在运行" -ForegroundColor DarkGray }

$env:ELECTRON_RUN_AS_NODE = $null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$exe = Join-Path $root "desktop\node_modules\electron\dist\electron.exe"
$url = if ($holo) { "http://127.0.0.1:7311/holo" } else { "http://127.0.0.1:7311/" }

if (Test-Path $exe) {
  Write-Host ("[2/2] 打开桌面端" + $(if ($holo) { "（全息控制台）" } else { "" }) + " ...") -ForegroundColor Cyan
  $ud = Join-Path $root "data\userdata"
  if (-not (Test-Path $ud)) { New-Item -ItemType Directory -Path $ud -Force | Out-Null }
  $a = @((Join-Path $root "desktop"), "--no-sandbox", ("--user-data-dir=" + $ud))
  if ($holo) { $a += "--holo" }
  Start-Process -FilePath $exe -ArgumentList $a -WorkingDirectory $root
} else {
  Write-Host "[2/2] 桌面端未安装，改用浏览器打开 ..." -ForegroundColor Yellow
  Start-Process $url
}
