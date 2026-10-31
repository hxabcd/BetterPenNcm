#!/bin/bash
# 导航层真机自测：验证 utils/nav.js 的「逻辑页 → 实例槽位」是否得到标准 push/pop 语义。
#
# 覆盖五阶段（步骤在 src/pages/probe/probe.vue 的 runNavSelfTest）：
#   1) 基础 push/pop：同一逻辑页两连开 → base / base2 两个槽位；close 只关一层，下层不销毁；
#      player 是全局目的地页（reuse）；queue 两层。
#   2) 边界 A：平台「回退到栈内 player」会销毁它上面的 queue2/queue → 槽位必须被生命周期记账释放，
#      之后 go('queue') 要能重新 push（不能 degrade / 不能复用死实例）。
#   3) 边界 B：深度压力，把栈推到 15 层（12 层时采一次 miniapp_cli memoryApp + 截图），
#      再逐个 close 回收到 5 层；断言每步栈快照与页 load/unload 次数，识别平台页栈上限迹象。
#   4) 边界 C：连点合并 —— 同 tick 同参数连发两次只生效一次（dup-ignore），参数不同则两次都生效。
#   5) 边界 D：degrade —— artist 6 槽压满后第 7 次 go 复用最上层同类实例（不新增槽位），
#      释放一个槽位后 go 恢复 push。
#
# 用法（在仓库根/worktree 根执行；build_probe.sh 与 logserver.py 都在 scripts/ 下）：
#   bash scripts/nav_selftest.sh
#   BPNCM_DEVICE=<序列号> bash scripts/nav_selftest.sh        # 指定设备；不设时自动取 adb devices 唯一一台
#   PROBE_APPID=<探针appid> bash scripts/nav_selftest.sh      # 覆盖探针 appid（默认 8002026100500004）
#   BPNCM_TOOLS=<工作区>/tools bash scripts/nav_selftest.sh   # 覆盖工具链目录（worktree 默认用固定路径）
#   NAVTEST_DONE_WAIT=<秒> bash scripts/nav_selftest.sh       # 等 [navtest] task4-done 的上限（默认 90）
#
# 做的五件事：
#   1) 取本机局域网 IPv4 → BPNCM_LOG_SRV=http://<PC_IP>:8888/log 构建**探针版**
#      （独立 appid，不动正式应用 8000200708310039；入口 = pages/probe）；
#   2) 清旧 device_log.txt，后台起 scripts/logserver.py；
#   3) adb push + miniapp_cli uninstall/install/start 探针 appid（先卸旧实例，保证可重复运行）；
#   4) 页面内自测串行跑 go/close；PC 侧等 [navtest] task4-done，期间在 12 层锚点采
#      miniapp_cli memoryApp（→ shots/nav_selftest_memory.txt）并截图（→ shots/nav_selftest.png）；
#   5) 停 logserver，对 device_log.txt 逐条断言，打印 PASS/FAIL 摘要。
#
# 断言依据（日志格式见 src/utils/nav.js；tag=nav 的行由导航层打，tag=navtest 的行由探针页打）：
#   [nav] go <logical> -> <slot> (push) / (reuse) / (dup-ignore: Nms 内连点) / (degrade: 槽位耗尽 → …)
#   [nav] page-load|page-unload <slotKey> live=<n> [<stackKeys>]
#   [navtest] <步骤> begin/ok/FAIL ...、<阶段> stack=[...]
# 关键锚点：[navtest] done / after fallback / after requeue / deep12 / deep-full / deep-done /
#           after dedupe-same / after dedupe-diff / after artist6 / after degrade /
#           after close artist6 / after recover / task4-close <slot> / task4-done stack=[...]
#
# 退出码：0 = 全部 PASS（push/pop 语义 + 四类边界成立）；1 = 有 FAIL 或构建/装机/采集失败。
# 前提：设备已连接；构建/装机锁空闲（build.sh/install.sh 互斥，见 AGENTS.md）；PC 8888 未被占用。
set -u
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"
proj_init

