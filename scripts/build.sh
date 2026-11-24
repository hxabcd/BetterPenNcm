#!/bin/bash
# 构建入口：实现在工作区 tools/dictpen-dev（便携 Node 18 + aiot-cli）。
# 项目差异（前置步骤、必需原生库、构建级别）声明在 tools/dictpen-dev/config.toml。
#
# 本文件是薄壳，只做三件事：定位项目根、定位工作区工具链、把参数原样交给
# `devctl build`。构建逻辑、互斥锁、Node 探测、产物收集都在 dpd/builder.py。
#
# 用法: bash scripts/build.sh [--level auto|full|pack] [--force]
#   --level  覆盖 config.toml 里的 build.level
#   --force  清掉残留的构建锁（上次被强杀、锁没释放时用）
#
# 构建期要注入的东西一律走环境变量（Python 读它），不要往这里加命令行参数，
# 否则三个项目的壳就不再同构了。
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
