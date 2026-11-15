#!/bin/bash
# 构建：便携 Node 18 + aiot-cli。
#
# 实现在工作区 tools/dictpen-dev/dpd/builder.py，与其它项目共用同一份。
# 本项目特有：构建前生成 buildInfo.js 与 logconfig.generated.js（都在 .gitignore
# 里，新克隆没有，缺了静态检查会报模块缺失）。
#
# 必须用便携 Node 18：系统 Node 26 会让 aiot-cli 报 `No such module: http_parser`
# 直接崩。aiot-cli 在 Node 22 上也能跑（可用 DPD_NODE 指定）。
#
# 用法: bash scripts/build.sh [--level auto|full|pack] [--log-srv <url|auto>]
#   BPNCM_LOG_SRV=http://<PC>:8888/log  设备日志回传地址
#   BPNCM_LOG_SRV=auto                   自动用本机局域网 IP（开源清理：仓库不落内网 IP）
set -e
export MSYS_NO_PATHCONV=1
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ"

. "$PROJ/scripts/lib/dev.sh"
dpd_load "$PROJ" || exit 1

LEVEL="${BPNCM_LEVEL:-auto}"
LOG_SRV_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --level=*)   LEVEL="${1#--level=}"; shift ;;
    --level)     LEVEL="${2:-auto}"; shift 2 ;;
    --log-srv)   LOG_SRV_ARG="${2:-}"; shift 2 ;;
    --log-srv=*) LOG_SRV_ARG="${1#--log-srv=}"; shift ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *)           echo "未知参数: $1"; exit 2 ;;
  esac
done

# ---------- 生成构建信息（构建号 / 日志地址）----------
PC_IP=""
if command -v ipconfig >/dev/null 2>&1; then
  PC_IP="$(ipconfig 2>/dev/null | tr -d '\r' \
    | awk '/IPv4/ { print $NF }' \
    | grep -E '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))\.' | head -1)"
fi

BUILD_TAG="$(date +%Y%m%d-%H%M%S)"
printf "/* 由 scripts/build.sh 自动生成，勿手改 */\nexport const BUILD_TAG = '%s'\n" \
  "$BUILD_TAG" > src/utils/buildInfo.js

LOG_SRV="${LOG_SRV_ARG:-${BPNCM_LOG_SRV:-}}"
if [ "$LOG_SRV" = "auto" ]; then
  if [ -z "$PC_IP" ]; then
    echo "✗ --log-srv auto 探测不到本机局域网 IP，请直接给 URL"
    exit 1
  fi
  LOG_SRV="http://$PC_IP:8888/log"
fi
if [ -n "$LOG_SRV" ]; then
  printf "/* 由 scripts/build.sh 自动生成，勿手改 */\nexport const LOG_SRV = '%s'\n" \
    "$LOG_SRV" > src/utils/logconfig.generated.js
  echo "日志服务器: $LOG_SRV"
else
  # 缺省发往 127.0.0.1 —— 设备上连不通，静默失败。这是刻意保留的缺省，
  # 免得把内网 IP 写进仓库；需要真机日志时显式传 --log-srv。
  printf "/* 由 scripts/build.sh 自动生成，勿手改 */\nexport const LOG_SRV = ''\n" \
    > src/utils/logconfig.generated.js
fi
echo "构建号: $BUILD_TAG"

exec python "$(dpd_winpath_py "$DPD_WORKSPACE/tools/dictpen-dev/devctl.py")" \
     --project "$(dpd_winpath_py "$PROJ")" build --level "$LEVEL"

