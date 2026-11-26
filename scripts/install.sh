#!/bin/bash
# 装机入口：实现在工作区 tools/dictpen-dev 的 `devctl install`（推包 → miniapp_cli install → start，
# 内建互斥锁；不等就绪、不校 md5、不截图）。
#
# 选项解析全在 devctl 侧（--fresh / --build / --no-build / --force / --appid / --level / --device / --via，
# 兼容别名 --vm / --ssh [目标]）。壳里不要做参数翻译，只透传：翻译后 devctl 不认
# 是踩过的坑（--vm 被翻成 --via vm、--ssh 目标被拼成 --via ssh:目标）。
#
# 用法: bash scripts/install.sh [选项]              # 完整选项见 devctl install --help
#       bash scripts/install.sh --build --force    # 先构建；清残留装机锁后接管
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
     --project "$(dpd_winpath_py "$PROJ")" install "$@"
