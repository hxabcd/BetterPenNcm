#!/bin/bash
# 互斥锁（供 build.sh / install.sh source 引入，不要直接执行）
#
# 为什么需要：多会话 / 多终端同时构建时，两个 aiot-cli 会抢同一份 .falcon_ 中间产物和
# qjsc 临时文件，表现为 EBUSY 或 "could not load module"，症状伪装成代码问题，排查成本
# 极高（踩过：连续 4 次失败一度以为是源码坏了）。所以入口直接拦：
# 已有同类任务在跑就报错退出，不排队、不覆盖。
#
# 用法（调用方须先设好 PROJ=项目根）：
#   LOCK_FORCE=1            # 可选：无条件清掉已存在的锁（含活锁），上次被强杀后用
#   . "$PROJ/scripts/lock.sh"
#   lock_add_exit_hook my_rollback   # 可选：追加退出钩子（清理动作），不要在里面 exit
#   lock_acquire build      # 拿不到锁会打印原因并 exit 1；拿到后进程退出时自动释放
#
# 实现：本机 Git Bash 没有 flock（实测 command -v flock 为空），用 mkdir 的原子性当锁
# ——并发 mkdir 同一个目录只有一个成功。锁目录 .<name>.lock/ 内 info 存：
#   第1行 PID / 第2行 启动 epoch / 第3行 构建号 / 第4行 锁名
# 判定规则：
#   - 持锁进程还活着  → 报错退出（并给出解锁命令）
#   - 持锁进程已死    → 陈旧锁，自动清理并继续
#   - LOCK_FORCE=1    → 无条件清锁（先打印原持有者信息）
#
# 注意：脚本里的 rm -rf 目标恒为锁目录自身，不要改动。

LOCK_HELD=""
LOCK_EXIT_HOOKS=()

# 锁目录创建时间在 5 秒内、info 还没写出来时，视为"别人刚抢到"，不判成陈旧锁
_lock_fresh() {
  local dir="$1" mt now
  mt="$(stat -c %Y "$dir" 2>/dev/null)"
  [ -n "$mt" ] || return 1
  now="$(date +%s)"
  [ $(( now - mt )) -lt 5 ]
}

_lock_alive() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  # 兜底：MSYS 的 kill 看不到非 MSYS 进程时，用 tasklist 再确认一次
  if command -v tasklist >/dev/null 2>&1; then
    if tasklist /NH /FI "PID eq $pid" 2>/dev/null | grep -qi "\.exe"; then
      return 0
    fi
  fi
  return 1
}

_lock_since() {  # $1=起始 epoch → 可读时长
  local s=$(( $(date +%s) - $1 ))
  if [ "$s" -lt 0 ]; then s=0; fi
  if [ "$s" -lt 60 ]; then echo "${s} 秒"; else echo "$(( s / 60 )) 分 $(( s % 60 )) 秒"; fi
}

lock_release() {
  if [ -n "$LOCK_HELD" ]; then
    rm -rf "$LOCK_HELD" 2>/dev/null || true
    LOCK_HELD=""
  fi
}

# 注册额外的退出钩子（例如 install.sh 的数据回滚）。
# 为什么需要：原先直接 `trap lock_release EXIT`，调用方一旦自己再 trap EXIT
# （装机失败要回滚数据）就会把释放锁的 trap 覆盖掉 —— 锁泄漏，下次必须 --force。
# 现在统一成单一 EXIT trap：先跑所有钩子，最后释放锁。
# 钩子约定：只做自己的清理，**不要 exit**（退出码由本库保留并透传）。
lock_add_exit_hook() {
  [ -n "${1:-}" ] && LOCK_EXIT_HOOKS+=("$1")
  return 0
}

_lock_on_exit() {
  local rc=$? h
  # ⚠ 管道和 $(...) 命令替换产生的子 shell 会**继承** EXIT trap。
  # 不挡住的话：子 shell 一退出就执行释放（锁被提前删掉），
  # 加了回滚钩子后更糟 —— 钩子里的 exit 会掐断正在取值的命令替换。
  # 只让"真正持锁的那个 shell"做清理（BASHPID 在子 shell 里不同，$$ 相同）。
  if [ -n "${_LOCK_MAIN_PID:-}" ] && [ "${BASHPID:-$$}" != "$_LOCK_MAIN_PID" ]; then
    return 0
  fi
  trap - EXIT
  if [ "${#LOCK_EXIT_HOOKS[@]}" -gt 0 ]; then
    for h in "${LOCK_EXIT_HOOKS[@]}"; do
      "$h" || true
    done
  fi
  lock_release
  exit "$rc"
}

