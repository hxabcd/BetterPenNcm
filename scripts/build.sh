#!/bin/bash
# 构建：必须用便携版 Node 18（系统 Node 26 会让 aiot-cli 崩溃）
#
# 工具链默认在工作区根的 tools/ 下；**git worktree 里 $PROJ/../.. 不是工作区根**，
# 所以工具链解析走 scripts/lib/common.sh 的 resolve_tools（用 git common-dir 反查主检出），
# 同时保留环境变量覆盖（CI / 换机时用）：
#   BPNCM_TOOLS=<tools 目录>   BPNCM_NODE=<node.exe>   BPNCM_CLI=<aiot-cli 的 cli.js>
#
# 实测：这台机器的工作区根被打了 `Mandatory Label\Low Mandatory Level`（向下继承），
# 放在 tools 树里的 exe 一起动就以低完整性级别运行 → **写不了任何文件**（Node 静默退出 1、
# qjsc 报 `<输出>: Permission denied`）。两条路：
#   icacls "<工作区根>" /setintegritylevel M /T   （根治，改回用 L）
#   BPNCM_NODE=C:/Users/<你>/.workbuddy/binaries/node/versions/22.22.2-3/node.exe  （绕开本机 exe）
# （aiot-cli 在 Node 22 上正常，Node 26 必定崩溃。）
#
# 用法：
#   bash scripts/build.sh                       # 构建
#   BPNCM_LOG_SRV=auto bash scripts/build.sh    # 自动用本机局域网 IP 作日志服务器
#   BPNCM_LOG_SRV=http://<PC>:8888/log bash scripts/build.sh
#   bash scripts/build.sh --force               # 清掉残留构建锁
set -e
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lock.sh"

usage() {
  cat <<'EOF'
用法: bash scripts/build.sh [选项]

  --force             清掉残留的构建锁（上次被强杀 / 终端被关时用）
  --log-srv <url|auto>  日志服务器地址，等价于 BPNCM_LOG_SRV；auto = 自动探测本机局域网 IP
  -h, --help          显示本帮助

产物: build/<appid>.<x_y_z>.amr（应用顶栏显示的构建号来自本次运行时间）
EOF
}

LOCK_FORCE=0
LOG_SRV_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force)    LOCK_FORCE=1; shift ;;
    --log-srv)  LOG_SRV_ARG="${2:-}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *)          printf '未知参数：%s\n' "$1" >&2; usage; exit 1 ;;
  esac
done

proj_init
resolve_tools
require_node

BUILD_TAG="$(date +%m%d-%H%M%S)"   # 先算出来，进锁信息便于诊断
APPID="$(appid_of)"

# install.sh 会在持有装机锁的前提下带着 BPNCM_LOCK_HELD=1 调本脚本：
# 装机流程本身已经排他，再抢一次构建锁会自己挡自己。
if [ "${BPNCM_LOCK_HELD:-0}" = "1" ]; then
  info "[锁] 由调用方持有（BPNCM_LOCK_HELD=1），跳过加锁"
else
  lock_acquire build
fi

# qjsc 上次被强杀会留下进程锁住输出文件，构建会卡住（症状像代码错误）
if qjsc_busy; then
  warn "检测到 qjsc20200705.exe 还在跑（上次构建被强杀？）——正在进行的构建可能卡死"
  warn "  可先 taskkill /F /IM qjsc20200705.exe 再重跑"
fi

# ---------- 生成构建信息 ----------
stage "生成构建信息（构建号 / 日志地址）"
printf "/* 由 scripts/build.sh 自动生成，勿手改 */\nexport const BUILD_TAG = '%s'\n" "$BUILD_TAG" > src/utils/buildInfo.js
info "  构建号: $BUILD_TAG（首页顶栏显示，用来确认设备上跑的是哪一次）"

# 日志服务器地址（开源清理：仓库不落内网 IP）→ src/utils/logconfig.generated.js
# 未注入时留空串，运行时回环缺省 = 设备端静默失败（功能零影响，但排查时会懵）
LOG_SRV="${LOG_SRV_ARG:-${BPNCM_LOG_SRV:-}}"
if [ "$LOG_SRV" = "auto" ]; then
  PC_IP="$(pc_lan_ip)"
  [ -n "$PC_IP" ] || die "自动探测本机局域网 IP 失败，请显式给 --log-srv http://<PC>:8888/log"
  LOG_SRV="http://$PC_IP:8888/log"
fi
if [ -n "$LOG_SRV" ]; then
  LOG_SRV="${LOG_SRV%/}"           # 去尾斜杠
  LOG_SRV="${LOG_SRV%/log}/log"    # 统一以 /log 结尾
fi
printf "/* 由 scripts/build.sh 自动生成，勿手改；生成物不进仓库（.gitignore） */\nexport const LOG_SRV = '%s'\n" "$LOG_SRV" > src/utils/logconfig.generated.js
info "  日志服务器: ${LOG_SRV:-（未注入）}"

# ---------- 编译 ----------
stage "编译（aiot-cli -c -q -p）"
STAMP="$(mktemp)"
set +e
"$NODE" "$(cygpath -w "$CLI")" -c -q -p
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  rm -f "$STAMP"
  # 必须检查退出码：否则构建失败（如 LESS 编译错）会被当成功，
  # 后面照常列旧产物，极难察觉（实测踩过：归档成了上一批的字节）
  die "构建失败：aiot-cli 退出码 $RC（上面的输出即原因；build/ 里的产物未更新）"
fi

# ---------- 校验产物 ----------
stage "校验产物"
mkdir -p build
mv -f ./*.amr build/ 2>/dev/null || true

# 只认"本次构建新生成"的产物：aiot-cli 返回 0 却没产出时，
# 旧版会照常打印 build/ 里的旧 amr，看起来像成功。
NEW_AMR="$(find build -maxdepth 1 -name "$APPID.*.amr" -newer "$STAMP" 2>/dev/null | head -1)"
rm -f "$STAMP"
[ -n "$NEW_AMR" ] || die "构建返回成功但没有产出 $APPID.*.amr（build/ 里的是旧产物）"

info "  产物: $NEW_AMR（$(du -h "$NEW_AMR" | cut -f1)）"
# 同 appid 的历史产物（版本号相同时会被覆盖，不同则并存）
info "  build/ 里该 appid 的产物:"
ls -t build/"$APPID".*.amr 2>/dev/null | sed 's/^/    /'

if [ -z "$LOG_SRV" ]; then
  printf '\n' >&2
  warn "未注入日志服务器地址 —— 设备端 console 日志会发往 127.0.0.1 并静默失败"
  warn "  要收设备日志：PC 上 python scripts/logserver.py，构建时加 BPNCM_LOG_SRV=auto"
  printf '\n' >&2
fi

stage_done