PROBE_APPID="${PROBE_APPID:-8002026100500004}"
export PROBE_APPID                       # build_probe.sh 也读这个变量，保持构建/装机一致
LOG_FILE="$PROJ/device_log.txt"
SHOT="$PROJ/shots/nav_selftest.png"
MEM_FILE="$PROJ/shots/nav_selftest_memory.txt"
DONE_WAIT="${NAVTEST_DONE_WAIT:-90}"     # 等自测全部跑完的上限（秒；自测总时长约 40s）

# 工具链解析走公共库（worktree 里用 git common-dir 反查主检出，不再硬编码兜底路径）
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

# die / warn / info 由 scripts/lib/common.sh 提供

# 设备序列号与 ADB 变量由公共库解析：优先 BPNCM_DEVICE，
# 未设置时要求 adb devices 里恰好一台（真机与 VM 同时在线时不要猜）
resolve_device

PASS=0
FAIL=0
FAILED_MSGS=()
ok() { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); FAILED_MSGS+=("$1"); echo "FAIL  $1"; }

# ---------- 断言工具（日志行形如 [12:34:56][nav] ...） ----------
assert_has() { # <描述> <固定串> [最少次数]
  local desc="$1" pat="$2" min="${3:-1}" n
  n=$(grep -cF -- "$pat" "$LOG_FILE" 2>/dev/null || true)
  if [ "${n:-0}" -ge "$min" ]; then ok "$desc（$n 次）"; else bad "$desc（${n:-0} 次，期望 ≥$min；pattern: $pat）"; fi
}
assert_count() { # <描述> <固定串> <精确次数>
  local desc="$1" pat="$2" want="$3" n
  n=$(grep -cF -- "$pat" "$LOG_FILE" 2>/dev/null || true)
  if [ "${n:-0}" -eq "$want" ]; then ok "$desc（$n 次）"; else bad "$desc（${n:-0} 次，期望 $want；pattern: $pat）"; fi
}
assert_absent() { # <描述> <固定串>
  local desc="$1" pat="$2" n
  n=$(grep -cF -- "$pat" "$LOG_FILE" 2>/dev/null || true)
  if [ "${n:-0}" -eq 0 ]; then ok "$desc"; else bad "$desc（出现 $n 次；pattern: $pat）"; fi
}
assert_absent_regex() { # <描述> <扩展正则>
  local desc="$1" pat="$2" n
  n=$(grep -cE -- "$pat" "$LOG_FILE" 2>/dev/null || true)
  if [ "${n:-0}" -eq 0 ]; then ok "$desc"; else bad "$desc（出现 $n 次；regex: $pat）"; fi
}
assert_stack_has() { # <描述> <stack JSON 串> <元素名>
  local desc="$1" json="$2" elem="$3"
  case "$json" in
    *"\"$elem\""*) ok "$desc" ;;
    *) bad "$desc（stack=$json）" ;;
  esac
}
assert_stack_lacks() { # <描述> <stack JSON 串> <元素名>
  local desc="$1" json="$2" elem="$3"
  case "$json" in
    *"\"$elem\""*) bad "$desc（stack=$json）" ;;
    *) ok "$desc" ;;
  esac
}
assert_stack_eq() { # <描述> <实际 JSON> <期望 JSON>
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then ok "$desc"; else bad "$desc（实际=$got 期望=$want）"; fi
}
assert_num_eq() { # <描述> <实际数值> <期望数值>
  local desc="$1" got="$2" want="$3"
  if [ "${got:-x}" = "$want" ]; then ok "$desc（$got）"; else bad "$desc（实际=${got:-空} 期望=$want）"; fi
}
stack_line() { # <navtest 锚点标记> → 该行 stack JSON（取最后一条）
  grep -F "[navtest] $1 stack=" "$LOG_FILE" 2>/dev/null | tail -1 | sed 's/.* stack=//'
}

