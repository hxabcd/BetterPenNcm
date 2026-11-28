#!/bin/bash
# 导航层真机自测：验证 src/core/infra/nav.js 的「逻辑页 → 实例槽位」是否得到标准 push/pop 语义。
# 覆盖五阶段（步骤在 src/pages/probe/navtest.js 的 runNavSelfTest）：基础 push/pop；平台回退弹层后的
# 槽位释放；深度压力 15 层；连点合并（dup-ignore）；槽位耗尽 degrade（复用最上层同类实例）。
#
# 断言依据（tag=nav 的行由导航层打，tag=navtest 的行由探针页打）：
#   [nav] go <logical> -> <slot> (push) / (reuse) / (dup-ignore: Nms 内连点) / (degrade: 槽位耗尽 → …)
#   [nav] page-load|page-unload <slotKey> live=<n> [<stackKeys>]
#   [navtest] <步骤> begin/ok/FAIL ...、<阶段> stack=[...]
#
# 退出码：0 = 全部 PASS（push/pop 语义 + 四类边界成立）；1 = 有 FAIL 或构建/装机/采集失败。
# 前提：设备已连接；构建/装机锁空闲（build.sh/install.sh 互斥）；PC 8888 未被占用。
set -u
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"
proj_init

# 参数解析（设备连接：--ssh [目标] / --device <序列号>；环境变量仍生效）
SEL_TRANSPORT=""
SEL_SSH_TARGET=""
SEL_DEVICE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh)    SEL_TRANSPORT=ssh
              if [ $# -gt 1 ] && [ -n "${2:-}" ] && [ "${2#-}" = "$2" ]; then SEL_SSH_TARGET="$2"; shift; fi
              shift ;;
    --device) SEL_DEVICE="${2:-}"; shift 2 ;;
    *)        die "未知参数：$1（支持 --ssh [目标] / --device <序列号>）" ;;
  esac
done

PROBE_APPID="${PROBE_APPID:-8002026100500004}"
# build_probe.sh 也读这个变量，保持构建/装机一致
export PROBE_APPID
LOG_FILE="$PROJ/device_log.txt"
SHOT="$PROJ/shots/nav_selftest.png"
MEM_FILE="$PROJ/shots/nav_selftest_memory.txt"
# 等自测全部跑完的上限（秒；自测总时长约 40s）
DONE_WAIT="${NAVTEST_DONE_WAIT:-90}"

# 工具链解析走公共库（worktree 里用 git common-dir 反查主检出，不硬编码兜底路径）
resolve_tools

LOGSRV_PID=""
LOGSRV_OUT=""
cleanup() {
  if [ -n "$LOGSRV_PID" ] && kill -0 "$LOGSRV_PID" 2>/dev/null; then
    kill "$LOGSRV_PID" 2>/dev/null || true
    wait "$LOGSRV_PID" 2>/dev/null || true
  fi
  [ -n "$LOGSRV_OUT" ] && rm -f "$LOGSRV_OUT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 设备连接由传输层解析（lib/device.sh）：默认 ADB 自动选唯一设备，--ssh / BPNCM_TRANSPORT=ssh 走 Wi-Fi；
# dev_select 自带连通校验
SEL_ARGS=()
[ -n "$SEL_DEVICE" ] && SEL_ARGS+=(--target "$SEL_DEVICE")
[ -n "$SEL_SSH_TARGET" ] && SEL_ARGS+=(--target "$SEL_SSH_TARGET")
_NS_ARGS=()
if [ -n "$SEL_TRANSPORT" ]; then _NS_ARGS+=(--transport "$SEL_TRANSPORT"); fi
dev_select --project "$PROJ" ${_NS_ARGS[@]+"${_NS_ARGS[@]}"} ${SEL_ARGS[@]+"${SEL_ARGS[@]}"}

. "$SCRIPT_DIR/lib/nav_assert.sh"

echo "=== 导航层真机自测（基础 + 回退弹层 + 深度压力 + 连点合并 + degrade） ==="
echo "设备: $DEVICE  探针 appid: $PROBE_APPID  工具链: $TOOLS"

[ -f "$NODE" ] || die "找不到工具链 Node: $NODE（用 BPNCM_TOOLS=<工作区>/tools 指定）"
command -v python >/dev/null 2>&1 || die "找不到 python（scripts/logserver.py 依赖）"
command -v curl >/dev/null 2>&1 || die "找不到 curl（用于探测 logserver）"

# PC 局域网 IPv4（优先 192.168/10./172.16-31；设备要能访问这个地址）
PC_IP="$(ipconfig 2>/dev/null | tr -d '\r' | awk '/IPv4/ {print $NF}' \
  | grep -E '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))\.' | head -1)"
if [ -z "$PC_IP" ]; then
  PC_IP="$(powershell.exe -NoProfile -Command \
    "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.IPAddress -notlike '127.*' -and \$_.IPAddress -notlike '169.254.*' } | Sort-Object InterfaceMetric | Select-Object -First 1 -ExpandProperty IPAddress)" \
    2>/dev/null | tr -d '\r')"
