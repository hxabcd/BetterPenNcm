#!/bin/bash
# 交叉编译 X3S 原生扩展 libjsapi_bpnnet.so（aarch64 / glibc 2.29）
#
# X3S（RK3566「CHERRY」）是 aarch64、glibc 2.29；S7/X5 是 armhf，不会加载这个 .so。
# 产物同时注册两个裸模块：
#   bpnnet  —— fs / http / process.exec 能力（JS 侧见 src/core/platform/bridge.js）
#   sqlite3 —— S7 同款 Database/Statement 最小面（见 native/csrc/sqlite3mod.c）
#
# zig 解析顺序：
#   1. $ZIG（显式指定）
#   2. 仓库根 .venv-zig/bin/zig（安装：python -m venv .venv-zig && .venv-zig/bin/pip install ziglang）
#   3. PATH 里的 zig
#
# 用法：bash native/build-aarch64.sh
# 产物：libs/arm64-cherry3566/libjsapi_bpnnet.so（aiot-cli 打包时原样进 .amr 的 libs/；
#       正常 `bash scripts/build.sh` 不需要 zig —— 产物已入库）
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"

ZIG="${ZIG:-}"
if [ -z "$ZIG" ]; then
  if [ -x "$ROOT/.venv-zig/bin/zig" ]; then
    ZIG="$ROOT/.venv-zig/bin/zig"
  elif command -v zig >/dev/null 2>&1; then
    ZIG="$(command -v zig)"
  else
    printf '✗ 找不到 zig：设 $ZIG，或按 native/README.md 装 .venv-zig\n' >&2
    exit 1
  fi
fi

OUT_DIR="$ROOT/libs/arm64-cherry3566"
OUT="$OUT_DIR/libjsapi_bpnnet.so"
mkdir -p "$OUT_DIR"

# -g0 不生成 DWARF（避免本机绝对路径进 .so）；-Wl,-s 只 strip 符号表、保留 .dynsym 导出。
# 链接 stubs-aarch64 里的设备原件只为满足链接期符号解析：libquickjs 由宿主已加载，
# libcurl/libsqlite3 由 /usr/lib 同名 SONAME 满足。
"$ZIG" cc \
  -target aarch64-linux-gnu.2.29 -O2 -g0 -Wl,-s \
  -fPIC -shared -fvisibility=hidden \
  -I "$ROOT/native/iot-miniapp-sdk/include" \
  -o "$OUT" \
  "$ROOT/native/csrc/bpnnet.c" \
  "$ROOT/native/csrc/bpnnet_common.c" \
  "$ROOT/native/csrc/bpnnet_fs.c" \
  "$ROOT/native/csrc/bpnnet_exec.c" \
  "$ROOT/native/csrc/bpnnet_http.c" \
  "$ROOT/native/csrc/bpnnet_job.c" \
  "$ROOT/native/csrc/sqlite3mod.c" \
  "$ROOT/native/stubs-aarch64/libquickjs.so" \
  "$ROOT/native/stubs-aarch64/libcurl.so.4" \
  "$ROOT/native/stubs-aarch64/libsqlite3.so.0" \
  -lpthread \
  -Wl,-soname,libjsapi_bpnnet.so

python "$ROOT/native/tools/inspect_elf.py" "$OUT"
ls -l "$OUT"
