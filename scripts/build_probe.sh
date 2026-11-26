#!/bin/bash
# 构建探针版：独立 appid，不复用正式应用的 appid / 数据 / 安装。
# 用正式 appid 装探针会 uninstall 正式应用（清 data）并打断使用，所以探针有自己的 data 目录。
#
# ⚠ 改源码发生在「取锁之后、构建之前」，两步必须在同一把锁里：否则之间另一个构建
#   可能读到探针 appid，把正式版构建成探针版。所以真正干活的是下面那段 Python。
#
# 用法: bash scripts/build_probe.sh [--force]
#   PROBE_APPID=<appid>  覆盖探针 appid（默认 8002026100500004）
#   BPNCM_LOG_SRV=auto   透传给 gen-buildinfo.py
#   装机: bash scripts/install.sh --appid <探针appid> --no-build
set -e
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJ"
. "$SCRIPT_DIR/lib/common.sh"

FORCE=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    -h|--help)
      cat <<'EOF'
用法: bash scripts/build_probe.sh [--force]

  探针 appid 用 PROBE_APPID 覆盖（默认 8002026100500004）
  日志服务器用 BPNCM_LOG_SRV 指定（例如 BPNCM_LOG_SRV=auto）
  --force 清掉残留构建锁

产物: build/<探针appid>.<x_y_z>.amr
装机: bash scripts/install.sh --appid <探针appid> --no-build
EOF
      exit 0 ;;
    *) die "未知参数：$a（只支持 --force；日志注入用 BPNCM_LOG_SRV=auto）" ;;
  esac
done

PROBE_APPID="${PROBE_APPID:-8002026100500004}"
case "$PROBE_APPID" in ''|*[!0-9]*) die "探针 appid 必须是纯数字（收到 '$PROBE_APPID'）" ;; esac

WS="$(dpd_find_workspace "$PROJ")" || die "找不到工作区根（向上没有 tools/dictpen-dev）"
PY="$(dpd_python)" || die "需要 Python 3.11+（配置是 TOML，用内建 tomllib 解析）"
export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"
export PROBE_APPID
export DPD_PROBE_FORCE="$FORCE"

exec "$PY" - "$(dpd_winpath_py "$PROJ")" "$(dpd_winpath_py "$WS")" <<'PYEOF'
import json
import os
import sys
from pathlib import Path

proj = Path(sys.argv[1])
ws = Path(sys.argv[2])
sys.path.insert(0, str(ws / "tools" / "dictpen-dev"))

from dpd import builder, lock, config  # noqa: E402

probe_appid = os.environ["PROBE_APPID"]
force = os.environ.get("DPD_PROBE_FORCE") == "1"

pkg = proj / "package.json"
app_json = proj / "src" / "app.json"
originals = {pkg: pkg.read_bytes(), app_json: app_json.read_bytes()}

def restore() -> None:
    for path, data in originals.items():
        try:
            path.write_bytes(data)
        except OSError as exc:
            print(f"⚠ 还原 {path} 失败：{exc}", file=sys.stderr)

target = config.resolve(proj)
b = target.build

try:
    with lock.acquire(ws, builder.LOCK_NAME, force=force,
                      note=f"探针构建 {probe_appid}"):
        print(f"==> 改写入口（临时）", file=sys.stderr)
        data = json.loads(pkg.read_text(encoding="utf-8"))
        data["appid"] = probe_appid
        data["name"] = "BPNCM Probe"
        pkg.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                       encoding="utf-8")

        pages = json.loads(app_json.read_text(encoding="utf-8"))
        pages["pages"]["index"] = "pages/probe/probe.vue"
        pages["pages"]["probe"] = "pages/probe/probe.vue"
        app_json.write_text(json.dumps(pages, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        print(f"    探针 appid: {probe_appid}（入口 = pages/probe）", file=sys.stderr)

        print("==> 构建（复用 builder）", file=sys.stderr)
        # lock_held=True：本进程已持锁，再 acquire 会把自己挡住。
        result = builder.build(
            proj,
            level=b.level,
            required=list(b.required),
            warn_missing=list(b.warn_missing),
            pre_steps=[list(s) for s in b.pre_steps],
            post_steps=[list(s) for s in b.post_steps],
            timeout=b.timeout,
            lock_held=True,
        )
finally:
    restore()

if not result.ok:
    print("✗ 探针构建失败", file=sys.stderr)
    sys.exit(1)

print(f"==> 完成（{result.level}）  产物: {result.amr}", file=sys.stderr)
print(f"装机：bash scripts/install.sh --appid {probe_appid} --no-build", file=sys.stderr)
PYEOF
