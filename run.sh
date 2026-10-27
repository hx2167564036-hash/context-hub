#!/usr/bin/env bash
# 天枢启动器：  ./run.sh           普通启动
#                    ./run.sh --holo    全息控制台（J.A.R.V.I.S）
cd "$(dirname "$0")" || exit 1
exec powershell -NoProfile -ExecutionPolicy Bypass -File ./run.ps1 "$@"