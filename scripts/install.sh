#!/bin/bash
# 装机：构建（可选）→ 推包 → install → start → 等就绪。
#
# 默认**覆盖安装**：同 appid 直接 install，应用的 data（登录态、设置、下载）
# 原样保留。2026-11-12 实测确认：往 data/ 里写标记文件后覆盖安装，标记与
# config.json 的 md5 全不变。所以不需要「备份 data → uninstall → install →
# 恢复 data」那套流程（旧版为此付出 250 行与一套回滚逻辑）。
#
# --fresh 是唯一的例外：先 uninstall 再装，**会清空该应用的 data**，
# 只在要彻底重置（怀疑设置损坏、要回到首次启动状态）时用。
#
# 本脚本不截图：截图是 scripts/shot.sh 的事，装机只负责「装上去并能起来」。
set -e
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lock.sh"

usage() {
  cat <<'EOF'
用法: bash scripts/install.sh [选项]

  --build        构建后再装（默认）
  --no-build     直接装 build/ 里现成的产物
  --fresh        先 uninstall 再装（会清空该应用 data；默认覆盖安装、data 保留）
  --page <name>  启动后直接进某个页面（miniapp_cli start --<name>）
  --wait <秒>    等待应用就绪的上限，默认 40；0 = 不等待
  --device <名>  用工具链 config.toml 里登记的设备
  --via <通路>   只走这条通路（adb / ssh / vm），不退让
  --appid <id>   覆盖 package.json 里的 appid
  --force        清掉残留的装机/构建锁
  -h, --help     显示本帮助

截图不在本脚本里：装机后用 bash scripts/shot.sh
EOF
}

DO_BUILD=1
FRESH=0
PAGE=""
WAIT=40
LOCK_FORCE=0
APPID_OVERRIDE=""
SEL_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --build)     DO_BUILD=1; shift ;;
    --no-build)  DO_BUILD=0; shift ;;
    --fresh)     FRESH=1; shift ;;
    --page)      PAGE="${2:-}"; shift 2 ;;
    --wait)      WAIT="${2:-}"; shift 2 ;;
    --appid)     APPID_OVERRIDE="${2:-}"; shift 2 ;;
    --force)     LOCK_FORCE=1; shift ;;
    # 设备选择交给工具链（--device / --via 的值原样透传）
    --device|--via|--ssh|--vm) SEL_ARGS+=("$1"); shift
                   if [ $# -ge 1 ] && [ -n "${1:-}" ] && [ "${1#-}" = "$1" ]; then
                     SEL_ARGS+=("$1"); shift
                   fi ;;
    -h|--help)   usage; exit 0 ;;
    [0-9]*)      WAIT="$1"; shift ;;   # 兼容旧用法：位置上的数字 = 等待秒数
    *)           printf '未知参数：%s\n' "$1" >&2; usage; exit 1 ;;
  esac
done

case "$WAIT" in ''|*[!0-9]*) die "--wait 需要非负整数（收到 '$WAIT'）" ;; esac
case "$PAGE" in *[!0-9A-Za-z_]*) die "--page 只接受页面名（字母数字下划线）" ;; esac

proj_init
APPID="${APPID_OVERRIDE:-$(appid_of)}"

# 设备连接走工作区工具链（lib/device.sh 是它的适配层）。
# ⚠ 不能写 `[ -n "$X" ] && SEL_ARGS+=(...)`：set -e 下 X 为空会让整条 && 列表
#   返回非 0，脚本静默退出。用 if 保持列表返回 0。
dev_select --project "$PROJ" ${SEL_ARGS[@]+"${SEL_ARGS[@]}"}
# ⚠ 这台设备的 adbd 不回传远程退出码（`adb shell "test -e 不存在的路径"` 本地 rc
#   也是 0，2026-11-01 实测），所以 dev_exists **不能**靠 dev_run 的退出码 ——
#   那会恒为真。dev_exists 只看 `ls -d` 的输出；SSH 后端能回传真实退出码，
#   `|| die` 会真实触发（fail-fast）。关键的写操作之后仍用 dev_exists 事后校验。

