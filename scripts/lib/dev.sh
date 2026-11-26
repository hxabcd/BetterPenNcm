#!/bin/bash
# 实现在工作区 tools/dictpen-dev/lib/project.sh；本文件只负责找到它并载入。
# 工作区根随 worktree 层级变化，固定相对路径不可靠，只能向上搜。

# 向上找到含 tools/dictpen-dev 的目录 = 工作区根。
_dpd_local_find_ws() {
  local d
  d="$(cd "${1:-$PWD}" 2>/dev/null && pwd)" || return 1
  while [ -n "$d" ] && [ "$d" != "/" ] && [ "$d" != "." ]; do
    if [ -f "$d/tools/dictpen-dev/lib/project.sh" ]; then
      printf '%s' "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}

_dpd_local_ws="$(_dpd_local_find_ws "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)")"
if [ -z "$_dpd_local_ws" ]; then
  printf '✗ 找不到工作区根（向上没有 tools/dictpen-dev/lib/project.sh）\n' >&2
  printf '  本项目的设备操作依赖工作区共享调试工具链；独立克隆需要它才能装机。\n' >&2
  return 1 2>/dev/null || exit 1
fi
# shellcheck source=/dev/null
. "$_dpd_local_ws/tools/dictpen-dev/lib/project.sh"
