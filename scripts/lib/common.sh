#!/bin/bash
# 公共库（供 build.sh / install.sh / shot.sh / build_probe.sh / nav_selftest.sh source）
#
# 定位：只放「环境探测 / 设备 / 产物 / 输出」这类通用能力，**不放业务流程**
# （备份、装机顺序、构建步骤留在各自脚本里，读脚本就知道它做了什么）。
#
# 为什么要有它：resolve_tools 的 worktree 兜底、设备选择、按 appid 挑产物这三件事，
# 原先在三个脚本里各写了一份且细节不一致（nav_selftest.sh 有 appid 校验，install.sh 没有）。
#
# 约定：调用方 source 本文件后调 proj_init，再按需要调其余函数。
# 不在此文件里 set -e/-u，交调用方决定。

# ---------- 输出 ----------
info() { printf '%s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ---------- 阶段与计时 ----------
_TOTAL_T0=$(date +%s)
_STEP_T0=$_TOTAL_T0
_STEP_FIRST=1

stage() {  # stage <标题>：打印阶段标题，并给出上一阶段耗时
  local now
  now=$(date +%s)
  if [ "$_STEP_FIRST" = 0 ]; then printf '    (%ss)\n' "$(( now - _STEP_T0 ))"; fi
  printf '\n==> %s\n' "$*"
  _STEP_T0=$now
  _STEP_FIRST=0
}

stage_done() {  # 收尾打印总耗时
  local now
  now=$(date +%s)
  printf '    (%ss)\n' "$(( now - _STEP_T0 ))"
  printf '==> 完成，总耗时 %ss\n' "$(( now - _TOTAL_T0 ))"
}

# ---------- 项目根 ----------
proj_init() {
  PROJ="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$PROJ" || die "进不去项目根：$PROJ"
}

# ---------- 工具链 ----------
# 主检出的 tools/ 在工作区根；worktree 里 $PROJ/../.. 是 .agents/worktrees，
# 用 git 的 common-dir 反查主工作树（worktree 的 .git 是文件，指向主仓库 .git）。
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

# 便携 Node 18 是下载来的裸 exe，可能被安全软件拦成「无输出直接退出 1」。
# aiot-cli 在 Node 22 上实测可用；Node 26 必定崩溃。
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

# ---------- 应用元信息 ----------
appid_of() {  # appid_of [package.json] → 打印 appid（本机没有 jq，用 sed）
  local f="${1:-$PROJ/package.json}" v
  [ -f "$f" ] || die "找不到 $f"
  v="$(sed -n 's/.*"appid"[[:space:]]*:[[:space:]]*"\([0-9A-Za-z]*\)".*/\1/p' "$f" | head -1)"
  [ -n "$v" ] || die "$f 里没有 appid 字段"
  printf '%s\n' "$v"
}

# ---------- 产物 ----------
# 按 appid 过滤是硬要求：build/ 里同时可能有正式版与探针版，
# 只按 mtime 取最新会把探针版装成正式应用（build_probe.sh 跑过就会出现）。
pick_amr() {  # pick_amr <appid> → 打印该 appid 最新的 .amr 绝对路径
  local appid="$1"
  ls -t "$PROJ/build/$appid".*.amr 2>/dev/null | head -1
}

# ---------- 设备 ----------
# 优先 --device / BPNCM_DEVICE；否则要求 adb devices 里恰好一台 device。
# 工作区规范要求所有 adb 操作显式带 -s，避免真机与 VM/多机同时在线时打错目标。
resolve_device() {
  local devs n
  if [ -z "${DEVICE:-}" ]; then
    if [ -n "${BPNCM_DEVICE:-}" ]; then
      DEVICE="$BPNCM_DEVICE"
    else
      devs="$(adb devices 2>/dev/null | tr -d '\r' | awk 'NR > 1 && $2 == "device" { print $1 }')"
      n="$(printf '%s' "$devs" | grep -c . || true)"
      case "$n" in
        1) DEVICE="$devs" ;;
        0) die "没找到已连接设备（adb devices 没有 device 状态；插好 USB 或确认 adb 可用）" ;;
        *) die "检测到 $n 台设备（$(printf '%s' "$devs" | tr '\n' ' ')），用 --device <序列号> 或 BPNCM_DEVICE 指定" ;;
      esac
    fi
  fi
  ADB="adb -s $DEVICE"
  $ADB get-state >/dev/null 2>&1 || die "设备无响应：$ADB get-state 失败（序列号 $DEVICE）"
}

# ---------- 网络 ----------
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
