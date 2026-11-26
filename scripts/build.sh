#!/bin/bash
# 构建入口：实现在工作区 tools/dictpen-dev（便携 Node 18 + aiot-cli；系统 Node 26 会让 aiot-cli 崩）。
# 本文件是薄壳，只定位项目根与工作区工具链，参数原样交给 `devctl build`。
#
# 用法: bash scripts/build.sh [--level auto|full|pack] [--force]
#   --force  清掉残留的构建锁（上次被强杀、锁没释放时用）
#
# 构建期要注入的变量（如 BPNCM_LOG_SRV）一律走环境变量（Python 读它），不要在这里加命令行参数。
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"; cd "$PROJ"
. "$PROJ/scripts/lib/dev.sh"
WS="$(dpd_find_workspace "$PROJ")" || {
  printf '✗ 找不到工作区根（向上没有 tools/dictpen-dev/lib/transport.sh）\n' >&2
  exit 1
}
PY="$(dpd_python)" || {
  printf '✗ 需要 Python 3.11+（配置是 TOML，用内建 tomllib 解析）\n' >&2
  exit 1
}
export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"
exec "$PY" "$(dpd_winpath_py "$WS/tools/dictpen-dev/devctl.py")" \
     --project "$(dpd_winpath_py "$PROJ")" build "$@"
