' Context Hub: start the 7311 server in the background, detached from any console.
' Launched by scripts/restart-server.ps1 or `wscript scripts\start-server.vbs`.
' Set CTXHUB_NODE to point at a specific node.exe; defaults to "node" on PATH.
Option Explicit
Dim fso, sh, root, nodeExe, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodeExe = sh.ExpandEnvironmentStrings("%CTXHUB_NODE%")
If nodeExe = "%CTXHUB_NODE%" Then nodeExe = "node"
cmd = "cmd /c cd /d """ & root & """ && """ & nodeExe & """ src\server.mjs >> data\server.out.log 2>> data\server.err.log"
sh.Run cmd, 0, False
