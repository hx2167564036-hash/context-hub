Option Explicit
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c set PATH=%USERPROFILE%\.local\bin;%PATH%&& uvx hindsight-embed@latest daemon --profile coding-agent start >> %USERPROFILE%\.hindsight\profiles\daemon-autostart.log 2>&1", 0, False