echo "=== 导航层真机自测（基础 + 回退弹层 + 深度压力 + 连点合并 + degrade） ==="
echo "设备: $DEVICE  探针 appid: $PROBE_APPID  工具链: $TOOLS"

[ -f "$NODE" ] || die "找不到工具链 Node: $NODE（用 BPNCM_TOOLS=<工作区>/tools 指定）"
$ADB get-state >/dev/null 2>&1 || die "设备未连接（$ADB get-state 失败）"
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

# ---------- 1) 构建探针版 ----------
echo ""
echo "--- [1/5] 构建探针版（BPNCM_LOG_SRV=http://$PC_IP:8888/log） ---"
STAMP="$(mktemp)"
BPNCM_LOG_SRV="http://$PC_IP:8888/log" bash scripts/build_probe.sh \
  || die "探针构建失败（构建锁冲突时先确认无人构建/清 .build.lock/，见 AGENTS.md）"

AMR="$(find build -maxdepth 1 -name "$PROBE_APPID.*.amr" -newer "$STAMP" 2>/dev/null | head -1)"
[ -n "$AMR" ] || AMR="$(ls -t build/*.amr 2>/dev/null | head -1)"
rm -f "$STAMP"
[ -n "$AMR" ] || die "构建后 build/ 里没有产物"
AMRF="$(basename "$AMR")"
APPID="${AMRF%%.*}"                       # 产物文件名 = <appid>.<x_y_z>.amr
[ "$APPID" = "$PROBE_APPID" ] || die "最新产物 appid=$APPID 不是探针 appid=$PROBE_APPID（可能有人同时在构建正式版）"
echo "产物: $AMRF"

