#!/bin/bash
# 截图（真机 / --vm）：点亮屏幕 → miniapp_cli capture → 拉回 → 空白帧检测
#
# 为什么单独一个脚本：装机（install.sh）只负责"装上去并能起来"，
# 而截图是看一眼效果的动作，调试时经常要反复截而不要重装。
#
# 空白帧检测：设备 180 秒自动熄屏，熄屏后 capture 返回的是黑帧，
# 旧版直接 pull 回来当成功（文件存在、非空）。这里用像素极差判断，空白就明确报出来。
#
# 用法：
#   bash scripts/shot.sh                     # → shots/shot.png
#   bash scripts/shot.sh --wait 5            # 先等 5 秒（等渲染）
#   bash scripts/shot.sh --ready             # 先等应用起来（memoryApp 出现 App(appid)）
#   bash scripts/shot.sh --out shots/foo.png
#   bash scripts/shot.sh --ssh pen            # 走 Wi-Fi SSH（无需 USB）
#   bash scripts/shot.sh --vm                # 截 dictpen-vm（dpctl screenshot）
set -e
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
用法: bash scripts/shot.sh [选项]

  --out <路径>       输出文件，默认 shots/shot.png
  --wait <秒>        截图前等几秒（默认 0；渲染没出来就加）
  --ready            先等应用就绪（memoryApp 里出现 App(appid)），最多 40 秒
  --device <序列号>  多台设备时指定（也可用 BPNCM_DEVICE）
  --ssh [目标]       走 Wi-Fi SSH（默认别名 pen；也可 BPNCM_TRANSPORT=ssh）
  --vm               截 dictpen-vm（走 dpctl，不做空白帧检测）
  -h, --help         显示本帮助
EOF
}

OUT="shots/shot.png"
WAIT=0
VM=0
READY=0
TRANSPORT=""
SSH_TARGET=""
DEVICE="${BPNCM_DEVICE:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out)     OUT="${2:-}"; shift 2 ;;
    --wait)    WAIT="${2:-}"; shift 2 ;;
    --ready)   READY=1; shift ;;
    --device)  DEVICE="${2:-}"; shift 2 ;;
    --ssh)     TRANSPORT=ssh
               if [ $# -gt 1 ] && [ -n "${2:-}" ] && [ "${2#-}" = "$2" ]; then SSH_TARGET="$2"; shift; fi
               shift ;;
    --vm)      VM=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         printf '未知参数：%s\n' "$1" >&2; usage; exit 1 ;;
  esac
done

case "$WAIT" in ''|*[!0-9]*) die "--wait 需要非负整数（收到 '$WAIT'）" ;; esac

proj_init
case "$OUT" in /*) ;; *) OUT="$PROJ/$OUT" ;; esac
mkdir -p "$(dirname "$OUT")"

# 返回 0 = 有内容，10 = 空白帧，11 = 判断不了（没装 Pillow）
is_blank() {
  python - "$1" <<'PY' 2>/dev/null || return $?
import sys
try:
    from PIL import Image
except ImportError:
    sys.exit(11)
im = Image.open(sys.argv[1]).convert("L")
lo, hi = im.getextrema()
sys.exit(10 if hi - lo < 8 else 0)
PY
}

# ---------- 后端选择：vm / adb / ssh（传输层统一分派） ----------
# ⚠ 不能写 `[ -n "$X" ] && SEL_ARGS+=(...)`：set -e 下 X 为空会让整条 && 列表
#   返回非 0，脚本静默退出（实测踩过）。用 if 保持列表返回 0。
SEL_ARGS=()
if [ -n "$DEVICE" ]; then SEL_ARGS+=(--device "$DEVICE"); fi
if [ -n "$SSH_TARGET" ]; then SEL_ARGS+=(--ssh "$SSH_TARGET"); fi
if [ "$VM" = 1 ]; then
  [ -n "${DICTPEN_VM_PY:-}" ] && [ -z "${DPD_VM_PY:-}" ] && export DPD_VM_PY="$DICTPEN_VM_PY"
  dev_select --transport vm --project "$PROJ"
  # dpctl screenshot 不是五个传输原语之一（截图留在本脚本是刻意偏差，不属于通用传输能力）
  stage "截取虚拟机画面"
  $DPD_VM_PY "$DPD_VM_DPCTL" screenshot --out "$(cygpath -w "$OUT")"
  info "  截图: $OUT"
  stage_done
  exit 0
fi
# 不指定 --ssh/--device 时按项目配置选设备（工作区 targets.env 或本项目
# .dictpen-dev.env），不再把 adb 写死成默认值。
_SHOT_ARGS=()
if [ -n "$TRANSPORT" ]; then _SHOT_ARGS+=(--transport "$TRANSPORT"); fi
dev_select --project "$PROJ" ${_SHOT_ARGS[@]+"${_SHOT_ARGS[@]}"} ${SEL_ARGS[@]+"${SEL_ARGS[@]}"}

dev_run 'echo 200 > /sys/class/backlight/backlight/brightness' >/dev/null 2>&1 || true

if [ "$READY" = 1 ]; then
  stage "等待应用就绪"
  APPID="$(appid_of)"
  t=0
  while [ "$t" -lt 40 ]; do
    if dev_run "miniapp_cli memoryApp 2>/dev/null" 2>/dev/null | tr -d '\r' | grep -qF "App($APPID)"; then
      info "  就绪（约 ${t}s）"
      break
    fi
    sleep 2
    t=$(( t + 2 ))
  done
  [ "$t" -lt 40 ] || warn "40s 内没等到 App($APPID)，照常截图（可能是首页/别的应用在前台）"
fi

if [ "$WAIT" -gt 0 ]; then
  info "等 ${WAIT}s 再截..."
  sleep "$WAIT"
fi

stage "截图（miniapp_cli capture）"
# 设备端临时文件写 /tmp（tmpfs，重启自清），不落在 /userdisk
dev_run "miniapp_cli capture /tmp/shot.png" >/dev/null 2>&1 || die "capture 失败（设备掉线？）"
dev_get /tmp/shot.png "$OUT" || die "拉回截图失败"
[ -s "$OUT" ] || die "截图文件为空：$OUT"

RC=0
is_blank "$OUT" || RC=$?
case "$RC" in
  0)  info "  截图: $OUT（$(du -h "$OUT" | cut -f1)）" ;;
  10) warn "截图是空白帧（几乎全同色）：设备多半已熄屏或处于待机"
      warn "  按一下设备键点亮，或重跑前手动亮屏；文件仍保留在 $OUT" ;;
  11) info "  截图: $OUT（未装 Pillow，跳过空白帧检测）" ;;
  *)  info "  截图: $OUT（空白帧检测不可用，跳过）" ;;
esac

stage_done
