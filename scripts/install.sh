#!/bin/bash
# 装机（真机 / --vm）：构建（可选）→ 备份数据 → 卸载 → 推送 → 安装 → 恢复数据 → 启动 → 就绪校验
#
# 三条相对旧版的设计决定：
#   1) 数据备份是**整目录 mv**。$DATA 与暂存目录同属 /userdisk（单块 ext4），mv 只是
#      rename，2.3G 也是瞬时。旧版按 cookie.txt / storage / music / covers / store / lrc
#      逐项挑，漏一个就丢一样 —— 实际就漏了 ncm_ck.txt（paths.js 的 Cookie 落盘），
#      后果是装机后要重新登录。整目录搬不存在"漏项"这个失败模式。
#   2) 装前先认领上次失败留下的暂存数据，有就先归位再继续。旧版开头无条件
#      rm -rf 暂存目录：如果上次死在"卸载后、恢复前"，删掉的就是唯一副本。
#   3) 中途失败自动回滚（注册到锁的退出钩子，见 lock.sh），不再是"打印一句请手动 mv"。
#
# 本脚本**不截图**：截图是 scripts/shot.sh 的事，装机只负责"装上去并能起来"。
set -e
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lock.sh"

usage() {
  cat <<'EOF'
用法: bash scripts/install.sh [选项]

  --build            构建后再装（默认）
  --no-build         直接装 build/ 里现成的产物
  --backup           装机前备份应用数据、装完恢复（默认，整目录 rename）
  --no-backup        不备份不恢复（会丢登录态与下载；--vm 天然不备份）
  --page <name>      启动后直接进某个页面（miniapp_cli start --<name>）
  --wait <秒>        等待应用就绪的上限，默认 40；0 = 不等待
  --device <序列号>  多台设备时指定（也可用 BPNCM_DEVICE 环境变量）
  --appid <id>       覆盖 package.json 里的 appid（默认读 package.json）
  --vm               装进 dictpen-vm（走 dpctl，不备份数据）
  --force            清掉残留的装机/构建锁
  -h, --help         显示本帮助

截图不在本脚本里：装机后用 bash scripts/shot.sh
EOF
}

DO_BUILD=1
DO_BACKUP=1
VM=0
PAGE=""
WAIT=40
LOCK_FORCE=0
DEVICE="${BPNCM_DEVICE:-}"
APPID_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --build)     DO_BUILD=1; shift ;;
    --no-build)  DO_BUILD=0; shift ;;
    --backup)    DO_BACKUP=1; shift ;;
    --no-backup) DO_BACKUP=0; shift ;;
    --vm)        VM=1; shift ;;
    --page)      PAGE="${2:-}"; shift 2 ;;
    --device)    DEVICE="${2:-}"; shift 2 ;;
    --wait)      WAIT="${2:-}"; shift 2 ;;
    --appid)     APPID_OVERRIDE="${2:-}"; shift 2 ;;
    --force)     LOCK_FORCE=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    [0-9]*)      WAIT="$1"; shift ;;   # 兼容旧用法：位置上的数字 = 等待秒数
    *)           printf '未知参数：%s\n' "$1" >&2; usage; exit 1 ;;
  esac
done

case "$WAIT" in ''|*[!0-9]*) die "--wait 需要非负整数（收到 '$WAIT'）" ;; esac
case "$PAGE" in *[!0-9A-Za-z_]*) die "--page 只接受页面名（字母数字下划线）" ;; esac

proj_init
APPID="${APPID_OVERRIDE:-$(appid_of)}"

# ---------- 目标执行器：真机 adb / 虚拟机 dpctl ----------
# 两者只在"怎么执行一条远端命令、怎么传文件"上不同，主流程共用。
if [ "$VM" = 1 ]; then
  WS_ROOT="$(_workspace_root 2>/dev/null || printf '%s/../..' "$PROJ")"
  DPCTL="$WS_ROOT/refs/dictpen-vm/scripts/dpctl.py"
  [ -f "$DPCTL" ] || die "找不到 $DPCTL（dictpen-vm 没克隆？见 docs/dictpen-vm_使用与开发速查_2026-10-18.md）"
  DPCTL="$(cygpath -w "$DPCTL")"
  # dpctl 要 Python 3.11+（tomllib）：环境变量 > py -3.13 > python
  if [ -n "${DICTPEN_VM_PY:-}" ]; then PY="$DICTPEN_VM_PY"
  elif command -v py >/dev/null 2>&1 && py -3.13 -c "" >/dev/null 2>&1; then PY="py -3.13"
  else PY="python"; fi
  DEVICE="vm"
  # dpctl 的 sh 会把远端命令的非 0 退出码换算成 ret=-1 之类的提示，语义不如 adb 干净，
  # 所以 VM 分支不做失败回滚与就绪轮询（VM 是试验环境，装坏了重来即可）。
  dev_run() { $PY "$DPCTL" sh -c "$1"; }
  dev_put() { $PY "$DPCTL" put "$(cygpath -w "$1")" "$2"; }
else
  resolve_device
  dev_run() { $ADB shell "$1"; }
  dev_put() { $ADB push "$(cygpath -w "$1")" "$2" >/dev/null; }
fi
dev_exists() { dev_run "test -e $1" >/dev/null 2>&1; }

PKG="/userdisk/secondary/miniapp/data/mini_app/pkg/$APPID"
DATA="$PKG/data"
# 暂存与 data 同属 /userdisk（单块 ext4）→ mv 是 rename。按 appid 分目录，
# 探针版与正式版同时装卸不会串。放在 <appid>/ 之外：uninstall 会删掉整个 <appid>。
BAK_DATA="/userdisk/.bpncm_bak/$APPID/data"
BAK_ACTIVE=0

