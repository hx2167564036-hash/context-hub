#requires -Version 5.1
<#
.SYNOPSIS
  抓取当前/指定窗口的文本：优先 UI Automation，取不到/太少时用 PrintWindow 截图 + Windows.Media.Ocr 识别。

.DESCRIPTION
  给「天枢」的钉钉方案 A（全局快捷键抓当前钉钉窗口）与微信 4.x 界面读取用。
  本文件必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 GBK 解析中文而报语法错误。

  流程：
    1. 找目标窗口：-ProcessName 指定任意进程；否则按 -App 的进程名列表找；
       -App foreground 且没给 -ProcessName 时取 GetForegroundWindow。
    2. -Method uia/auto：TreeWalker 遍历控件树，收 TextPattern(DocumentRange)/ValuePattern/Name，
       去重并按控件层级顺序拼接。
    3. auto 模式下 UIA 文本 >= 200 字直接用；否则（或 -Method ocr）截图 + WinRT OCR 兜底。
    4. 结果写成 JSON：{ ok, app, hwnd, title, method, chars, text, png, ... }。

.PARAMETER App
  dingtalk | wechat | foreground。决定按哪些进程名找主窗口（foreground=当前前台窗口）。

.PARAMETER Method
  auto（默认）：UIA 优先、OCR 兜底；uia：只用 UIA；ocr：只用 OCR。

.PARAMETER JsonOut
  结果 JSON 输出文件路径（UTF-8 无 BOM）。不给则打印到 stdout。

.PARAMETER Png
  截图输出文件路径。需要走 OCR 时默认写到 data\tmp\grab-<时间戳>.png。

.PARAMETER MaxChars
  返回文本的最大字符数，默认 20000。

.PARAMETER ProcessName
  直接指定进程名（如 notepad、Weixin），用于自测或非钉钉/微信窗口。优先级高于 -App 的进程列表。

.PARAMETER Capture
  截图方式：auto（PrintWindow 失败则屏幕拷贝）| printwindow | screen。

.EXAMPLE
  powershell -NoProfile -Sta -ExecutionPolicy Bypass -File scripts\win-grab.ps1 -App dingtalk -Method auto -JsonOut data\tmp\dingtalk.json

.EXAMPLE
  powershell -NoProfile -Sta -ExecutionPolicy Bypass -File scripts\win-grab.ps1 -App foreground -ProcessName notepad -Method uia -JsonOut data\tmp\notepad.json
#>
# 注意：不要加 [CmdletBinding()]！在受限（沙箱）环境里用 powershell.exe -File 调用
# 高级脚本时会抛出 "无法使用点 '.' 获得此命令来源，因为该命令是在不同语言模式下定义的
# (DotSourceNotSupported)"，脚本根本跑不起来。普通 param 块完全够用。
param(
    [ValidateSet('dingtalk', 'wechat', 'foreground')]
    [string]$App = 'foreground',

    [ValidateSet('auto', 'uia', 'ocr')]
    [string]$Method = 'auto',

    [string]$JsonOut = '',

    [string]$Png = '',

    [int]$MaxChars = 20000,

    [string]$ProcessName = '',

    [ValidateSet('auto', 'printwindow', 'screen')]
    [string]$Capture = 'auto'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- 基础环境 ----
$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $script:ScriptDir) { $script:ScriptDir = (Get-Location).Path }
$script:WorkDir = [System.IO.Path]::GetFullPath((Join-Path $script:ScriptDir '..\data\tmp'))
if (-not (Test-Path -LiteralPath $script:WorkDir)) {
    New-Item -ItemType Directory -Path $script:WorkDir -Force | Out-Null
}

# 沙箱/受限环境下默认 TEMP 目录可能不可写（Add-Type 编译 C# 需要临时目录），
# 把本进程的 TEMP/TMP 指到 data\tmp 下，避免 Add-Type 报「访问被拒绝」。
$script:TempDir = Join-Path $script:WorkDir 'ps-temp'
if (-not (Test-Path -LiteralPath $script:TempDir)) {
    New-Item -ItemType Directory -Path $script:TempDir -Force | Out-Null
}
$env:TEMP = $script:TempDir
$env:TMP = $script:TempDir

