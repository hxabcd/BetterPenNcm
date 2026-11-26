#!/bin/bash
# 一次性设备命令的 CLI 入口（传输层 lib/device.sh 的薄壳）。
#
# device.sh 的五个原语只能被 source device.sh 的 bash 脚本用；本入口让一次性
# 设备交互（探查、miniapp_cli 调试）与未来的非 bash 工具复用同一套后端选择
# （adb/ssh/vm），不必各自拼 adb -s / ssh pen。
#
# 用法：
#   bash scripts/lib/devctl.sh [--ssh <目标>|--device <序列号>|--vm] <动作> [参数...]
# ⚠ Git Bash 会在**进程启动前**把命令行上的 /tmp/... 改写成本机临时目录
#   （MSYS_NO_PATHCONV 只挡得住脚本内部的命令，挡不住 devctl 自己的参数），
#   传设备路径参数时请：MSYS_NO_PATHCONV=1 bash scripts/lib/devctl.sh ...
# 动作：
#   run <命令串>            在设备上执行，stdout 原样透传（退出码透传，SSH 后端有意义）
#   put <本地> <远端>       推文件
#   get <远端> <本地>       拉文件（二进制安全）
#   exists <远端路径>       存在 → 退出 0，不存在 → 退出 1（adb 不回传退出码，看输出判断）
#   check                   连通性校验
# 示例：
#   bash scripts/lib/devctl.sh --ssh pen run 'miniapp_cli memoryApp'
#   bash scripts/lib/devctl.sh run 'ls /userdisk/Favorite'
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
proj_init

MODE=""
SEL_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh)    MODE=ssh
              if [ $# -gt 1 ] && [ -n "${2:-}" ] && [ "${2#-}" = "$2" ]; then SEL_ARGS+=(--ssh "$2"); shift; fi
              shift ;;
    --device) if [ $# -lt 2 ] || [ -z "${2:-}" ] || [ "${2#-}" != "$2" ]; then
                die "devctl --device: 缺序列号（用法 devctl --device <序列号> <动作> ...）"
              fi
              SEL_ARGS+=(--device "$2"); shift 2 ;;
    --vm)     MODE=vm; shift ;;
    run|put|get|exists|check) ACTION="$1"; shift; break ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *)         die "devctl: 未知参数 $1（动作：run/put/get/exists/check）" ;;
  esac
done
ACTION="${ACTION:-}"
[ -n "$ACTION" ] || die "devctl: 缺动作（run/put/get/exists/check；-h 看用法）"

# 不指定 --ssh/--device/--vm 时按项目配置选设备（工作区 targets.env 或本项目
# .dictpen-dev.env）；adb 不是默认值。
_DCTL_ARGS=()
[ -n "$MODE" ] && _DCTL_ARGS+=(--transport "$MODE")
dev_select --project "${PROJ:-$PWD}" "${_DCTL_ARGS[@]+"${_DCTL_ARGS[@]}"}" ${SEL_ARGS[@]+"${SEL_ARGS[@]}"}

case "$ACTION" in
  run)    [ $# -ge 1 ] || die "devctl run: 缺命令串"
          dev_run "$1" ;;
  put)    [ $# -ge 2 ] || die "devctl put: 用法 devctl put <本地> <远端>"
          dev_put "$1" "$2" ;;
  get)    [ $# -ge 2 ] || die "devctl get: 用法 devctl get <远端> <本地>"
          dev_get "$1" "$2" ;;
  exists) [ $# -ge 1 ] || die "devctl exists: 缺远端路径"
          if dev_exists "$1"; then exit 0; else exit 1; fi ;;
  check)  dev_check ;;
esac