# lock_acquire <锁名>  —— 成功返回 0，失败打印原因并 exit 1
lock_acquire() {
  local name="$1"
  local dir="$PROJ/.$1.lock"
  local line="" pid="" started="" tag="" i=0

  if ! mkdir "$dir" 2>/dev/null; then
    # 锁已被占用：读持有者信息（刚建目录还没写 info 时给最多 0.3 秒重试）
    while [ -z "$line" ] && [ "$i" -lt 3 ]; do
      line="$(cat "$dir/info" 2>/dev/null)"
      if [ -z "$line" ]; then sleep 0.1; fi
      i=$(( i + 1 ))
    done
    pid="$(printf '%s\n' "$line" | sed -n '1p')"
    started="$(printf '%s\n' "$line" | sed -n '2p')"
    tag="$(printf '%s\n' "$line" | sed -n '3p')"

    if [ "$LOCK_FORCE" = "1" ]; then
      echo "[lock] --force：强行清理 $name 锁（原持有者 PID=${pid:-未知}${tag:+，构建号 $tag}）"
      rm -rf "$dir" 2>/dev/null || true
      mkdir "$dir" 2>/dev/null || { echo "[lock] 仍无法创建锁目录：$dir"; exit 1; }
    elif [ -z "$pid" ] && [ -z "$line" ] && _lock_fresh "$dir"; then
      echo ""
      echo "[lock] 已有 ${name} 任务刚启动（锁目录 $dir 刚创建，持有者信息还没落盘），本次不启动"
      echo "[lock]   等它结束再跑，或确认没在跑时：bash scripts/${name}.sh --force"
      echo ""
      exit 1
    elif _lock_alive "$pid"; then
      local dur=""
      if [ -n "$started" ]; then dur="，已运行 $(_lock_since "$started")"; fi
      echo ""
      echo "[lock] 已有 ${name} 任务在跑，本次不启动"
      echo "[lock]   持有者 PID ${pid:-未知}${tag:+（构建号 $tag）}${dur}"
      echo "[lock]   两个同类任务同时跑会互抢 .falcon_ 与 qjsc 临时文件（EBUSY / could not load module），"
      echo "[lock]   症状伪装成代码错误，所以这里直接拦下，不排队。"
      if [ -n "$started" ] && [ $(( $(date +%s) - started )) -gt 600 ]; then
        echo "[lock]   ⚠ 已持有超过 10 分钟，大概率是 qjsc20200705.exe 残留把构建卡住了："
        echo "[lock]     taskkill /F /IM qjsc20200705.exe 后重跑（见 AGENTS.md「构建 / 验证」）"
      fi
      echo "[lock]   若确认没有任务在跑（上次被强杀 / 终端被关，锁没释放），二选一："
      echo "[lock]     bash scripts/${name}.sh --force    # 清锁并重跑"
      echo "[lock]     rm -rf .${name}.lock               # 只清锁"
      echo ""
      exit 1
    else
      echo "[lock] 清理上次遗留的 $name 锁（持有者 PID ${pid:-未知} 已不存在）"
      rm -rf "$dir" 2>/dev/null || true
      mkdir "$dir" 2>/dev/null || { echo "[lock] 仍无法创建锁目录：$dir"; exit 1; }
    fi
  fi

  # 拿到锁：登记持有者，退出时自动释放
  # ⚠ 用 BASHPID 而不是 $$：后者在子 shell 里仍是父进程 PID，会让锁信息记错人
  # （父进程也活着，判定结果仍正确，但排查时对不上真正的构建进程）
  {
    echo "${BASHPID:-$$}"
    echo "$(date +%s)"
    echo "${BUILD_TAG:-}"
    echo "$name"
  } > "$dir/info"
  LOCK_HELD="$dir"
  _LOCK_MAIN_PID="${BASHPID:-$$}"
  trap _lock_on_exit EXIT
}