$script:MaxChars = $MaxChars
$script:TextLimit = $MaxChars + 2000
$script:Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$script:Result = [ordered]@{
    ok        = $false
    app       = $App
    hwnd      = [int64]0
    title     = ''
    method    = 'none'
    chars     = 0
    text      = ''
    png       = ''
    process   = ''
    truncated = $false
    reason    = ''
}

function Write-GrabResult {
    param([int]$ExitCode = 0)
    $json = $script:Result | ConvertTo-Json -Depth 6
    if ($JsonOut) {
        $outPath = [System.IO.Path]::GetFullPath($JsonOut)
        $outDir = Split-Path -Parent $outPath
        if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
            New-Item -ItemType Directory -Path $outDir -Force | Out-Null
        }
        [System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    }
    else {
        [Console]::Out.Write($json)
        [Console]::Out.WriteLine()
    }
    exit $ExitCode
}

# ------------------------------------------------------------ Win32 封装 ----
$script:Win32Source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class HubGrab32
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static List<IntPtr> AllTopWindows()
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    public static string TitleOf(IntPtr h)
    {
        int n = GetWindowTextLength(h);
        if (n <= 0) return "";
        StringBuilder sb = new StringBuilder(n + 2);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static uint PidOf(IntPtr h)
    {
        uint p;
        GetWindowThreadProcessId(h, out p);
        return p;
    }

    public static bool RectOf(IntPtr h, out int left, out int top, out int width, out int height)
    {
        RECT r;
        left = 0; top = 0; width = 0; height = 0;
        if (!GetWindowRect(h, out r)) return false;
        left = r.Left; top = r.Top;
        width = r.Right - r.Left;
        height = r.Bottom - r.Top;
        return width > 0 && height > 0;
    }
}
'@

function Initialize-Win32 {
    if (-not ('HubGrab32' -as [type])) {
        Add-Type -TypeDefinition $script:Win32Source -Language CSharp -ErrorAction Stop
    }
    try { [void][HubGrab32]::SetProcessDPIAware() } catch { }
}

# ------------------------------------------------------------- 找窗口 ----
function Find-TargetWindow {
    param([string[]]$ProcNames)

    $found = [IntPtr]::Zero
    $procLabel = ''

    if ($ProcNames.Count -eq 0) {
        $fg = [HubGrab32]::GetForegroundWindow()
        if ($fg -ne [IntPtr]::Zero) {
            $procLabel = ''
            try { $procLabel = (Get-Process -Id ([int][HubGrab32]::PidOf($fg)) -ErrorAction SilentlyContinue).ProcessName } catch { }
        }
        return @($fg, $procLabel)
    }

    $procObjects = @()
    $pids = @()
    foreach ($pn in $ProcNames) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($pn)
        if (-not $base) { continue }
        $ps = @(Get-Process -Name $base -ErrorAction SilentlyContinue)
        if ($ps.Count -gt 0) {
            $procObjects = $ps
            $procLabel = $ps[0].ProcessName
            foreach ($p in $ps) { $pids += [int]$p.Id }
            break
        }
    }
    if ($pids.Count -eq 0) { return @([IntPtr]::Zero, '') }

    $best = [IntPtr]::Zero
    $bestArea = 0
    $bestUntitled = [IntPtr]::Zero
    $bestUntitledArea = 0

    foreach ($h in [HubGrab32]::AllTopWindows()) {
        if (-not [HubGrab32]::IsWindowVisible($h)) { continue }
        if ($pids -notcontains ([int][HubGrab32]::PidOf($h))) { continue }
        $cls = [HubGrab32]::ClassOf($h)
        if ($cls -eq 'Windows.UI.Core.CoreWindow') { continue }
        if ($cls -eq 'Shell_TrayWnd' -or $cls -eq 'Progman') { continue }

        $wl = 0; $wt = 0; $ww = 0; $wh = 0
        if (-not [HubGrab32]::RectOf($h, [ref]$wl, [ref]$wt, [ref]$ww, [ref]$wh)) { continue }
        $area = $ww * $wh
        $title = [HubGrab32]::TitleOf($h)
        if ($title.Length -gt 0) {
            if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
        }
        elseif ($area -gt $bestUntitledArea) { $bestUntitledArea = $area; $bestUntitled = $h }
    }

    if ($best -ne [IntPtr]::Zero) { return @($best, $procLabel) }
    if ($bestUntitled -ne [IntPtr]::Zero) { return @($bestUntitled, $procLabel) }

    # 兜底：进程自己的 MainWindowHandle
    foreach ($p in $procObjects) {
        if ($p.MainWindowHandle -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
            return @($p.MainWindowHandle, $procLabel)
        }
    }
    return @([IntPtr]::Zero, $procLabel)
}

