@echo off
rem 天枢启动器：  run.cmd          普通启动
rem               run.cmd --holo   全息控制台（J.A.R.V.I.S）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*