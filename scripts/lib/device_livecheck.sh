#!/bin/bash
# 设备连通性体检：真机 ADB / 真机 SSH / 虚拟机 dpctl，只读、不改设备。
#
# 什么时候用：切了连接方式（尤其 SSH）、换了网络、装机失败先排查链路。
# 自检脚本 device_selftest.sh 用 mock 验参数；本脚本对**真设备**验通道。
#
#   bash scripts/lib/device_livecheck.sh              # 默认 adb
#   bash scripts/lib/device_livecheck.sh --ssh pen    # 走 Wi-Fi SSH
#   bash scripts/lib/device_livecheck.sh --device <序列号>
#   BPNCM_TRANSPORT=ssh bash scripts/lib/device_livecheck.sh
#
# 退出码 0 = 五个原语都通；非 0 = 有环节失败（输哪一步挂了）。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
proj_init

MODE=""
SSH_TARGET=""
DEV_SERIAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh)          MODE=ssh; shift
                    if [ $# -gt 0 ] && [ -n "$1" ] && [ "${1#-}" = "$1" ]; then SSH_TARGET="$1"; shift; fi ;;
    --ssh=*)        MODE=ssh; SSH_TARGET="${1#--ssh=}"; shift ;;
    --adb)          MODE=adb; shift ;;
    --vm)           MODE=vm; shift ;;
    --device)       DEV_SERIAL="${2:-}"; shift 2 ;;
    -h|--help)      sed -n '2,14p' "$0"; exit 0 ;;
    *)              die "未知参数：$1" ;;
  esac
done
MODE="${MODE:-${BPNCM_TRANSPORT:-adb}}"

SEL_ARGS=()
[ -n "$DEV_SERIAL" ] && SEL_ARGS+=(--device "$DEV_SERIAL")
[ "$MODE" = ssh ] && [ -n "$SSH_TARGET" ] && SEL_ARGS+=(--ssh "$SSH_TARGET")
dev_select "$MODE" ${SEL_ARGS[@]+"${SEL_ARGS[@]}"}

info "目标: $DEVICE_LABEL"
PASS=0; FAIL=0
step() { if [ "$2" = 0 ]; then info "  ✓ $1"; PASS=$((PASS+1)); else warn "  ✗ $1"; FAIL=$((FAIL+1)); fi; }

# 1) dev_check
dev_check; step "连通性校验 (dev_check)" $?

# 2) dev_run：命令串能完整送达
OUT="$(dev_run 'echo DEV_RUN_OK' 2>/dev/null | tr -d '\r')"
[ "$(printf '%s' "$OUT" | grep -c DEV_RUN_OK)" = 1 ]; step "dev_run 命令执行" $?

# 3) dev_exists：存在性判断（用一定存在的 / 与一定不存在的路径做正反验）
dev_exists /; step "dev_exists 命中 /" $?
dev_exists /userdisk/__bpncm_livecheck_absent__ && RC=1 || RC=0
[ "$RC" = 0 ]; step "dev_exists 正确判空" $?

# 4) dev_put / dev_get 二进制往返（写 /tmp，tmpfs 重启自清）
TMP_IN="$(mktemp)"; TMP_OUT="$(mktemp)"
printf 'livecheck\000\001\377\r\n' > "$TMP_IN"
REMOTE="/tmp/.bpncm_livecheck.bin"
if dev_put "$TMP_IN" "$REMOTE" 2>/dev/null; then
  dev_get "$REMOTE" "$TMP_OUT" 2>/dev/null
  if cmp -s "$TMP_IN" "$TMP_OUT"; then step "dev_put/dev_get 二进制往返" 0; else step "dev_put/dev_get 二进制往返（字节不一致）" 1; fi
else
  step "dev_put/dev_get 二进制往返（推文件失败）" 1
fi
dev_run "rm -f $REMOTE" >/dev/null 2>&1 || true
rm -f "$TMP_IN" "$TMP_OUT"

# 5) 关键设备能力（装机/截图依赖）
CAP="$(dev_run 'command -v miniapp_cli; command -v md5sum' 2>/dev/null | tr -d '\r')"
[ "$(printf '%s' "$CAP" | grep -c miniapp_cli)" = 1 ]; step "设备有 miniapp_cli" $?

info ""
info "结果: PASS=$PASS FAIL=$FAIL（目标 $DEVICE_LABEL）"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