fi
[ -n "$PC_IP" ] || die "找不到本机局域网 IPv4（设备需访问 PC 的 8888 端口）"
echo "PC 局域网 IP: $PC_IP（logserver 注入地址 http://$PC_IP:8888/log）"

# 8888 已有 logserver 在跑时不能直接再起一个：它会把日志写到别的目录（不同 worktree 的 device_log.txt）
if curl -s --max-time 2 http://127.0.0.1:8888/ 2>/dev/null | grep -q alive; then
  die "127.0.0.1:8888 已有 logserver 在跑（可能是上次残留/别的会话）；先停掉再运行（否则日志不落本仓库）"
fi

echo ""
echo "--- [1/5] 构建探针版（BPNCM_LOG_SRV=http://$PC_IP:8888/log） ---"
STAMP="$(mktemp)"
BPNCM_LOG_SRV="http://$PC_IP:8888/log" bash scripts/build_probe.sh \
  || die "探针构建失败（构建锁冲突时先确认无人构建，或用 --force 清锁；锁信息见输出）"

AMR="$(find build -maxdepth 1 -name "$PROBE_APPID.*.amr" -newer "$STAMP" 2>/dev/null | head -1)"
[ -n "$AMR" ] || AMR="$(ls -t build/*.amr 2>/dev/null | head -1)"
rm -f "$STAMP"
[ -n "$AMR" ] || die "构建后 build/ 里没有产物"
AMRF="$(basename "$AMR")"
# 产物文件名 = <appid>.<x_y_z>.amr
APPID="${AMRF%%.*}"
[ "$APPID" = "$PROBE_APPID" ] || die "最新产物 appid=$APPID 不是探针 appid=$PROBE_APPID（可能有人同时在构建正式版）"
echo "产物: $AMRF"

echo ""
echo "--- [2/5] 启动 logserver（device_log.txt） ---"
start_logserver() {
  # 清旧日志；logserver 以追加方式写
  : > "$LOG_FILE"
  LOGSRV_OUT="$(mktemp)"
  python scripts/logserver.py > "$LOGSRV_OUT" 2>&1 &
  LOGSRV_PID=$!
  local j=0
  # 最多等 10s：Windows 上 python 启动偶尔偏慢
  while [ "$j" -lt 20 ]; do
    if curl -s --max-time 1 http://127.0.0.1:8888/ 2>/dev/null | grep -q alive; then
      return 0
    fi
    kill -0 "$LOGSRV_PID" 2>/dev/null || break
    sleep 0.5
    j=$((j + 1))
  done
  echo "--- logserver 输出 ---"
  cat "$LOGSRV_OUT" 2>/dev/null || true
  kill "$LOGSRV_PID" 2>/dev/null || true
  wait "$LOGSRV_PID" 2>/dev/null || true
  LOGSRV_PID=""
  rm -f "$LOGSRV_OUT" 2>/dev/null || true
  LOGSRV_OUT=""
  return 1
}
if ! start_logserver; then
  echo "⚠ logserver 第一次启动未就绪，2 秒后重试一次"
  sleep 2
  start_logserver || die "logserver 启动失败（8888 被占用？先确认没有残留 logserver）"
fi
echo "logserver pid=$LOGSRV_PID → $LOG_FILE"

echo ""
echo "--- [3/5] 装机并启动探针（先卸载旧实例保证可重复运行） ---"
dev_run "miniapp_cli uninstall $PROBE_APPID" >/dev/null 2>&1 || true
dev_run "echo 200 > /sys/class/backlight/backlight/brightness" >/dev/null 2>&1 || true
dev_put "$PROJ/$AMR" /userdisk/Favorite/ || die "推送探针 .amr 失败"
dev_run "miniapp_cli install /userdisk/Favorite/$AMRF" || die "miniapp_cli install 失败"
dev_run "hal-screen on" >/dev/null 2>&1 || true
dev_run "miniapp_cli start $PROBE_APPID" || die "miniapp_cli start 失败"

echo ""
echo "--- [4/5] 等待自测日志（最多 ${DONE_WAIT}s） ---"
mkdir -p shots
MEM_DONE=0

capture() {
  dev_run "hal-screen on" >/dev/null 2>&1 || true
  dev_run "miniapp_cli capture /userdisk/nav_selftest.png" >/dev/null 2>&1 || true
  rm -f "$SHOT"
  dev_get /userdisk/nav_selftest.png "$SHOT" >/dev/null 2>&1 || true
  [ -f "$SHOT" ] && [ "$(stat -c %s "$SHOT" 2>/dev/null || echo 0)" -ge 2000 ]
}

