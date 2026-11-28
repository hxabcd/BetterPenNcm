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

# attach 兜底通道日志：attach-skip 来自 PageShell 等非页面根实例，attach-ok 来自页面根实例
ATTACH_OK=$(grep -cF '[nav] attach-ok' "$LOG_FILE" 2>/dev/null || true)
ATTACH_SKIP=$(grep -cF '[nav] attach-skip' "$LOG_FILE" 2>/dev/null || true)
assert_has "attach 兜底通道日志出现（attach-ok 或 attach-skip）" '[nav] attach-' 1
echo "INFO attach-ok=${ATTACH_OK:-0} attach-skip=${ATTACH_SKIP:-0}（skip=PageShell 等子组件被跳过；ok=页面根实例兜底记账生效）"

# 失败路径（全程不允许；degrade 只在 D 阶段预期出现 1 次，已在上方逐条断言）
assert_absent "无 reserve-timeout（槽位保留超时）" 'reserve-timeout'
assert_absent "无 onAppError（框架异常）" 'onAppError'
assert_absent "无 navTo 异常" '[nav] navTo 异常'
assert_absent_regex "自测步骤无 FAIL" '\[navtest\].*FAIL'
