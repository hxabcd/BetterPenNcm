#!/bin/bash
# 设备传输层（供 install.sh / shot.sh / nav_selftest.sh source）
#
# 定位：把「怎么连设备、怎么执行命令、怎么传文件」收进一处。上层脚本只面对
# 五个原语，不出现 adb / ssh / scp / dpctl 字样，也不自己处理各后端的怪癖。
#
# 为什么要有它：原先 install.sh 自己定义 dev_run/dev_put（adb 与 --vm 两套），
# shot.sh 与 nav_selftest.sh 却直接写 $ADB shell/push/pull。三种目标（真机 ADB /
# 真机 SSH / 虚拟机 dpctl）的能力因此散在三处，加一种连接要改每个文件。
#
# ---------- 接口（调用方只需知道这些）----------
#   dev_select <adb|ssh|vm> [--device <序列号>] [--ssh <目标>] [--vm]
#       选择后端并做连通性校验；失败 die。导出 DEVICE / DEVICE_LABEL 供上层显示。
#       --ssh 目标：ssh 别名或 user@host（单参数，走 ~/.ssh/config），空 = 默认别名。
#       环境变量：BPNCM_TRANSPORT=ssh 让脚本默认走 SSH；BPNCM_SSH=<目标>；
#                 BPNCM_DEVICE=<adb 序列号>；BPNCM_VM_PY=<python>。
#   dev_run <命令串>   在设备上执行 shell 命令，stdout 原样返回。
#   dev_put <本地> <远端>  推文件（远端可写文件名，也可写以 / 结尾的目录）。
#   dev_get <远端> <本地>  拉文件（二进制安全；ssh 后端优先 scp，缺 sftp 时回退 base64）。
#   dev_exists <远端路径>  存在返回 0。
#   dev_check            连通性校验，失败 die（dev_select 已调用，一般无需再调）。
#
# ---------- 接口契约 / 不变量 ----------
#   * 命令串可以含引号、管道、重定向；后端负责把它完整送到设备 shell。
#   * 退出码**不能用于判断成功**：这台设备 adbd 不回传远程退出码（`adb shell
#     "test -e 不存在"` 本地 rc 也是 0，2026-11-01 实测）。所有关键写操作用
#     dev_exists 事后校验；SSH 后端虽然能回传真实退出码，但上层不依赖它，
#     保持两种连接行为一致。因此上层现有的 `dev_run ... || die` 分支在 ADB 下
#     不会触发、在 SSH 下会真实触发——这是预期的 fail-fast 增强，die 文案本就
#     写明「数据仍在原位」之类的事后状态，两种后端下语义自洽。
#   * 路径是设备侧 POSIX 路径（/userdisk/...）；本地路径由本层负责转 Windows
#     形式（adb/scp 都是 Windows 原生 exe，收 MSYS 的相对路径会找不到文件）。
#   * dev_put/dev_get 失败返回非 0；调用方用 `|| die` 兜底。
#
# 不在此文件里 set -e/-u，交调用方决定；与 lib/common.sh 相同。
# 依赖 lib/common.sh 的 info / warn / die。

# ---------- 后端通用配置 ----------
DEV_ADB_BIN="${BPNCM_ADB:-adb}"
DEV_SSH_BIN="${BPNCM_SSH_BIN:-ssh}"
DEV_SCP_BIN="${BPNCM_SCP_BIN:-scp}"
DEV_TRANSPORT=""
DEV_SSH_TARGET=""
DEV_VM_PY=""
DEV_VM_DPCTL=""

# Windows 原生 exe（adb.exe / scp.exe）要 Windows 路径；cygpath 不存在时原样返回。
_dev_winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

# 所有传输命令统一关掉 Git Bash 的路径改写，否则 /userdisk/... 会被改写成
# C:/Program Files/Git/...（工作区规范里 ADB 操作要求 MSYS_NO_PATHCONV=1 的原因）。
_dev_no_pathconv() { MSYS_NO_PATHCONV=1 "$@"; }