lock_acquire install

info "应用: $APPID    目标: $DEVICE_LABEL"

# ---------- 1) 构建 ----------
if [ "$DO_BUILD" = 1 ]; then
  stage "构建"
  BUILD_ARGS=()
  [ "$LOCK_FORCE" = 1 ] && BUILD_ARGS+=(--force)
  BPNCM_LOCK_HELD=1 bash "$SCRIPT_DIR/build.sh" ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
else
  stage "跳过构建（--no-build）"
fi

AMR="$(pick_amr "$APPID")"
[ -n "$AMR" ] || die "build/ 里没有 $APPID 的产物（先跑 bash scripts/build.sh）
  只按时间挑最新的会装错应用：build/ 里可能同时有探针版，所以这里按 appid 过滤"
AMRF="$(basename "$AMR")"
[ "${AMRF%%.*}" = "$APPID" ] || die "产物与 appid 不符：$AMRF（期望前缀 $APPID）"
info "产物: $AMRF（$(du -h "$AMR" | cut -f1)）"

# ---------- 2) 推送 / 安装 ----------
stage "推送 / 安装"
dev_run "mkdir -p /userdisk/Favorite" >/dev/null 2>&1 || true
REMOTE_AMR="/userdisk/Favorite/$AMRF"

# --fresh 会清空该应用的 data（登录态/设置/下载全丢），所以是显式选项。
if [ "$FRESH" = 1 ]; then
  warn "卸载旧版本（--fresh：会清空该应用的 data）"
  dev_run "miniapp_cli uninstall $APPID" >/dev/null 2>&1 || true
fi

dev_put "$AMR" "$REMOTE_AMR" || die "推送失败（设备空间不足或设备掉线）"

# 确认装上去的就是这次构建的字节
LOCAL_MD5="$(md5sum "$AMR" | cut -d' ' -f1)"
REMOTE_MD5="$(dev_run "md5sum $REMOTE_AMR 2>/dev/null | cut -d' ' -f1" 2>/dev/null | tr -d '\r')"
[ "$LOCAL_MD5" = "$REMOTE_MD5" ] \
  || die "推送后 md5 不一致（本地 $LOCAL_MD5 / 远端 ${REMOTE_MD5:-空}）"
info "  md5 一致：$LOCAL_MD5"

dev_run "miniapp_cli install $REMOTE_AMR" || die "miniapp_cli install 返回非 0"

# ---------- 3) 启动 + 就绪 ----------
# ⚠ 顶层 `[ -n "$X" ] && ...` 不能用：MSYS bash 5.3.20（DSH agent 执行环境）存在
#   errexit 偏差——脚本 source 链里有 `.` 命令时，顶层 && 列表首命令失败（X 为空）
#   即整脚本静默退出 rc=1；Git Bash 5.3.15 正常。全脚本统一 if 写法。
stage "启动"
START_ARGS=""
if [ -n "$PAGE" ]; then START_ARGS="--$PAGE"; fi
START_OUT="$(dev_run "miniapp_cli start $APPID $START_ARGS" 2>&1 | tr -d '\r')" || true
if [ -n "$START_OUT" ]; then info "  $START_OUT"; fi

if [ "$WAIT" -gt 0 ]; then
  stage "等待应用就绪（memoryApp 里出现 App($APPID)，上限 ${WAIT}s）"
  t=0
  READY=0
  while [ "$t" -lt "$WAIT" ]; do
    if dev_run "miniapp_cli memoryApp 2>/dev/null" 2>/dev/null | tr -d '\r' | grep -qF "App($APPID)"; then
      READY=1
      break
    fi
    sleep 2
    t=$(( t + 2 ))
  done
  [ "$READY" = 1 ] || die "已经装上，但 ${WAIT}s 内没起来（加大 --wait，或看 miniapp_cli start 的输出）"
  info "  就绪（约 ${t}s）"
else
  info "  未等待（--wait 0）；截图用：bash scripts/shot.sh"
fi

stage_done
