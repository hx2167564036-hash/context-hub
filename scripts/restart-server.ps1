# 重启天枢服务（默认 7311）：结束占用端口的旧进程，再在后台拉起 src/server.mjs。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-server.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-server.ps1 -Dry   # 只看会结束哪个进程
#
# 为什么不能只重启桌面端：Electron 自己拉起的服务是它的子进程，关掉窗口不一定带走；
# 反过来，从一个受限/临时终端里 Start-Process 出来的服务也会随那个终端被回收。
# 所以这里改用 wscript + scripts\start-server.vbs：新进程有自己的隐藏控制台，不属于调用者的进程树。
#
# 注意：本文件必须存成 UTF-8 with BOM，Windows PowerShell 5.1 否则按 GBK 解析中文会报语法错。
param([switch]$Dry, [int]$Port = 7311)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

function Get-OwnerPid {
  param([int]$p)
  $lines = & netstat -ano -p tcp | Select-String -Pattern (":$p\s+\S+\s+LISTENING\s+(\d+)")
  $pids = @()
  foreach ($l in $lines) {
    if ($l.Matches.Count -gt 0) { $pids += [int]$l.Matches[0].Groups[1].Value }
  }
  return $pids | Select-Object -Unique
}

$owners = Get-OwnerPid -p $Port
if (-not $owners) {
  "端口 $Port 上没有监听进程"
} else {
  foreach ($procId in $owners) {
    try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $name = '?' }
    if ($Dry) { "[dry] 将结束 PID $procId ($name)"; continue }
    try { Stop-Process -Id $procId -Force -ErrorAction Stop; "已结束 PID $procId ($name)" }
    catch { "结束 PID $procId 失败：$($_.Exception.Message)" }
  }
}
if ($Dry) { exit 0 }

Start-Sleep -Milliseconds 800
# 用 wscript 跑 scripts\start-server.vbs：cmd 拿到自己的隐藏控制台，脱离调用者的进程树/控制台，
# 命令结束、工具回收 job 都不会把它带走（WMI Win32_Process.Create 与 Start-Process 都会被回收）。
$vbs = Join-Path $root 'scripts\start-server.vbs'
if (-not (Test-Path $vbs)) { "找不到启动器 $vbs"; exit 1 }
$env:PORT = "$Port"
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
Start-Process -FilePath $wscript -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden | Out-Null
"已交给后台启动器 scripts\start-server.vbs（端口 $Port）"

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $resp = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/stats" -TimeoutSec 2
    if ($resp.StatusCode -eq 200) {
      $j = $resp.Content | ConvertFrom-Json
      "已启动：http://127.0.0.1:$Port （资料 $($j.total) 条）"
      exit 0
    }
  } catch { }
}
"启动失败，检查 $err"; exit 1