# 12 层稳定窗口里采一次内存（设备端输出含所有运行中小程序的组件树：只落盘摘要+原始，终端只打摘要）
mem_app() {
  local raw pages probe_pages
  raw="$(mktemp)"
  # ⚠ 不能用外部 timeout 包 dev_run：timeout 是外部 exe，执行不了 shell 函数，内存采样会静默失败（被 || true 吞掉）。
  #   dev_run 走 SSH 后端自带 ConnectTimeout=8，连接挂死有兜底；命令执行超时由设备端 miniapp_cli 自行保证。
  dev_run "miniapp_cli memoryApp" > "$raw" 2>&1 || true
  probe_pages=$(awk -v app="App($PROBE_APPID)" '
    /^App\(/ { inp = ($1 == app) ? 1 : 0 }
    inp && /^\tPage\(/ { n++ }
    END { print n + 0 }' "$raw")
  {
    echo "# miniapp_cli memoryApp @ 导航栈 12 层（采样 $(date '+%Y-%m-%d %H:%M:%S')，device $DEVICE）"
    echo "# 探针 App($PROBE_APPID) 采样时页面数 = $probe_pages（期望 12；PC 采样有少量延迟，可能略多）"
    echo "# 摘要（Mallinfo / App / Page）；完整原始输出见本文件末尾"
    grep -E 'Mallinfo|^App\(|Page\(' "$raw" 2>/dev/null || true
    echo ""
    echo "# ---- 原始输出 ----"
    cat "$raw"
  } > "$MEM_FILE"
  rm -f "$raw"
  echo "内存采样（12 层）: shots/nav_selftest_memory.txt，摘要："
  grep -E 'Mallinfo|^App\(' "$MEM_FILE" 2>/dev/null | grep -v '^#' | sed 's/^/    /' | head -12
  pages=$(grep -c 'Page(' "$MEM_FILE" 2>/dev/null || true)
  echo "    探针 App($PROBE_APPID) 采样时页面数 = $probe_pages（期望 12）；输出 Page 行数合计 = ${pages:-0}"
}

DONE_AT=""
i=0
while [ "$i" -lt $((DONE_WAIT * 2)) ]; do
  if [ "$MEM_DONE" = "0" ] && grep -qF '[navtest] deep12 stack=' "$LOG_FILE" 2>/dev/null; then
    MEM_DONE=1
    # 先截图再采内存：两者都在 12 层稳定窗口（probe 停 7 秒）内完成
    if ! capture; then
      echo "⚠ 12 层截图偏小/空白（熄屏或切换瞬间），1 秒后重试"
      sleep 1
      capture || echo "⚠ 12 层截图仍不理想，保留现有文件"
    fi
    mem_app
  fi
  if grep -qF '[navtest] task4-done stack=' "$LOG_FILE" 2>/dev/null; then
    DONE_AT="$i"
    break
  fi
  sleep 0.5
  i=$((i + 1))
done
if [ -n "$DONE_AT" ]; then
  echo "已收到 [navtest] task4-done（启动后约 $((DONE_AT / 2))s）"
else
  echo "⚠ ${DONE_WAIT}s 内没等到 [navtest] task4-done（日志注入失败 / 应用中断 / 自测未跑完），继续截图与断言"
fi

if [ "$MEM_DONE" = "0" ]; then
  echo "⚠ 未捕捉到 12 层采样锚点（自测可能提前中断），补一次截图"
  capture || echo "⚠ 截图失败（不影响日志断言）"
fi
if [ -f "$SHOT" ]; then
  echo "截图: shots/nav_selftest.png（$(stat -c %s "$SHOT" 2>/dev/null || echo '?') bytes）"
fi
# 等最后几条日志 POST 落盘；应用退出在 task4-done 之后 10 秒，先停 logserver，
# 避免退出时的页面卸载事件混进「无非预期 page-unload」断言
sleep 2

echo ""
echo "--- [5/5] 停 logserver，断言 device_log.txt ---"
kill "$LOGSRV_PID" 2>/dev/null || true
wait "$LOGSRV_PID" 2>/dev/null || true
LOGSRV_PID=""
sleep 1

[ -f "$LOG_FILE" ] || die "没有 device_log.txt —— 日志没收到（构建未注入 BPNCM_LOG_SRV / PC IP 设备不可达 / logserver 未监听）"

. "$SCRIPT_DIR/lib/nav_checks_ab.sh"
. "$SCRIPT_DIR/lib/nav_checks_cd.sh"

echo ""
echo "=== 结果: PASS=$PASS  FAIL=$FAIL ==="
if [ "$FAIL" -gt 0 ]; then
  echo "失败项："
  for m in "${FAILED_MSGS[@]}"; do echo "  - $m"; done
  echo ""
  echo "--- device_log.txt 导航相关摘录（末 100 行；原始日志: $LOG_FILE） ---"
  grep -E '\[(nav|navtest|app)\]|onAppError|degrade|reserve-timeout' "$LOG_FILE" 2>/dev/null | tail -100
  exit 1
fi
echo "全部 PASS（push/pop 语义 + 回退弹层槽位释放 + 15 层深度压力 + 连点合并 + degrade 路径）。"
echo "截图: shots/nav_selftest.png  内存采样: shots/nav_selftest_memory.txt"
echo "提示：探针实例仍装着，检查完可 miniapp_cli uninstall $PROBE_APPID 清理。"
exit 0
