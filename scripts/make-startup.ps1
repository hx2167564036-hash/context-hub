$startup = [Environment]::GetFolderPath('Startup')
$ws = New-Object -ComObject WScript.Shell
$lnk = Join-Path $startup '天枢-手机通知.lnk'
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"D:\应用信息互联\data\start-adbnotify.vbs"'
$s.WorkingDirectory = 'D:\应用信息互联'
$s.WindowStyle = 7
$s.Save()
Write-Output ('ok: ' + $lnk)