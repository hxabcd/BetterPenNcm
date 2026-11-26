#!/bin/bash
# 轮询装机：设备掉线是常态（休眠/断网/超时关机），反复试到装上为止。
#
# 用法：bash scripts/install_retry.sh [总时长秒数] [间隔秒数]
#   默认 总时长=7200（2h）、间隔=90
#
# 每轮先 `devctl check` 探连通性，离线就跳过（不做无效的 push/install）；
# 装完再 check 一次，两次都通才算成功。
set -u
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"

TOTAL="${1:-7200}"
INTERVAL="${2:-90}"

proj_init
resolve_tools
DEVCTL="$TOOLS/dictpen-dev/devctl.py"

APPID="$(appid_of)"
AMR="$(pick_amr "$APPID")"
LOG="$PROJ/tmp/install_retry.log"
mkdir -p "$PROJ/tmp"

if [ -z "$AMR" ] || [ ! -f "$AMR" ]; then
  printf '找不到 %s 的产物（先跑 bash scripts/build.sh）\n' "$APPID" >&2
  exit 1
fi
if [ ! -f "$DEVCTL" ]; then
  printf '找不到 devctl：%s\n' "$DEVCTL" >&2
  exit 1
fi

# devctl 是交给 Windows python 跑的：MSYS 的 /d/... 路径必须先转成 D:\...
# （否则 python 按当前盘解释成 D:\d\...，check 永远返回失败 —— 看起来像「设备一直离线」）
wdevctl() {
  python "$(cygpath -w "$DEVCTL")" --project "$(cygpath -w "$PROJ")" "$@"
}

say() {
  printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG"
}

say "轮询装机开始：产物=$(basename "$AMR") 总时长=${TOTAL}s 间隔=${INTERVAL}s"
DEADLINE=$(( $(date +%s) + TOTAL ))
N=0
while :; do
  N=$((N + 1))
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    say "到达总时长上限，共尝试 $N 次，放弃（产物仍在 build/）"
    exit 2
  fi
  say "── 第 $N 次尝试 ──"
  if ! wdevctl check >/dev/null 2>&1; then
    say "设备离线，跳过本次安装"
    sleep "$INTERVAL"
    continue
  fi
  say "设备在线，开始安装"
  if wdevctl install "$AMR" 2>&1 | tee -a "$LOG"; then
    if wdevctl check >/dev/null 2>&1; then
      say "✅ 安装完成（$(basename "$AMR")）"
      exit 0
    fi
    say "install 返回成功但设备随后失联，继续重试"
  else
    say "install 失败，稍后重试"
  fi
  sleep "$INTERVAL"
done
