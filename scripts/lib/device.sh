#!/bin/bash
# 设备传输层适配层：原语与连接退让的实现在工作区 tools/dictpen-dev/lib/transport.sh，
# 配置在 tools/dictpen-dev/config.toml；本文件只负责定位工作区、载入共享层，
# 并保留本项目既有的调用形态（位置参数 dev_select <mode>）与 BPNCM_* 环境变量名。
#
# 关键不变量：退出码不能用于判断成功（adbd 不回传远程退出码），
# 写操作一律 dev_exists 事后校验。
#
# 不在此文件里 set -e/-u，交调用方决定（与 lib/common.sh 相同）。

# 向上找含 tools/dictpen-dev 的目录 = 工作区根。
_dpd_find_ws() {
  local d="$1"
  while [ -n "$d" ] && [ "$d" != "/" ] && [ "$d" != "." ]; do
    if [ -f "$d/tools/dictpen-dev/lib/transport.sh" ]; then
      printf '%s' "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}

_dpd_ws="${DPD_WORKSPACE:-$(_dpd_find_ws "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)")}" || {
  printf '✗ 找不到工作区根（向上没有 tools/dictpen-dev/lib/transport.sh）\n' >&2
  printf '  本项目的设备传输层是工作区共享工具链的适配层；独立克隆需要它才能装机。\n' >&2
  exit 1
}
export DPD_WORKSPACE="$_dpd_ws"

# 必须在 dev_select 时做，不能在 source 时做：调用方常写成
#   BPNCM_TRANSPORT=ssh BPNCM_SSH=pen2 dev_select
# 这种前缀赋值只在命令执行期间存在，source 阶段根本读不到。
_dpd_map_legacy_env() {
  if [ -n "${BPNCM_TRANSPORT:-}" ] && [ -z "${DPD_TRANSPORT:-}" ]; then
    case "$BPNCM_TRANSPORT" in
      ssh) DPD_TRANSPORT="ssh" ;;
      *)   DPD_TRANSPORT="$BPNCM_TRANSPORT" ;;
    esac
  fi
  if [ -n "${BPNCM_DEVICE:-}" ] && [ -z "${BPNCM_SSH:-}" ]; then
    DPD_TRANSPORT="adb"; DPD_TARGET="$BPNCM_DEVICE"
  fi
  if [ -n "${BPNCM_SSH:-}" ]; then
    DPD_TRANSPORT="ssh"; DPD_TARGET="$BPNCM_SSH"
  fi
}

_dpd_load_shared() {
  . "$_dpd_ws/tools/dictpen-dev/lib/project.sh"
  DPD_WORKSPACE="$_dpd_ws"
  dpd_load "${PROJ:-$PWD}" || return 1
}

_dpd_load_shared || exit 1

# 部分脚本与自测直接读旧变量名 DEV_*，选择完成后同步过去
_dpd_sync_legacy_vars() {
  DEV_TRANSPORT="${DPD_EFFECTIVE_TRANSPORT:-}"
  DEV_SSH_TARGET="${DPD_SSH_TARGET:-}"
  DEV_ADB_BIN="${DPD_ADB_BIN:-adb}"
  DEV_SSH_BIN="${DPD_SSH_BIN:-ssh}"
  DEV_SCP_BIN="${DPD_SCP_BIN:-scp}"
  DEV_VM_PY="${DPD_VM_PY:-}"
  DEV_VM_DPCTL="${DPD_VM_DPCTL:-}"
  export DEV_TRANSPORT DEV_SSH_TARGET DEV_ADB_BIN DEV_SSH_BIN DEV_SCP_BIN
}

# 位置参数 / 空格分隔选项 → 共享层的 `--x=y` 形式。
# 必须知道哪些选项**带值**：否则 `--project /path` 会把 /path 当成一个连接方式
# （实际踩过：报「未知连接方式：/d/MyPC/...」）。
_dpd_takes_value() {
  case "$1" in
    --project|--transport|--target|--via|--device) return 0 ;;
    *) return 1 ;;
  esac
}

# 把「工具链登记的设备名」解析成连接链（空格分隔的 via 规格）。
# ⚠ --device 在两层里同名不同义：本项目（install.sh --help / 工作区 README）说的是
# config.toml 里登记的设备名（如 x3s），共享层 dpd_select 的 --device 是 adb 串号、
# 直接拼成 adb:<串号>；不解析就会出现 `install.sh --device x3s` 去连 adb:x3s（实际踩到）。
# 解析不到（例如传的是真串号）返回空串，调用方退回 adb 串号语义。
_dpd_device_chain() {
  local name="$1" py out
  py="$(dpd_python)" || return 1
  out="$("$py" "$(dpd_winpath_py "$DPD_WORKSPACE/tools/dictpen-dev/devctl.py")" \
           --project "$(dpd_winpath_py "${PROJ:-$PWD}")" --device "$name" env 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  ( eval "$out" >/dev/null 2>&1; printf '%s' "${DPD_VIA_SEQ:-}" )
}

dev_select() {
  _dpd_map_legacy_env
  local -a args=()
  local mode=""
  while [ $# -gt 0 ]; do
    case "$1" in
      # 两种写法都先按「登记的设备名」解析，解析不到再退回 adb 串号语义
      --device)
        local _ch; _ch="$(_dpd_device_chain "${2:-}" || true)"
        if [ -n "$_ch" ]; then args+=("--via=$_ch"); else args+=("--device" "${2:-}"); fi
        shift 2 ;;
      --device=*)
        local _ch2; _ch2="$(_dpd_device_chain "${1#--device=}" || true)"
        if [ -n "$_ch2" ]; then args+=("--via=$_ch2"); else args+=("--device" "${1#--device=}"); fi
        shift ;;
      --*=|--*=*) args+=("$1"); shift ;;
      --project|--transport|--target|--via)
        args+=("$1=${2:-}"); shift 2 ;;
      --ssh)
        shift
        if [ $# -ge 1 ] && [ -n "${1:-}" ] && [ "${1#-}" = "$1" ]; then
          args+=("--via=ssh:$1"); shift
        else
          args+=("--via=ssh")
        fi ;;
      --vm)  args+=("--via=vm"); shift ;;
      -*)
        if _dpd_takes_value "$1"; then
          args+=("$1=${2:-}"); shift 2
        else
          args+=("$1"); shift
        fi ;;
      *)     mode="$1"; shift ;;
    esac
  done

  if [ -n "$mode" ]; then
    case "$mode" in
      auto) args=("--via=auto" ${args[@]+"${args[@]}"}) ;;
      *)    args=("--via=$mode" ${args[@]+"${args[@]}"}) ;;
    esac
  fi

  # 什么都没给：用环境变量（BPNCM_* 已翻译到 DPD_*）或项目配置的缺省链。
  if [ ${#args[@]} -eq 0 ] && [ -n "${DPD_TRANSPORT:-}" ] && [ "$DPD_TRANSPORT" != "auto" ]; then
    if [ -n "${DPD_TARGET:-}" ]; then
      args+=("--via=$DPD_TRANSPORT:$DPD_TARGET")
    else
      args+=("--via=$DPD_TRANSPORT")
    fi
  fi
  args+=("--project=${PROJ:-$PWD}")

  dpd_select ${args[@]+"${args[@]}"} || return $?
  _dpd_sync_legacy_vars
}