# -------------------------------------------------------------- UIA 取文 ----
function Add-TextPart {
    param([string]$S)

    if ([string]::IsNullOrWhiteSpace($S)) { return }
    $t = $S.Replace("`r`n", "`n").Replace("`r", "`n").Trim()
    if ($t.Length -lt 1) { return }
    if (-not $script:uiaSeen.Add($t)) { return }

    # 长文本（文档/聊天记录整体文本）已覆盖的片段不再重复拼接
    if ($t.Length -ge 24) {
        foreach ($b in $script:uiaBig) {
            if ($b.Length -gt $t.Length -and $b.Contains($t)) { return }
        }
    }
    $script:uiaParts.Add($t)
    if ($t.Length -ge 24) { $script:uiaBig.Add($t) }
}

function Add-ElementText {
    param([System.Windows.Automation.AutomationElement]$El)

    $pat = $null
    if ($El.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) {
        try {
            $tp = [System.Windows.Automation.TextPattern]$pat
            $range = $tp.DocumentRange
            if ($null -ne $range) {
                $txt = $range.GetText($script:TextLimit)
                Add-TextPart $txt
            }
        }
        catch { }
    }

    $pat = $null
    if ($El.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
        try {
            $val = ([System.Windows.Automation.ValuePattern]$pat).Current.Value
            Add-TextPart $val
        }
        catch { }
    }

    try {
        $nm = $El.Current.Name
        if ($nm) { Add-TextPart $nm }
    }
    catch { }
}

function Get-UiaText {
    param([IntPtr]$Hwnd, [int]$BudgetMs = 12000, [int]$MaxNodes = 8000)

    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop

    $root = $null
    try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd) }
    catch { return '' }
    if ($null -eq $root) { return '' }

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $script:uiaSeen = New-Object 'System.Collections.Generic.HashSet[string]'
    $script:uiaParts = New-Object 'System.Collections.Generic.List[string]'
    $script:uiaBig = New-Object 'System.Collections.Generic.List[string]'
    $script:uiaStop = $false

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($root, 0))
    $nodes = 0

    while ($stack.Count -gt 0) {
        if ($nodes -ge $MaxNodes) { break }
        if ($sw.ElapsedMilliseconds -gt $BudgetMs) { break }

        $item = $stack.Pop()
        $el = $item[0]
        $depth = [int]$item[1]
        $nodes++

        try { Add-ElementText -El $el } catch { }

        if ($depth -ge 40) { continue }

        $kids = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'
        try {
            $child = $walker.GetFirstChild($el)
            while ($null -ne $child) {
                $kids.Add($child)
                $child = $walker.GetNextSibling($child)
            }
        }
        catch { }
        for ($i = $kids.Count - 1; $i -ge 0; $i--) {
            $stack.Push(@($kids[$i], ($depth + 1)))
        }
    }

    return ($script:uiaParts -join "`n")
}

# -------------------------------------------------------------- 截图 ----
function Test-BitmapBlank {
    # 判断截图是不是「纯色空白图」：部分 UWP / 硬件加速窗口 PrintWindow 会返回黑图
    param([System.Drawing.Bitmap]$Bitmap)

    $stepX = [Math]::Max(1, [int]($Bitmap.Width / 24))
    $stepY = [Math]::Max(1, [int]($Bitmap.Height / 16))
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    for ($y = 0; $y -lt $Bitmap.Height; $y += $stepY) {
        for ($x = 0; $x -lt $Bitmap.Width; $x += $stepX) {
            [void]$seen.Add($Bitmap.GetPixel($x, $y).ToArgb())
            if ($seen.Count -gt 3) { return $false }
        }
    }
    return ($seen.Count -le 3)
}

