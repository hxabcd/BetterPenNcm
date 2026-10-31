#!/bin/bash
# 构建探针版：独立 appid，**不复用正式应用的 appid / 数据 / 安装**。
#
# 为什么要独立 appid：探针会频繁装卸、可能播测试音频、甚至改入口页；
# 用正式 appid 装探针会 uninstall 正式应用（清 data，虽可备份恢复）并打断使用。
# 探针应用有自己的 data 目录，与正式应用互不影响。
#
# 做法：临时把 package.json 的 appid 换成探针 appid、把 src/app.json 的 index 指向
# pages/probe/probe.vue，然后照常走 build.sh；退出时（无论成败）还原两个文件。
#
# ⚠ 改源码前必须先拿到构建锁：否则在"改完"和"build.sh 加锁"这两步之间，
#   另一个 build.sh 可能读到探针 appid 并把正式版构建成探针版。
#   本脚本自己持锁，再用 BPNCM_LOCK_HELD=1 让 build.sh 跳过二次加锁。
#
# 用法：
#   bash scripts/build_probe.sh                    # 默认探针 appid 8002026100500004
#   PROBE_APPID=8002026100500005 bash scripts/build_probe.sh
#   BPNCM_LOG_SRV=auto bash scripts/build_probe.sh   # 透传给 build.sh
#   bash scripts/build_probe.sh --force            # 清掉残留构建锁
#
# 产物：build/<探针appid>.<x_y_z>.amr。装机/启动：
#   bash scripts/install.sh --appid <探针appid> --no-backup --wait 0
set -e
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lock.sh"

LOCK_FORCE=0
BUILD_ARGS=()
for a in "$@"; do
  case "$a" in
    --force) LOCK_FORCE=1; BUILD_ARGS+=(--force) ;;
    -h|--help)
      cat <<'EOF'
用法: bash scripts/build_probe.sh [--force]

  探针 appid 用 PROBE_APPID 覆盖（默认 8002026100500004）
  日志服务器用 BPNCM_LOG_SRV 指定（例如 BPNCM_LOG_SRV=auto）
  --force 清掉残留构建锁

产物: build/<探针appid>.<x_y_z>.amr
装机: bash scripts/install.sh --appid <探针appid> --no-backup --wait 0
EOF
      exit 0 ;;
    *) die "未知参数：$a（只支持 --force；日志注入用 BPNCM_LOG_SRV=auto）" ;;
  esac
done

proj_init
PROBE_APPID="${PROBE_APPID:-8002026100500004}"
case "$PROBE_APPID" in ''|*[!0-9]*) die "探针 appid 必须是纯数字（收到 '$PROBE_APPID'）" ;; esac
export PROBE_APPID

BAK="$(mktemp -d)"
cp package.json "$BAK/package.json"
cp src/app.json "$BAK/app.json"

restore_sources() {
  cp "$BAK/package.json" package.json
  cp "$BAK/app.json" src/app.json
  rm -rf "$BAK"
}
# 注册成锁的退出钩子，而不是自己 trap EXIT —— 后者会覆盖 lock.sh 的释放逻辑（锁泄漏）
lock_add_exit_hook restore_sources
lock_acquire build

stage "改写入口（临时）"
python - "$PROBE_APPID" <<'PYEOF'
import json
import sys

appid = sys.argv[1]

p = json.load(open('package.json', encoding='utf-8'))
p['appid'] = appid
p['name'] = 'BPNCM Probe'
json.dump(p, open('package.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

a = json.load(open('src/app.json', encoding='utf-8'))
a['pages']['index'] = 'pages/probe/probe.vue'
a['pages']['probe'] = 'pages/probe/probe.vue'
json.dump(a, open('src/app.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PYEOF
info "  探针 appid: $PROBE_APPID（入口 = pages/probe）"

stage "构建（复用 build.sh）"
BPNCM_LOCK_HELD=1 bash "$SCRIPT_DIR/build.sh" ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}

stage_done
info "装机：bash scripts/install.sh --appid $PROBE_APPID --no-backup --wait 0"
