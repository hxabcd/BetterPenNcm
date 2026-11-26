#!/bin/bash
# 调用方 source 本文件后调 proj_init；本文件不 set -e/-u，交调用方决定。

info() { printf '%s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

_TOTAL_T0=$(date +%s)
_STEP_T0=$_TOTAL_T0
_STEP_FIRST=1

stage() {
  local now
  now=$(date +%s)
  if [ "$_STEP_FIRST" = 0 ]; then printf '    (%ss)\n' "$(( now - _STEP_T0 ))"; fi
  printf '\n==> %s\n' "$*"
  _STEP_T0=$now
  _STEP_FIRST=0
}

stage_done() {
  local now
  now=$(date +%s)
  printf '    (%ss)\n' "$(( now - _STEP_T0 ))"
  printf '==> 完成，总耗时 %ss\n' "$(( now - _TOTAL_T0 ))"
}

proj_init() {
  PROJ="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$PROJ" || die "进不去项目根：$PROJ"
}

# 主检出的 tools/ 在工作区根；worktree 里 $PROJ/../.. 是整个 .agents/worktrees，
# 用 git 的 common-dir 反查主工作树（worktree 的 .git 是指向主仓库 .git 的文件）。
_workspace_root() {
  local common root
  common="$(git -C "$PROJ" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$common" ] || return 1
  root="$(dirname "$common")"
  # git 在 Windows 上给的是 D:/... 形式，转成 MSYS 路径再 cd（cd D:/... 在部分环境会失败）
  case "$root" in
    [A-Za-z]:*) root="$(cygpath -u "$root" 2>/dev/null || printf '%s' "$root")" ;;
  esac
  [ -d "$root" ] || return 1
  ( cd "$root" && pwd )
}

resolve_tools() {
  local ws="" cand
  if [ -n "${BPNCM_TOOLS:-}" ]; then
    TOOLS="$BPNCM_TOOLS"
  else
    # ⚠ 这里必须 || true：_workspace_root 失败会让赋值返回非 0，
    # set -e 下直接静默退出（一个提示都不打，极难排查）。
    ws="$(_workspace_root 2>/dev/null || true)"
    cand="$ws/tools"
    if [ -n "$ws" ] && [ -f "$cand/aiot-build/node-v18.20.8-win-x64/node.exe" ]; then
      TOOLS="$cand"
    else
      # 兜底：主检出固定路径（worktree 且拿不到 git 信息时才会走到）
      TOOLS="/d/MyPC/Others/AI-Artifacts/DictPenWorkspace/tools"
    fi
  fi
  export BPNCM_TOOLS="$TOOLS"
  NODE="${BPNCM_NODE:-$TOOLS/aiot-build/node-v18.20.8-win-x64/node.exe}"
  CLI="${BPNCM_CLI:-$TOOLS/aiot-build/node_modules/aiot-vue-cli/src/cli.js}"
}

# 便携 Node 18 是下载来的裸 exe，可能被安全软件拦成「无输出直接退出 1」；
# aiot-cli 实测在 Node 22 上可用，Node 26 必定崩溃。
require_node() {
  [ -x "$NODE" ] || die "找不到便携 Node：$NODE（可用 BPNCM_NODE=<node.exe> 指定）"
  "$NODE" -v >/dev/null 2>&1 || die "Node 起不来：$NODE
  便携 Node 18 不可用时用 BPNCM_NODE=<node.exe> 指定替代（18 或 22，别用 26）"
  [ -f "$CLI" ] || die "找不到 aiot-cli：$CLI"
}

# 上次构建被强杀时 qjsc 可能还在跑，会锁住输出文件 → 构建卡住（症状像代码错误）
qjsc_busy() {
  command -v tasklist >/dev/null 2>&1 || return 1
  tasklist /NH /FI "IMAGENAME eq qjsc20200705.exe" 2>/dev/null | tr -d '\r' | grep -qi 'qjsc20200705'
}

# 本机没有 jq，用 sed 取 appid
appid_of() {
  local f="${1:-$PROJ/package.json}" v
  [ -f "$f" ] || die "找不到 $f"
  v="$(sed -n 's/.*"appid"[[:space:]]*:[[:space:]]*"\([0-9A-Za-z]*\)".*/\1/p' "$f" | head -1)"
  [ -n "$v" ] || die "$f 里没有 appid 字段"
  printf '%s\n' "$v"
}

# 按 appid 过滤是硬要求：build/ 里可能同时有正式版与探针版，
# 只按 mtime 取最新会把探针版装成正式应用（build_probe.sh 跑过就会出现）。
pick_amr() {
  local appid="$1"
  ls -t "$PROJ/build/$appid".*.amr 2>/dev/null | head -1
}

# 设备操作统一走 device.sh 的传输层原语（dev_run/dev_put/dev_get/dev_exists）。
# 用 BASH_SOURCE 定位而不是 $PROJ：调用方可能先 source 本文件再跑 proj_init。
# shellcheck source=device.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/device.sh"

# PC 的局域网 IPv4（设备要能访问 8888 端口拉日志）
pc_lan_ip() {
  local ip
  ip="$(ipconfig 2>/dev/null | tr -d '\r' | awk '/IPv4/ { print $NF }' \
    | grep -E '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))\.' | head -1)"
  if [ -z "$ip" ]; then
    ip="$(powershell.exe -NoProfile -Command \
      "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.IPAddress -notlike '127.*' -and \$_.IPAddress -notlike '169.254.*' } | Sort-Object InterfaceMetric | Select-Object -First 1 -ExpandProperty IPAddress)" \
      2>/dev/null | tr -d '\r')"
  fi
  [ -n "$ip" ] && printf '%s\n' "$ip"
}