function Invoke-Capture {
    param([IntPtr]$Hwnd, [string]$Path, [string]$Mode = 'auto')

    Add-Type -AssemblyName System.Drawing -ErrorAction Stop

    $l = 0; $t = 0; $w = 0; $h = 0
    if (-not [HubGrab32]::RectOf($Hwnd, [ref]$l, [ref]$t, [ref]$w, [ref]$h)) {
        throw 'GetWindowRect 失败（窗口可能已关闭）'
    }

    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $used = ''

    if ($Mode -ne 'screen') {
        $hdc = $g.GetHdc()
        try {
            $ok = [HubGrab32]::PrintWindow($Hwnd, $hdc, 2)
        }
        finally {
            $g.ReleaseHdc($hdc)
        }
        if ($ok -and -not (Test-BitmapBlank -Bitmap $bmp)) { $used = 'printwindow' }
    }
    if (-not $used) {
        # PrintWindow 失败或只拿到纯色空白图（UWP/硬件加速窗口常见），切前台后抓屏兜底
        [void][HubGrab32]::ShowWindow($Hwnd, 9)          # SW_RESTORE
        [void][HubGrab32]::SetForegroundWindow($Hwnd)
        Start-Sleep -Milliseconds 250
        $g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size($w, $h)))
        $used = 'screen'
    }
    $g.Dispose()

    $outDir = Split-Path -Parent $Path
    if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
        New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    }
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return $used
}

# -------------------------------------------------------------- OCR ----
function Initialize-Ocr {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop

    $winrtTypes = @(
        'Windows.Globalization.Language',
        'Windows.Media.Ocr.OcrEngine',
        'Windows.Media.Ocr.OcrResult',
        'Windows.Graphics.Imaging.SoftwareBitmap',
        'Windows.Graphics.Imaging.BitmapPixelFormat',
        'Windows.Graphics.Imaging.BitmapAlphaMode'
    )
    foreach ($tn in $winrtTypes) {
        try { [void]([type]"$tn, Windows.Foundation, ContentType=WindowsRuntime") }
        catch { }
    }

    # 注意：不要用 Windows.Storage.StorageFile.GetFileFromPathAsync 读图！
    # 非打包桌面进程调用它读普通路径会抛 UnauthorizedAccessException(0x80070005)
    # （"该项目没有位于应用程序可以访问的位置"）。改用像素字节 + IBuffer 的纯内存路径。
    $bufExt = $null
    # 直接写类型名最可靠（GetType 在这个上下文里有时返回 $null，但类型字面量走 PS 的类型缓存能解析到）
    try { $bufExt = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions] }
    catch { $bufExt = $null }
    if ($null -eq $bufExt) {
        $bufExt = [Type]::GetType('System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions, System.Runtime.WindowsRuntime')
    }
    if ($null -eq $bufExt) { throw 'System.Runtime.WindowsRuntime 里找不到 WindowsRuntimeBufferExtensions' }
    $asBuffer = $null
    foreach ($m in $bufExt.GetMethods()) {
        if ($m.Name -eq 'AsBuffer' -and $m.GetParameters().Count -eq 1) { $asBuffer = $m; break }
    }
    if ($null -eq $asBuffer) { throw 'WindowsRuntimeBufferExtensions 里找不到 AsBuffer(byte[])' }
    $script:AsBufferMethod = $asBuffer

    $asTask = $null
    foreach ($m in [System.WindowsRuntimeSystemExtensions].GetMethods()) {
        if ($m.Name -eq 'AsTask' -and $m.GetParameters().Count -eq 1) {
            $p0 = $m.GetParameters()[0]
            if ($p0.ParameterType.Name -eq 'IAsyncOperation`1') { $asTask = $m; break }
        }
    }
    if ($null -eq $asTask) { throw 'System.Runtime.WindowsRuntime 里找不到 AsTask(IAsyncOperation<T>)' }
    $script:AsTaskMethod = $asTask

    $engine = $null
    try {
        $lang = New-Object -TypeName 'Windows.Globalization.Language' -ArgumentList 'zh-Hans-CN'
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    }
    catch { $engine = $null }
    if ($null -eq $engine) {
        try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $engine = $null }
    }
    if ($null -eq $engine) { throw 'OCR 引擎不可用（没有可用的 OCR 语言包）' }

    # PS 5.1 里 WinRT 的 uint 属性有时绑不上，MaxImageDimension 会读成 0，给个保守上限
    $maxDim = 0
    try { $maxDim = [int]$engine.MaxImageDimension } catch { $maxDim = 0 }
    if ($maxDim -le 0) { $maxDim = 2600 }
    $script:OcrMaxDim = $maxDim
    return $engine
}

