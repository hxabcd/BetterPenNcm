#!/bin/bash
# 传输层自测：用 mock 的 adb / ssh / scp 覆盖「参数解析 + 二进制收发 + 后端分派」。
# 可以不用真机：device.sh 的契约是「把命令/文件完整交给对应 exe」，
# mock 把这些 exe 换成记录调用 + 模拟远端文件系统，就能验证参数、二进制安全与后端分派。
# 用法：bash scripts/lib/device_selftest.sh（退出码 0 = 全部通过；临时目录自动清理）
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（得到 [$2] 期望 [$3]）"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MOCK="$TMP/mock"; REMOTE="$TMP/remote"; LOG="$TMP/calls.log"
mkdir -p "$MOCK" "$REMOTE/userdisk/Favorite" "$REMOTE/tmp"
: > "$LOG"

# mock cygpath：让 Windows 路径保持 MSYS 形式，mock 才能 cp。
# 生产代码靠 cygpath -w 把路径交给 Windows 原生 exe（adb/scp 确实需要）；这里只替换 cygpath 本身。
cat > "$MOCK/cygpath" <<'EOF'
#!/bin/bash

case "$1" in
  -w|-u) shift ;;
esac
printf '%s' "$1"
EOF
chmod +x "$MOCK/cygpath"

cat > "$MOCK/adb" <<EOF
#!/bin/bash

printf 'adb %s\n' "\$*" >> "$LOG"
sub=""; args=()
while [ \$# -gt 0 ]; do
  case "\$1" in
    -s) shift 2 ;;
    get-state) echo "device"; exit 0 ;;
    devices) printf 'List of devices attached\nMOCKSERIAL\tdevice\n\n'; exit 0 ;;
    shell) shift; sub=shell; args=("\$@"); break ;;
    push) shift; sub=push; args=("\$@"); break ;;
    pull) shift; sub=pull; args=("\$@"); break ;;
    *) shift ;;
  esac
done
case "\$sub" in
  shell)
    cmd="\${args[*]}"
    case "\$cmd" in
      'ls -d '*)
        p="\${cmd#ls -d }"; p="\${p%% 2>/dev/null*}"
        rp="$REMOTE/\${p#/}"
        [ -e "\$rp" ] && printf '%s\n' "\$p" ;;
      *)
        printf 'mock-shell: %s\n' "\$cmd" ;;
    esac
    ;;
  push)
    cp "\${args[0]}" "$REMOTE/\${args[1]#/}" 2>/dev/null || exit 1
    ;;
  pull)
    cp "$REMOTE/\${args[0]#/}" "\${args[1]}" 2>/dev/null || exit 1
    ;;
esac
exit 0
EOF

cat > "$MOCK/ssh" <<EOF
#!/bin/bash

printf 'ssh %s\n' "\$*" >> "$LOG"
cmd="\${@: -1}"
case "\$cmd" in
  'echo ok') echo ok; exit 0 ;;
  'ls -d '*)
    p="\${cmd#ls -d }"; p="\${p%% 2>/dev/null*}"
    rp="$REMOTE/\${p#/}"
    [ -e "\$rp" ] && printf '%s\n' "\$p"
    ;;
  'base64 '*)
    p="\${cmd#base64 }"; base64 -w0 "$REMOTE/\${p#/}" 2>/dev/null
    ;;
  *) printf 'mock-ssh: %s\n' "\$cmd" ;;
esac
exit 0
EOF

# mock scp：记录命令 + 真正搬字节（验证二进制安全）
cat > "$MOCK/scp" <<EOF
#!/bin/bash