# 暂存目录的两层空壳（<bak>/<appid> 与 <bak>）都收掉，否则设备上会一直留着空目录。
# 只在目录为空时 rmdir 才成功，不会误删东西。
bak_cleanup() {
  dev_run "rmdir $(dirname "$BAK_DATA") 2>/dev/null; rmdir $(dirname "$(dirname "$BAK_DATA")") 2>/dev/null" \
    >/dev/null 2>&1 || true
}

# 装机失败时把数据搬回去（由锁的退出钩子统一调度；这里**不要 exit**，退出码由 lock.sh 透传）
rollback_data() {
  if [ "${BAK_ACTIVE:-0}" = "1" ]; then
    printf '\n⚠ 装机中断，回滚应用数据：%s → %s\n' "$BAK_DATA" "$DATA" >&2
    if dev_run "mkdir -p $PKG; rm -rf $DATA; mv $BAK_DATA $DATA" >/dev/null 2>&1; then
      printf '  已回滚，数据回到原位（未丢失）\n' >&2
      BAK_ACTIVE=0
      bak_cleanup
    else
      printf '  ✗ 回滚失败：数据完整保存在设备的 %s，手动 mv 回 %s\n' "$BAK_DATA" "$DATA" >&2
    fi
  fi
}

lock_add_exit_hook rollback_data
lock_acquire install

info "应用: $APPID    目标: $([ "$VM" = 1 ] && echo 'dictpen-vm' || echo "真机 $DEVICE")"

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

# ---------- 2) 认领上次失败的残留备份（真机） ----------
if [ "$VM" = 0 ]; then
  stage "检查上次装机残留"
  if dev_exists "$BAK_DATA"; then
    warn "发现上次装机留下的数据备份：$BAK_DATA"
    if dev_exists "$DATA"; then
      warn "  当前 data 也在（$DATA）—— 两边都有数据，脚本不替你选："
      warn "    保留现有 data：adb shell rm -rf $(dirname "$BAK_DATA")"
      warn "    改用备份数据：adb shell rm -rf $DATA && adb shell mkdir -p $PKG && adb shell mv $BAK_DATA $DATA"
      die "请先处理上面的冲突再重跑"
    fi
    dev_run "mkdir -p $PKG && mv $BAK_DATA $DATA" || die "残留备份归位失败：$BAK_DATA 仍在设备上"
    info "  已把上次的备份归位到 data（登录态与下载都保住了）"
  else
    info "  无残留"
  fi
fi

# ---------- 3) 备份（真机，整目录 rename） ----------
if [ "$VM" = 0 ] && [ "$DO_BACKUP" = 1 ]; then
  stage "备份应用数据（整目录 rename，不拷贝）"
  if dev_exists "$DATA"; then
    if dev_exists "$BAK_DATA"; then die "暂存目录意外存在，拒绝覆盖：$BAK_DATA"; fi
    SZ="$(dev_run "du -sh $DATA 2>/dev/null | cut -f1" 2>/dev/null | tr -d '\r')"
    dev_run "mkdir -p $(dirname "$BAK_DATA") && mv $DATA $BAK_DATA" \
      || die "备份失败（数据仍在 $DATA，未动）"
    BAK_ACTIVE=1
    info "  $DATA → $BAK_DATA（${SZ:-大小未知}）"
  else
    info "  设备上还没有 data 目录，跳过"
  fi
elif [ "$VM" = 0 ]; then
  stage "跳过备份（--no-backup）"
fi

# ---------- 4) 卸载 / 推送 / 安装 ----------
stage "卸载 / 推送 / 安装"
dev_run "mkdir -p /userdisk/Favorite" >/dev/null 2>&1 || true
REMOTE_AMR="/userdisk/Favorite/$AMRF"
dev_run "miniapp_cli uninstall $APPID" >/dev/null 2>&1 || true

dev_put "$AMR" "$REMOTE_AMR" || die "推送失败（设备空间不足或设备掉线）"

# 确认装上去的就是这次构建的字节（VM 是同机文件系统，不需要）
if [ "$VM" = 0 ]; then
  LOCAL_MD5="$(md5sum "$AMR" | cut -d' ' -f1)"
  REMOTE_MD5="$(dev_run "md5sum $REMOTE_AMR 2>/dev/null | cut -d' ' -f1" 2>/dev/null | tr -d '\r')"
  [ "$LOCAL_MD5" = "$REMOTE_MD5" ] \
    || die "推送后 md5 不一致（本地 $LOCAL_MD5 / 远端 ${REMOTE_MD5:-空}）"
  info "  md5 一致：$LOCAL_MD5"
fi

dev_run "miniapp_cli install $REMOTE_AMR" || die "miniapp_cli install 返回非 0"

# ---------- 5) 恢复数据（必须在首次启动之前） ----------
if [ "$BAK_ACTIVE" = 1 ]; then
  stage "恢复应用数据"
  # install 可能建了空的 data（部分版本会），先清掉再 mv，否则会变成 data/data
  dev_run "mkdir -p $PKG; rm -rf $DATA; mv $BAK_DATA $DATA" \
    || die "恢复失败：数据完整保存在 $BAK_DATA"
  BAK_ACTIVE=0
  bak_cleanup
  info "  数据已回到 $DATA"
fi

# ---------- 6) 启动 + 就绪 ----------
stage "启动"
START_ARGS=""
[ -n "$PAGE" ] && START_ARGS="--$PAGE"
START_OUT="$(dev_run "miniapp_cli start $APPID $START_ARGS" 2>&1 | tr -d '\r')" || true
[ -n "$START_OUT" ] && info "  $START_OUT"

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