function Await-WinRT {
    param($Operation, [Type]$ResultType, [int]$TimeoutMs = 60000)

    $m = $script:AsTaskMethod.MakeGenericMethod($ResultType)
    $task = $m.Invoke($null, @($Operation))
    try {
        if (-not $task.Wait($TimeoutMs)) { throw 'WinRT 异步操作超时' }
    }
    catch [System.AggregateException] {
        $inner = $_.Exception
        while ($null -ne $inner.InnerException) { $inner = $inner.InnerException }
        throw ('WinRT 异步失败：' + $inner.GetType().Name + ' - ' + $inner.Message)
    }
    return $task.Result
}

function Get-OcrText {
    param([string]$PngPath)

    $engine = Initialize-Ocr
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop

    # 1) 读 PNG → 按引擎上限缩放（小图放大有助中文识别）→ 画到不透明白底 32bpp 位图
    $src = [System.Drawing.Image]::FromFile($PngPath)
    $nw = 0
    $nh = 0
    $bmp = $null
    try {
        $w = $src.Width
        $h = $src.Height
        $maxDim = [int]$script:OcrMaxDim
        $scale = 1.0
        $longest = [Math]::Max($w, $h)
        if ($longest -gt $maxDim) { $scale = [double]$maxDim / [double]$longest }
        elseif ($w -lt 900 -and ($w * 2) -le $maxDim -and ($h * 2) -le $maxDim) { $scale = 2.0 }
        $nw = [int][Math]::Max(1, [Math]::Round($w * $scale))
        $nh = [int][Math]::Max(1, [Math]::Round($h * $scale))

        $bmp = New-Object System.Drawing.Bitmap($nw, $nh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.Clear([System.Drawing.Color]::White)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.DrawImage($src, 0, 0, $nw, $nh)
        $g.Dispose()
    }
    finally {
        $src.Dispose()
    }

    # 2) 取 BGRA 像素字节（白底填充后 alpha=255，OCR 不会当成透明图）
    $bytes = $null
    try {
        $rect = New-Object System.Drawing.Rectangle(0, 0, $nw, $nh)
        $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $stride = $data.Stride
            $rowBytes = $nw * 4
            if ($stride -eq $rowBytes) {
                $bytes = New-Object byte[] ($stride * $nh)
                [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
            }
            else {
                $bytes = New-Object byte[] ($rowBytes * $nh)
                for ($y = 0; $y -lt $nh; $y++) {
                    $rowPtr = [IntPtr]::Add($data.Scan0, $y * $stride)
                    [System.Runtime.InteropServices.Marshal]::Copy($rowPtr, $bytes, $y * $rowBytes, $rowBytes)
                }
            }
        }
        finally {
            $bmp.UnlockBits($data)
        }
    }
    finally {
        $bmp.Dispose()
    }

    # 3) byte[] → IBuffer → SoftwareBitmap → OcrEngine.RecognizeAsync
    # 注意：必须用静态方法直接调用（PS 能正确把 byte[] 绑定到 byte[] 形参）；
    # 走 MethodInfo.Invoke 会因参数被包成 PSObject 而报“无法转换为 System.Byte[]”。
    $ibuf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
    $sb = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer(
        $ibuf,
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        $nw,
        $nh,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
    try {
        $ocr = Await-WinRT ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
        $lines = New-Object 'System.Collections.Generic.List[string]'
        foreach ($ln in $ocr.Lines) {
            $t = [string]$ln.Text
            if ([string]::IsNullOrWhiteSpace($t)) { continue }
            # 中文被 OCR 拆开的空格去掉：上 下 文 → 上下 文
            $t = [regex]::Replace($t, '(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])', '')
            $lines.Add($t)
        }
        return ($lines -join "`n")
    }
    finally {
        try { $sb.Dispose() } catch { }
    }
}

# ----------------------------------------------------------------- 主流程 ----
try {
    Initialize-Win32

    # 1) 目标窗口
    $procNames = @()
    if ($ProcessName) {
        $procNames = @($ProcessName)
    }
    else {
        switch ($App) {
            'dingtalk' { $procNames = @('DingTalk', 'DingTalkApp', 'DingTalkAppExe') }
            'wechat' { $procNames = @('WeChat', 'Weixin', 'WeChatAppEx', 'WeChatApp') }
            default { $procNames = @() }
        }
    }

    $found = Find-TargetWindow -ProcNames $procNames
    $hwnd = [IntPtr]$found[0]
    $procLabel = [string]$found[1]

    if ($hwnd -eq [IntPtr]::Zero) {
        if ($procNames.Count -gt 0) {
            $script:Result.reason = '未找到窗口：进程 ' + ($procNames -join '/') + ' 没有可见主窗口'
        }
        else {
            $script:Result.reason = '未找到窗口：GetForegroundWindow 返回空句柄'
        }
        Write-GrabResult -ExitCode 2
    }

    $hwndVal = $hwnd.ToInt64()
    $title = [HubGrab32]::TitleOf($hwnd)
    $script:Result.hwnd = [int64]$hwndVal
    $script:Result.title = $title
    $script:Result.process = $procLabel

    # 最小化的窗口先还原，否则截图/OCR 会是黑图
    if ([HubGrab32]::IsIconic($hwnd)) {
        [void][HubGrab32]::ShowWindow($hwnd, 9)
        Start-Sleep -Milliseconds 350
    }

    $uiaText = ''
    $ocrText = ''
    $usedMethod = 'none'
    $uiaError = ''
    $ocrError = ''

    if ($Method -eq 'uia' -or $Method -eq 'auto') {
        try { $uiaText = Get-UiaText -Hwnd $hwnd }
        catch { $uiaError = $_.Exception.Message; $uiaText = '' }
    }

    $finalText = ''
    if ($Method -eq 'uia') {
        $usedMethod = 'uia'
        $finalText = $uiaText
    }
    elseif ($Method -eq 'auto' -and $uiaText.Trim().Length -ge 200) {
        $usedMethod = 'uia'
        $finalText = $uiaText
    }
    else {
        # 需要 OCR
        $pngPath = $Png
        if (-not $pngPath) {
            $pngPath = Join-Path $script:WorkDir ("grab-{0}-{1}.png" -f $App, $script:Stamp)
        }
        else {
            $pngPath = [System.IO.Path]::GetFullPath($pngPath)
        }
        $capUsed = ''
        try {
            $capUsed = Invoke-Capture -Hwnd $hwnd -Path $pngPath -Mode $Capture
            $script:Result.png = $pngPath
            $ocrText = Get-OcrText -PngPath $pngPath
        }
        catch {
            $ocrError = $_.Exception.Message
            if ($capUsed -and $script:Result.png -eq '') { $script:Result.png = $pngPath }
        }

        if ($Method -eq 'ocr') {
            $usedMethod = 'ocr'
            $finalText = $ocrText
        }
        else {
            # auto 兜底：OCR 没取到或比 UIA 还少时，退回 UIA 拿到的内容
            if ($ocrText.Trim().Length -gt 0 -and $ocrText.Trim().Length -ge $uiaText.Trim().Length) {
                $usedMethod = 'ocr'
                $finalText = $ocrText
            }
            else {
                $usedMethod = 'uia'
                $finalText = $uiaText
            }
        }
    }

    $finalText = $finalText.Trim()
    if ($finalText.Length -gt $script:MaxChars) {
        $finalText = $finalText.Substring(0, $script:MaxChars)
        $script:Result.truncated = $true
    }

    $script:Result.method = $usedMethod
    $script:Result.text = $finalText
    $script:Result.chars = $finalText.Length
    $script:Result.ok = ($finalText.Length -gt 0)

    if (-not $script:Result.ok) {
        $bits = @()
        if ($uiaError) { $bits += ('UIA 异常：' + $uiaError) }
        if ($ocrError) { $bits += ('OCR 异常：' + $ocrError) }
        if ($bits.Count -eq 0) { $bits += 'UIA 与 OCR 都没有取到文本' }
        $script:Result.reason = ($bits -join '；')
    }

    Write-GrabResult -ExitCode ($(if ($script:Result.ok) { 0 } else { 1 }))
}
catch {
    $script:Result.ok = $false
    $script:Result.reason = ('未捕获异常：' + $_.Exception.Message)
    Write-GrabResult -ExitCode 1
}