# ---------- 2) 起 logserver ----------
echo ""
echo "--- [2/5] 启动 logserver（device_log.txt） ---"
start_logserver() {
  : > "$LOG_FILE"                          # 清旧日志；logserver 以追加方式写
  LOGSRV_OUT="$(mktemp)"
  python scripts/logserver.py > "$LOGSRV_OUT" 2>&1 &
  LOGSRV_PID=$!
  local j=0
  while [ "$j" -lt 20 ]; do                # 最多等 10s：Windows 上 python 启动偶尔偏慢
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

# ---------- 3) 装机并启动探针 ----------
echo ""
echo "--- [3/5] 装机并启动探针（先卸载旧实例保证可重复运行） ---"
$ADB shell "miniapp_cli uninstall $PROBE_APPID" >/dev/null 2>&1 || true
$ADB shell "echo 200 > /sys/class/backlight/backlight/brightness" >/dev/null 2>&1 || true
$ADB push "$(cygpath -w "$PROJ/$AMR")" /userdisk/Favorite/ >/dev/null || die "adb push 失败"
$ADB shell "miniapp_cli install /userdisk/Favorite/$AMRF" || die "miniapp_cli install 失败"
$ADB shell "hal-screen on" >/dev/null 2>&1 || true
$ADB shell "miniapp_cli start $PROBE_APPID" || die "miniapp_cli start 失败"

# ---------- 4) 采日志：12 层采样内存/截图 → 等 task4-done ----------
echo ""
echo "--- [4/5] 等待自测日志（最多 ${DONE_WAIT}s） ---"
mkdir -p shots
MEM_DONE=0

capture() {
  $ADB shell "hal-screen on" >/dev/null 2>&1 || true
  $ADB shell "miniapp_cli capture /userdisk/nav_selftest.png" >/dev/null 2>&1 || true
  rm -f "$SHOT"
  $ADB pull /userdisk/nav_selftest.png "$(cygpath -w "$SHOT")" >/dev/null 2>&1 || true
  [ -f "$SHOT" ] && [ "$(stat -c %s "$SHOT" 2>/dev/null || echo 0)" -ge 2000 ]
}

# 12 层稳定窗口里采一次内存（设备端输出含所有运行中小程序的组件树：只落盘摘要+原始，终端只打摘要）
mem_app() {
  local raw pages probe_pages
  raw="$(mktemp)"
  if command -v timeout >/dev/null 2>&1; then
    timeout 20 $ADB shell "miniapp_cli memoryApp" > "$raw" 2>&1 || true
  else
    $ADB shell "miniapp_cli memoryApp" > "$raw" 2>&1 || true
  fi
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

# ---------- 5) 停 logserver + 断言 ----------
echo ""
echo "--- [5/5] 停 logserver，断言 device_log.txt ---"
kill "$LOGSRV_PID" 2>/dev/null || true
wait "$LOGSRV_PID" 2>/dev/null || true
LOGSRV_PID=""
sleep 1

[ -f "$LOG_FILE" ] || die "没有 device_log.txt —— 日志没收到（构建未注入 BPNCM_LOG_SRV / PC IP 设备不可达 / logserver 未监听）"

# ===== 阶段 1：基础 push/pop =====
assert_has "go list -> list (push)" '[nav] go list -> list (push)'
assert_has "go list -> list2 (push)" '[nav] go list -> list2 (push)'
assert_has "go playlists -> playlists (push)" '[nav] go playlists -> playlists (push)'
assert_has "go playlists -> playlists2 (push)" '[nav] go playlists -> playlists2 (push)'
assert_has "go queue -> queue (push)" '[nav] go queue -> queue (push)'
assert_has "go queue -> queue2 (push)" '[nav] go queue -> queue2 (push)'

# player 是全局目的地页：两次 go 都 reuse；A 阶段再 go 一次也 reuse（合计 ≥3）
assert_has "go player -> player (reuse)" '[nav] go player -> player (reuse)' 3

assert_has "page-load list2（实例记账）" '[nav] page-load list2 live='
assert_has "page-load queue2（实例记账）" '[nav] page-load queue2 live='
assert_has "page-unload list2（close 生效）" '[nav] page-unload list2'
assert_has "page-unload playlists2（close 生效）" '[nav] page-unload playlists2'

STACK_AFTER_LIST2="$(stack_line 'after list2')"
[ -n "$STACK_AFTER_LIST2" ] && ok "收到 [navtest] after list2 stack=$STACK_AFTER_LIST2" || bad "缺少 [navtest] after list2 stack="
assert_stack_has "两连开时下层 list 仍在栈" "$STACK_AFTER_LIST2" "list"
assert_stack_has "两连开时上层 list2 在栈" "$STACK_AFTER_LIST2" "list2"

STACK_AFTER_CLOSE="$(stack_line 'after close list2')"
[ -n "$STACK_AFTER_CLOSE" ] && ok "收到 [navtest] after close list2 stack=$STACK_AFTER_CLOSE" || bad "缺少 [navtest] after close list2 stack="
assert_stack_has "close list2 后下层 list 仍存活（不连环销毁）" "$STACK_AFTER_CLOSE" "list"
assert_stack_lacks "close list2 后栈里不再有 list2" "$STACK_AFTER_CLOSE" "list2"

STACK_DONE="$(stack_line 'done')"
[ -n "$STACK_DONE" ] && ok "收到 [navtest] done stack=$STACK_DONE" || bad "缺少 [navtest] done stack="
assert_stack_has "[navtest] done 栈里含 list（第一层未被销毁）" "$STACK_DONE" "list"
assert_stack_has "[navtest] done 栈里含 queue2（第二层队列）" "$STACK_DONE" "queue2"

# ===== 阶段 2（A）：平台回退弹层后的槽位释放 =====
echo "-- A. 平台回退弹层后的槽位释放 --"
assert_stack_eq "A: 再 go(player) 后平台弹掉 queue2/queue，栈回到 4 页" \
  "$(stack_line 'after fallback')" '["index","list","playlists","player"]'
assert_count "A: 平台销毁 queue2（page-unload queue2）" '[nav] page-unload queue2 live=' 1
assert_count "A: 平台销毁 queue（page-unload queue live=，不含 queue2）" '[nav] page-unload queue live=' 1
assert_count "A: 槽位释放后 go queue 重新 push（共 2 次 push）" '[nav] go queue -> queue (push)' 2
assert_count "A: 重开后 page-load queue 共 2 次" '[nav] page-load queue live=' 2
assert_stack_eq "A: 重新入队后栈含新 queue" \
  "$(stack_line 'after requeue')" '["index","list","playlists","player","queue"]'

# ===== 阶段 3（B）：深度压力 15 层 =====
echo "-- B. 深度压力（15 层栈） --"
STACK_DEEP12="$(stack_line 'deep12')"
assert_stack_eq "B: 12 层栈快照" "$STACK_DEEP12" \
  '["index","list","playlists","player","queue","list2","list3","list4","list5","album","album2","artist"]'
STACK_DEEP_FULL="$(stack_line 'deep-full')"
assert_stack_eq "B: 15 层栈快照（deep-full）" "$STACK_DEEP_FULL" \
  '["index","list","playlists","player","queue","list2","list3","list4","list5","album","album2","artist","artist2","songinfo","songinfo2"]'

# 深度压栈的槽位分配（push 行）与 page-load
assert_count "B/C: go list -> list2 (push) 共 3 次（阶段1 + 深压 + C 连点首层）" '[nav] go list -> list2 (push)' 3
assert_has "B: go list -> list3 (push)" '[nav] go list -> list3 (push)'
assert_has "B: go list -> list4 (push)" '[nav] go list -> list4 (push)'
assert_has "B: go list -> list5 (push)" '[nav] go list -> list5 (push)'
assert_has "B: go album -> album (push)" '[nav] go album -> album (push)'
assert_has "B: go album -> album2 (push)" '[nav] go album -> album2 (push)'
assert_has "B: go artist -> artist (push)" '[nav] go artist -> artist (push)'
assert_has "B: go artist -> artist2 (push)" '[nav] go artist -> artist2 (push)'
assert_has "B: go songinfo -> songinfo (push)" '[nav] go songinfo -> songinfo (push)'
assert_has "B: go songinfo -> songinfo2 (push)" '[nav] go songinfo -> songinfo2 (push)'

for k in list3 list4 list5 album album2 artist artist2 songinfo songinfo2; do
  assert_has "B: page-load $k" "[nav] page-load $k live="
done
assert_count "B/C: page-load list2 共 3 次（阶段1 + 深压 + C 连点首层）" '[nav] page-load list2 live=' 3

# 逐个 close：每关一层后的栈快照（关闭顺序 = probe 的 DEEP_CLOSE）
assert_stack_eq "B: close songinfo2 后栈" "$(stack_line 'deep-close songinfo2')" \
  '["index","list","playlists","player","queue","list2","list3","list4","list5","album","album2","artist","artist2","songinfo"]'
assert_stack_eq "B: close songinfo 后栈" "$(stack_line 'deep-close songinfo')" \
  '["index","list","playlists","player","queue","list2","list3","list4","list5","album","album2","artist","artist2"]'
assert_stack_eq "B: close artist2 后栈" "$(stack_line 'deep-close artist2')" \
  '["index","list","playlists","player","queue","list2","list3","list4","list5","album","album2","artist"]'
assert_stack_eq "B: close artist 后栈" "$(stack_line 'deep-close artist')" \
  '["index","list","playlists","player","queue","list2","list3","list4","list5","album","album2"]'
assert_stack_eq "B: close album2 后栈" "$(stack_line 'deep-close album2')" \
  '["index","list","playlists","player","queue","list2","list3","list4","list5","album"]'
assert_stack_eq "B: close album 后栈" "$(stack_line 'deep-close album')" \
  '["index","list","playlists","player","queue","list2","list3","list4","list5"]'
assert_stack_eq "B: close list5 后栈" "$(stack_line 'deep-close list5')" \
  '["index","list","playlists","player","queue","list2","list3","list4"]'
assert_stack_eq "B: close list4 后栈" "$(stack_line 'deep-close list4')" \
  '["index","list","playlists","player","queue","list2","list3"]'
assert_stack_eq "B: close list3 后栈" "$(stack_line 'deep-close list3')" \
  '["index","list","playlists","player","queue","list2"]'
assert_stack_eq "B: close list2 后栈" "$(stack_line 'deep-close list2')" \
  '["index","list","playlists","player","queue"]'
assert_stack_eq "B: 深度回收完成（deep-done）" "$(stack_line 'deep-done')" \
  '["index","list","playlists","player","queue"]'

# ===== 阶段 4（C）：连点合并（500ms 同逻辑页 + 同参数） =====
echo "-- C. 连点合并（dup-ignore） --"
assert_count "C: dup-ignore 恰 1 次（唯一一次同 tick 同参数连点）" '[nav] go list (dup-ignore:' 1
assert_stack_eq "C: 同参数连点后只多压一层 list2（6 层）" "$(stack_line 'after dedupe-same')" \
  '["index","list","playlists","player","queue","list2"]'
assert_count "C: 同参数连点只生效一次：go list -> list2 (push) 共 3 次（阶段1/深压/连点首层）" '[nav] go list -> list2 (push)' 3
assert_count "C: 同参数连点只挂载一次：page-load list2 共 3 次（与 push 一致）" '[nav] page-load list2 live=' 3
assert_stack_eq "C: 不同参数连发两发都 push（list3 + list4 → 8 层）" "$(stack_line 'after dedupe-diff')" \
  '["index","list","playlists","player","queue","list2","list3","list4"]'
assert_count "C: 不同参数两发都生效：go list -> list3 (push) 共 2 次（深压 + 连点）" '[nav] go list -> list3 (push)' 2
assert_count "C: 不同参数两发都生效：go list -> list4 (push) 共 2 次（深压 + 连点）" '[nav] go list -> list4 (push)' 2

# ===== 阶段 5（D）：degrade 路径（artist 6 槽耗尽 → 复用最上层同类实例） =====
echo "-- D. degrade 路径（槽位耗尽） --"
DEEP14='["index","list","playlists","player","queue","list2","list3","list4","artist","artist2","artist3","artist4","artist5","artist6"]'
assert_stack_eq "D: artist 压满 6 槽后栈（14 层）" "$(stack_line 'after artist6')" "$DEEP14"
assert_count "D: degrade 恰 1 次（第 7 次 go artist 槽位耗尽）" 'degrade: 槽位耗尽' 1
assert_has "D: degrade 复用的是最上层同类实例 artist6" '复用最上层同类实例 artist6'
assert_stack_eq "D: degrade 后栈不变（复用当前栈顶，不弹层/不加层）" "$(stack_line 'after degrade')" "$DEEP14"
ART_IN_STACK="$(printf '%s' "$(stack_line 'after degrade')" | grep -o '"artist[0-9]*"' | wc -l | tr -d ' ')"
assert_num_eq "D: degrade 后栈里 artist 实例仍 6 个" "$ART_IN_STACK" 6
assert_absent "D: 没有第 7 个 artist 槽位（go artist -> artist7）" '[nav] go artist -> artist7 (push)'
assert_count "D: go artist -> artist (push) 共 2 次（B 深压 + D 首层）" '[nav] go artist -> artist (push)' 2
assert_count "D: go artist -> artist2 (push) 共 2 次（B 深压 + D 第二层）" '[nav] go artist -> artist2 (push)' 2
assert_has "D: go artist -> artist3 (push)" '[nav] go artist -> artist3 (push)'
assert_has "D: go artist -> artist4 (push)" '[nav] go artist -> artist4 (push)'
assert_has "D: go artist -> artist5 (push)" '[nav] go artist -> artist5 (push)'
assert_count "D: go artist -> artist6 (push) 共 2 次（首次 + 释放后恢复）" '[nav] go artist -> artist6 (push)' 2
assert_stack_eq "D: close 最上层 artist6 后栈 13 层" "$(stack_line 'after close artist6')" \
  '["index","list","playlists","player","queue","list2","list3","list4","artist","artist2","artist3","artist4","artist5"]'
assert_stack_eq "D: 槽位释放后 go artist 恢复 push（artist6 重新入栈）" "$(stack_line 'after recover')" "$DEEP14"
for k in artist3 artist4 artist5 artist6; do
  assert_has "D: page-load $k" "[nav] page-load $k live="
done
assert_count "D: page-load artist 共 2 次（B 深压 + D）" '[nav] page-load artist live=' 2
assert_count "D: page-load artist2 共 2 次（B 深压 + D）" '[nav] page-load artist2 live=' 2
assert_count "D: page-load artist6 共 2 次（D 首次 + 释放后恢复）" '[nav] page-load artist6 live=' 2

# D 阶段主动 close 回收：每关一层后的栈快照（顺序 = probe 的 TASK4_CLOSE）
assert_stack_eq "D: task4-close artist6 后栈" "$(stack_line 'task4-close artist6')" \
  '["index","list","playlists","player","queue","list2","list3","list4","artist","artist2","artist3","artist4","artist5"]'
assert_stack_eq "D: task4-close artist5 后栈" "$(stack_line 'task4-close artist5')" \
  '["index","list","playlists","player","queue","list2","list3","list4","artist","artist2","artist3","artist4"]'
assert_stack_eq "D: task4-close artist4 后栈" "$(stack_line 'task4-close artist4')" \
  '["index","list","playlists","player","queue","list2","list3","list4","artist","artist2","artist3"]'
assert_stack_eq "D: task4-close artist3 后栈" "$(stack_line 'task4-close artist3')" \
  '["index","list","playlists","player","queue","list2","list3","list4","artist","artist2"]'
assert_stack_eq "D: task4-close artist2 后栈" "$(stack_line 'task4-close artist2')" \
  '["index","list","playlists","player","queue","list2","list3","list4","artist"]'
assert_stack_eq "D: task4-close artist 后栈" "$(stack_line 'task4-close artist')" \
  '["index","list","playlists","player","queue","list2","list3","list4"]'
assert_stack_eq "D: task4-close list4 后栈" "$(stack_line 'task4-close list4')" \
  '["index","list","playlists","player","queue","list2","list3"]'
assert_stack_eq "D: task4-close list3 后栈" "$(stack_line 'task4-close list3')" \
  '["index","list","playlists","player","queue","list2"]'
assert_stack_eq "D: task4-close list2 后栈" "$(stack_line 'task4-close list2')" \
  '["index","list","playlists","player","queue"]'
assert_stack_eq "D: 全部回收后栈（task4-done）" "$(stack_line 'task4-done')" \
  '["index","list","playlists","player","queue"]'

# 页卸载次数：主动 close / A 回退销毁（共 24 次），逐 key 断言
assert_count "B/C/D: page-unload list2 共 3 次（阶段1 + B 深度回收 + C 回收）" '[nav] page-unload list2 live=' 3
assert_count "B/C/D: page-unload list3 共 2 次（B 深度回收 + C 回收）" '[nav] page-unload list3 live=' 2
assert_count "B/C/D: page-unload list4 共 2 次（B 深度回收 + C 回收）" '[nav] page-unload list4 live=' 2
assert_count "B/C/D: page-unload artist 共 2 次（B 回收 + D 回收）" '[nav] page-unload artist live=' 2
assert_count "B/C/D: page-unload artist2 共 2 次（B 回收 + D 回收）" '[nav] page-unload artist2 live=' 2
assert_count "D: page-unload artist6 共 2 次（degrade 后 close + 恢复后回收）" '[nav] page-unload artist6 live=' 2
for k in playlists2 songinfo2 songinfo album2 album list5 artist3 artist4 artist5; do
  assert_count "B/C/D: page-unload $k 恰 1 次（主动 close/回退销毁）" "[nav] page-unload $k live=" 1
done

EXPECTED_UNLOAD_KEYS="album album2 artist artist2 artist3 artist4 artist5 artist6 list2 list3 list4 list5 playlists2 queue queue2 songinfo songinfo2"
UNLOAD_KEYS="$(grep -F '[nav] page-unload ' "$LOG_FILE" 2>/dev/null | sed 's/.*page-unload //; s/ .*//' | sort -u)"
UNEXPECTED_KEYS=""
for k in $UNLOAD_KEYS; do
  found=0
  for e in $EXPECTED_UNLOAD_KEYS; do
    if [ "$k" = "$e" ]; then found=1; break; fi
  done
  if [ "$found" = "0" ] && [ "$k" != "index" ]; then UNEXPECTED_KEYS="$UNEXPECTED_KEYS $k"; fi
done
if [ -z "$UNEXPECTED_KEYS" ]; then
  ok "B/C/D: 无非预期 page-unload（只有主动 close / A 回退销毁）"
else
  bad "B/C/D: 出现非预期 page-unload：$UNEXPECTED_KEYS（可能是平台页栈上限在弹层；栈快照/deep 日志见 device_log.txt）"
fi
NAV_UNLOADS=$(grep -F '[nav] page-unload ' "$LOG_FILE" 2>/dev/null | grep -vcF '[nav] page-unload index live=' || true)
if [ "${NAV_UNLOADS:-0}" = "24" ]; then
  ok "B/C/D: 非 index 页卸载总数 24（阶段1 2 + A 回退 2 + B 深度回收 10 + C 回收 3 + D 回收 7）"
else
  bad "B/C/D: 非 index 页卸载总数 ${NAV_UNLOADS:-0} ≠ 24（阶段1 2 + A 回退 2 + B 深度回收 10 + C 回收 3 + D 回收 7）"
fi
if grep -qF '[nav] page-unload index live=' "$LOG_FILE" 2>/dev/null; then
  echo "⚠ 日志里出现 probe 页(index)卸载：应用退出发生在停 logserver 之前（采样窗口偏长），已从上面的统计中排除"
fi

# attach 兜底通道日志（审计新增）：attach-skip 来自 PageShell 等非页面根实例，attach-ok 来自页面根实例
ATTACH_OK=$(grep -cF '[nav] attach-ok' "$LOG_FILE" 2>/dev/null || true)
ATTACH_SKIP=$(grep -cF '[nav] attach-skip' "$LOG_FILE" 2>/dev/null || true)
assert_has "attach 兜底通道日志出现（attach-ok 或 attach-skip）" '[nav] attach-' 1
echo "INFO attach-ok=${ATTACH_OK:-0} attach-skip=${ATTACH_SKIP:-0}（skip=PageShell 等子组件被跳过；ok=页面根实例兜底记账生效）"

# ===== 失败路径（全程不允许；degrade 只在 D 阶段预期出现 1 次，已在上方逐条断言） =====
assert_absent "无 reserve-timeout（槽位保留超时）" 'reserve-timeout'
assert_absent "无 onAppError（框架异常）" 'onAppError'
assert_absent "无 navTo 异常" '[nav] navTo 异常'
assert_absent_regex "自测步骤无 FAIL" '\[navtest\].*FAIL'

# ===== 总摘要 =====
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