printf 'scp %s\n' "\$*" >> "$LOG"
# 远端参数形态是 <host>:/abs/path；Windows 本地路径是 C:/...（单个盘符 + 冒号），
# 两者都带冒号，只能靠「冒号前是否只有一个字母」区分。
is_remote() {
  case "\$1" in
    [A-Za-z]:/*) return 1 ;;
    *:*)         return 0 ;;
    *)           return 1 ;;
  esac
}
pos=(); skip=0
for a in "\$@"; do
  if [ "\$skip" = 1 ]; then skip=0; continue; fi
  case "\$a" in
    -q|-O) continue ;;
    -o) skip=1; continue ;;
    -*) continue ;;
    *) pos+=("\$a") ;;
  esac
done
src="\${pos[0]}"; dst="\${pos[1]}"
if is_remote "\$src"; then
  rp="\${src#*:}"
  cp "$REMOTE/\${rp#/}" "\$dst"
else
  dstp="\${dst#*:}"
  case "\$dstp" in
    */) mkdir -p "$REMOTE/\${dstp#/}"; cp "\$src" "$REMOTE/\${dstp#/}/\$(basename "\$src")" ;;
    *)  mkdir -p "$REMOTE/\$(dirname "\${dstp#/}")"; cp "\$src" "$REMOTE/\${dstp#/}" ;;
  esac
fi
EOF
chmod +x "$MOCK/adb" "$MOCK/ssh" "$MOCK/scp"

# 让 device.sh 用 mock；PROJ 供 common.sh 定位。
# PATH 前置 MOCK：device.sh 里的 command -v cygpath 会命中 mock。
export PATH="$MOCK:$PATH"
export PROJ="$TMP/proj"
mkdir -p "$PROJ/scripts/lib"
cp "$HERE/common.sh" "$PROJ/scripts/lib/common.sh"
cp "$HERE/device.sh" "$PROJ/scripts/lib/device.sh"
export BPNCM_ADB="$MOCK/adb" BPNCM_SSH_BIN="$MOCK/ssh" BPNCM_SCP_BIN="$MOCK/scp"

# 临时目录不在工作区里，向上找不到 tools/dictpen-dev；把真实工作区指给它，
# 测的仍是生产代码路径（共享层一行不改）。
_selftest_ws() {
  local d="$HERE"
  while [ -n "$d" ] && [ "$d" != "/" ] && [ "$d" != "." ]; do
    if [ -f "$d/tools/dictpen-dev/lib/transport.sh" ]; then printf '%s' "$d"; return 0; fi
    d="$(dirname "$d")"
  done
  return 1
}
if ! DPD_SELFTEST_WS="$(_selftest_ws)"; then
  printf 'FAIL  找不到工作区 tools/dictpen-dev（自测需要它在源仓库里）\n' >&2
  exit 1
fi
export DPD_WORKSPACE="$DPD_SELFTEST_WS"
# 共享层用 DPD_* 键；本自测的 mock 二进制走这些变量名。
export DPD_ADB_BIN="$MOCK/adb" DPD_SSH_BIN="$MOCK/ssh" DPD_SCP_BIN="$MOCK/scp"

# common.sh 会 source device.sh，die/info/warn 也因此可用。
. "$PROJ/scripts/lib/common.sh"
# 每个用例重新 source device.sh，避免状态串味。
# 共享层 DPD_TRANSPORT/DPD_TARGET 是**输入**，必须与旧名一起清，
# 否则上一用例解析出的目标会挡住本用例显式设置的 BPNCM_SSH（适配层只在未设时映射）。
load() { unset DEV_TRANSPORT DEVICE DEVICE_LABEL DEV_ADB_BIN DEV_SSH_TARGET BPNCM_TRANSPORT DPD_TRANSPORT DPD_TARGET DPD_EFFECTIVE_TRANSPORT; . "$PROJ/scripts/lib/device.sh"; }

echo "=== 传输层自测（mock adb / ssh / scp） ==="

load
dev_select adb
check 'ADB 自动选唯一序列号' "$DEVICE" 'MOCKSERIAL'
grep -q "adb -s MOCKSERIAL" "$LOG" && ok 'ADB 命令含 -s 序列号' || bad 'ADB 命令缺 -s 序列号'

out="$(dev_run 'echo "a | b" > /tmp/x; echo done')"
check 'ADB dev_run 带管道的命令串' "$out" "mock-shell: echo \"a | b\" > /tmp/x; echo done"

printf 'AMR\000\001\377binary\r\n' > "$TMP/src.amr"
dev_put "$TMP/src.amr" /userdisk/Favorite/pkg.amr
cmp -s "$TMP/src.amr" "$REMOTE/userdisk/Favorite/pkg.amr" \
  && ok 'ADB dev_put 二进制一致' || bad 'ADB dev_put 二进制不一致'
dev_get /userdisk/Favorite/pkg.amr "$TMP/got.amr"
cmp -s "$TMP/src.amr" "$TMP/got.amr" \
  && ok 'ADB dev_get 二进制一致' || bad 'ADB dev_get 二进制不一致'

dev_exists /userdisk/Favorite/pkg.amr && ok 'dev_exists 命中已存在路径' || bad 'dev_exists 漏判'
dev_exists /userdisk/Favorite/nope.amr && bad 'dev_exists 误判不存在路径' || ok 'dev_exists 正确判空'

# /tmp/ 路径要转成 //tmp/：绕过 MSYS 对 /tmp 的本机映射（2026-11-08 实测坑）
: > "$TMP/plain.txt"
dev_put "$TMP/plain.txt" /tmp/bpncm_selftest.txt
grep -q 'push .* //*/tmp/bpncm_selftest.txt' "$LOG" \
  && ok 'dev_put /tmp/ 转为 //tmp/' || bad 'dev_put 未做 //tmp/ 转换'
dev_get /tmp/bpncm_selftest.txt "$TMP/plain_out.txt"
grep -q 'pull .*//*/tmp/bpncm_selftest.txt' "$LOG" \
  && ok 'dev_get /tmp/ 转为 //tmp/' || bad 'dev_get 未做 //tmp/ 转换'

load
dev_select ssh --ssh pen
check 'SSH 目标保存' "$DEV_SSH_TARGET" 'pen'
check 'SSH 后端标记' "$DEV_TRANSPORT" 'ssh'
grep -q 'ssh .*pen .*echo ok' "$LOG" && ok 'SSH 连通性走 echo ok' || bad 'SSH 连通性未执行'

out="$(dev_run 'miniapp_cli install /userdisk/Favorite/pkg.amr')"
check 'SSH dev_run 命令串' "$out" 'mock-ssh: miniapp_cli install /userdisk/Favorite/pkg.amr'
dev_exists /userdisk/Favorite/pkg.amr && ok 'SSH dev_exists 命中' || bad 'SSH dev_exists 漏判'

dev_put "$TMP/src.amr" /userdisk/Favorite/ssh_pkg.amr
cmp -s "$TMP/src.amr" "$REMOTE/userdisk/Favorite/ssh_pkg.amr" \
  && ok 'SSH dev_put 二进制一致' || bad 'SSH dev_put 二进制不一致'
dev_get /userdisk/Favorite/ssh_pkg.amr "$TMP/ssh_got.amr"
cmp -s "$TMP/src.amr" "$TMP/ssh_got.amr" \
  && ok 'SSH dev_get 二进制一致' || bad 'SSH dev_get 二进制不一致'

dev_put "$TMP/src.amr" /userdisk/Favorite/
[ -f "$REMOTE/userdisk/Favorite/src.amr" ] \
  && ok 'SSH dev_put 目录目标' || bad 'SSH dev_put 目录目标失败'

# scp 不可用时的二进制通道：base64 兜底
cat > "$MOCK/scp" <<EOF
#!/bin/bash

printf 'scp FAIL %s\n' "\$*" >> "$LOG"
exit 1
EOF
chmod +x "$MOCK/scp"
dev_get /userdisk/Favorite/ssh_pkg.amr "$TMP/b64_got.amr"
cmp -s "$TMP/src.amr" "$TMP/b64_got.amr" \
  && ok 'SSH dev_get base64 兜底二进制一致' || bad 'SSH dev_get base64 兜底失败'

load
# die 会 exit，未知后端必须在子 shell 里跑
if ( dev_select bogus ) >/dev/null 2>&1; then bad '未知后端应报错'; else ok '未知后端报错退出'; fi

load
BPNCM_TRANSPORT=ssh BPNCM_SSH=pen2 dev_select
check '环境变量默认后端' "$DEV_TRANSPORT" 'ssh'
check '环境变量默认 SSH 目标' "$DEV_SSH_TARGET" 'pen2'

out="$(bash "$HERE/devctl.sh" --ssh pen2 run 'echo hi' 2>/dev/null)"
check 'devctl run 经 SSH 分派' "$out" 'mock-ssh: echo hi'
if bash "$HERE/devctl.sh" exists /userdisk/Favorite/pkg.amr >/dev/null 2>&1; then
  ok 'devctl exists 命中 → 退出 0'
else
  bad 'devctl exists 命中应退出 0'
fi
if bash "$HERE/devctl.sh" exists /userdisk/Favorite/nope.amr >/dev/null 2>&1; then
  bad 'devctl exists 未命中应退出 1'
else
  ok 'devctl exists 未命中 → 退出 1'
fi

echo ""
echo "=== 结果: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || { echo '--- 调用日志 ---'; cat "$LOG"; exit 1; }
echo "全部通过。真实设备连通性另用: bash scripts/lib/device_livecheck.sh --ssh pen"
exit 0