# Git Bash 还有一处 MSYS_NO_PATHCONV=1 **挡不住**的改写：以 /tmp/ 开头的参数
# 会被当作 MSYS 自己的 /tmp 映射成本机临时目录（2026-11-08 实测：
#   adb push f /tmp/x  → 报 remote Read-only file system / Temp\... 找不到
#   adb pull /tmp/x    → 报 remote object 'C:\Users\...\Temp\x' does not exist）。
# 前导双斜杠 //tmp/ 能绕过 MSYS 改写，而设备侧仍解析为 /tmp/（同一路径）。
# 只影响 adb 的 push/pull **路径参数**；dev_run 里的命令串由远端 shell 解释，
# 不走 MSYS 改写，不需要动。shot.sh 的截图正是落在 /tmp/shot.png。
_dev_adb_path() {
  case "$1" in
    /tmp/*|/tmp) printf '//%s' "$1" ;;
    *)           printf '%s' "$1" ;;
  esac
}

# SSH 固定选项：BatchMode（禁止密码回退，设备故意关了密码登录）+ 短连接超时，
# 免得脚本在设备掉线时挂住。用户 ~/.ssh/config 里的别名仍生效（-F 未指定）。
_dev_ssh_opts() {
  printf '%s\n' -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new
}

# ---------- 后端：ADB ----------
_dev_adb_resolve() {
  local devs n
  if [ -z "${DEVICE:-}" ]; then
    if [ -n "${BPNCM_DEVICE:-}" ]; then
      DEVICE="$BPNCM_DEVICE"
    else
      devs="$(_dev_no_pathconv "$DEV_ADB_BIN" devices 2>/dev/null | tr -d '\r' \
        | awk 'NR > 1 && $2 == "device" { print $1 }')"
      n="$(printf '%s' "$devs" | grep -c . || true)"
      case "$n" in
        1) DEVICE="$devs" ;;
        0) die "没找到已连接设备（adb devices 没有 device 状态；插好 USB 或确认 adb 可用）
   想走 Wi-Fi：加 --ssh（设备 sshd 已开机自启，无需 USB）" ;;
        *) die "检测到 $n 台设备（$(printf '%s' "$devs" | tr '\n' ' ')），用 --device <序列号> 或 BPNCM_DEVICE 指定" ;;
      esac
    fi
  fi
  DEVICE_LABEL="真机 $DEVICE (adb)"
  _dev_no_pathconv "$DEV_ADB_BIN" -s "$DEVICE" get-state >/dev/null 2>&1 \
    || die "设备无响应：adb -s $DEVICE get-state 失败
   切 OTG host 会断 ADB；这种操作请改用 --ssh（Wi-Fi 不受影响）"
}

_dev_adb_run()    { _dev_no_pathconv "$DEV_ADB_BIN" -s "$DEVICE" shell "$1"; }
_dev_adb_put()    { _dev_no_pathconv "$DEV_ADB_BIN" -s "$DEVICE" push "$(_dev_winpath "$1")" "$(_dev_adb_path "$2")" >/dev/null; }
_dev_adb_get()    { _dev_no_pathconv "$DEV_ADB_BIN" -s "$DEVICE" pull "$(_dev_adb_path "$1")" "$(_dev_winpath "$2")" >/dev/null; }
_dev_adb_check()  { _dev_no_pathconv "$DEV_ADB_BIN" -s "$DEVICE" get-state >/dev/null 2>&1; }

# ---------- 后端：SSH ----------
# 目标是 ~/.ssh/config 里的别名（pen）或 user@host（**单参数**；带 -p 端口等多参数
# 的目标请在 ~/.ssh/config 里配别名）。设备 sshd 只允许公钥，密码登录是故意关的。
_dev_ssh_resolve() {
  if [ -z "$DEV_SSH_TARGET" ]; then
    DEV_SSH_TARGET="${BPNCM_SSH:-pen}"
  fi
  DEVICE="$DEV_SSH_TARGET"
  DEVICE_LABEL="真机 $DEV_SSH_TARGET (ssh)"
  # shellcheck disable=SC2086
  _dev_ssh_call 'echo ok' >/dev/null 2>&1 \
    || die "SSH 连不上：$DEV_SSH_TARGET
   检查 ~/.ssh/config 别名 / 设备 IP / 公钥（/userdata/ssh/authorized_keys）；
   设备开机自启 sshd，正常直接 ssh pen 即可。ADB 可用时也可去掉 --ssh 走 USB"
}

_dev_ssh_call() {
  # shellcheck disable=SC2046,SC2086
  _dev_no_pathconv "$DEV_SSH_BIN" $(_dev_ssh_opts) $DEV_SSH_TARGET "$@"
}

# ssh <host> <command>：OpenSSH 会把命令参数拼成一行交给远端 shell，
# 所以命令串里的引号/管道/重定向由远端 shell 解释，与 adb shell 一致。
_dev_ssh_run()    { _dev_ssh_call "$1"; }
_dev_ssh_check()  { _dev_ssh_call 'echo ok' >/dev/null 2>&1; }

_dev_ssh_put() {
  local src="$1" dst="$2" wsrc
  wsrc="$(_dev_winpath "$src")"
  # OpenSSH 9.x 的 scp 默认走 SFTP 协议；老设备若没配 sftp-server 就回退 -O
  # （legacy scp/rcp 协议，只需远端 scp）。目标以 / 结尾 = 放进该目录，
  # 等价于 adb push <file> <dir>/ —— install.sh 传的是完整文件名，两者都支持。
  if _dev_no_pathconv "$DEV_SCP_BIN" -q $(_dev_ssh_opts) "$wsrc" "$DEV_SSH_TARGET:$dst" 2>/dev/null; then
    return 0
  fi
  _dev_no_pathconv "$DEV_SCP_BIN" -O -q $(_dev_ssh_opts) "$wsrc" "$DEV_SSH_TARGET:$dst"
}

_dev_ssh_get() {
  local src="$1" dst="$2" wdst rc
  wdst="$(_dev_winpath "$dst")"
  if _dev_no_pathconv "$DEV_SCP_BIN" -q $(_dev_ssh_opts) "$DEV_SSH_TARGET:$src" "$wdst" 2>/dev/null; then
    return 0
  fi
  if _dev_no_pathconv "$DEV_SCP_BIN" -O -q $(_dev_ssh_opts) "$DEV_SSH_TARGET:$src" "$wdst" 2>/dev/null; then
    return 0
  fi
  # 最后兜底：设备连 scp 都没有时，用 base64 走 ssh 的 stdout（文本通道也能传二进制）。
  # 只在这里用，因为 base64 会把整张图读进内存（截图约几百 KB，可接受）。
  _dev_ssh_call "base64 $src" > "$dst.b64" 2>/dev/null || { rm -f "$dst.b64"; return 1; }
  if command -v base64 >/dev/null 2>&1; then
    base64 -d "$dst.b64" > "$dst" 2>/dev/null; rc=$?
  else
    # Git Bash 没带 base64：用 python 解（项目里本就依赖 python 跑 logserver/图标脚本）
    python - "$dst.b64" "$dst" <<'PY' 2>/dev/null
import base64, sys
with open(sys.argv[1], 'rb') as f, open(sys.argv[2], 'wb') as o:
    o.write(base64.b64decode(f.read()))
PY
    rc=$?
  fi
  rm -f "$dst.b64"
  [ "$rc" = 0 ] && [ -s "$dst" ]
}

# ---------- 后端：dictpen-vm（dpctl）----------
_dev_vm_resolve() {
  local ws_root cand
  ws_root="$(_workspace_root 2>/dev/null || printf '%s/../..' "$PROJ")"
  cand="$ws_root/refs/dictpen-vm/scripts/dpctl.py"
  [ -f "$cand" ] || die "找不到 $cand（dictpen-vm 没克隆？见 docs/dictpen-vm_使用与开发速查_2026-10-18.md）"
  DEV_VM_DPCTL="$(_dev_winpath "$cand")"
  if [ -n "${BPNCM_VM_PY:-}" ]; then DEV_VM_PY="$BPNCM_VM_PY"
  elif command -v py >/dev/null 2>&1 && py -3.13 -c "" >/dev/null 2>&1; then DEV_VM_PY="py -3.13"
  else DEV_VM_PY="python"; fi
  DEVICE="vm"
  DEVICE_LABEL="dictpen-vm"
}

# dpctl 的 sh 会把远端命令的非 0 退出码换算成 ret=-1 之类的提示，语义不如 adb 干净，
# 因此 VM 分支不做失败回滚与就绪轮询（VM 是试验环境，装坏了重来即可）。
_dev_vm_run()   { $DEV_VM_PY "$DEV_VM_DPCTL" sh -c "$1"; }
_dev_vm_put()   { $DEV_VM_PY "$DEV_VM_DPCTL" put "$(_dev_winpath "$1")" "$2"; }
_dev_vm_get()   { $DEV_VM_PY "$DEV_VM_DPCTL" get "$1" "$(_dev_winpath "$2")"; }
_dev_vm_check() { [ -n "$DEV_VM_DPCTL" ] && [ -f "$DEV_VM_DPCTL" ]; }

# ---------- 选择后端（唯一的入口）----------
# dev_select <adb|ssh|vm> [--device <序列号>] [--ssh <目标>]
# 调用方负责解析自己的命令行参数，把值传进来；环境变量作为缺省覆盖。
dev_select() {
  local mode="${1:-${BPNCM_TRANSPORT:-adb}}"; shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --device) DEVICE="${2:-}"; shift 2 ;;
      --ssh)    DEV_SSH_TARGET="${2:-}"; shift 2 ;;
      *)        die "dev_select: 未知参数 $1" ;;
    esac
  done
  case "$mode" in
    adb) _dev_adb_resolve ;;
    ssh) _dev_ssh_resolve ;;
    vm)  _dev_vm_resolve ;;
    *)   die "未知设备后端：$mode（可选 adb / ssh / vm）" ;;
  esac
  DEV_TRANSPORT="$mode"
  export BPNCM_TRANSPORT="$mode" DEVICE DEVICE_LABEL
}

# ---------- 五个原语：按后端分派 ----------
dev_run() {
  case "$DEV_TRANSPORT" in
    adb) _dev_adb_run "$@" ;;
    ssh) _dev_ssh_run "$@" ;;
    vm)  _dev_vm_run "$@" ;;
    *)   die "还没选设备后端（先调 dev_select）" ;;
  esac
}

dev_put() {
  case "$DEV_TRANSPORT" in
    adb) _dev_adb_put "$@" ;;
    ssh) _dev_ssh_put "$@" ;;
    vm)  _dev_vm_put "$@" ;;
    *)   die "还没选设备后端（先调 dev_select）" ;;
  esac
}

dev_get() {
  case "$DEV_TRANSPORT" in
    adb) _dev_adb_get "$@" ;;
    ssh) _dev_ssh_get "$@" ;;
    vm)  _dev_vm_get "$@" ;;
    *)   die "还没选设备后端（先调 dev_select）" ;;
  esac
}

dev_check() {
  case "$DEV_TRANSPORT" in
    adb) _dev_adb_check ;;
    ssh) _dev_ssh_check ;;
    vm)  _dev_vm_check ;;
    *)   return 1 ;;
  esac
}

# 存在性**只看输出**：这台设备 adbd 不回传远程退出码（见文件头契约），
# `ls -d` 只在存在时打印路径；设备端自己 2>/dev/null 抑制报错
# （写在远端命令串里，PC 侧的 2>/dev/null 管不到 adb shell）。
dev_exists() { [ -n "$(dev_run "ls -d $1 2>/dev/null" | tr -d '\r')" ]; }
