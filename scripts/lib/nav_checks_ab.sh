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

echo "-- A. 平台回退弹层后的槽位释放 --"
assert_stack_eq "A: 再 go(player) 后平台弹掉 queue2/queue，栈回到 4 页" \
  "$(stack_line 'after fallback')" '["index","list","playlists","player"]'
assert_count "A: 平台销毁 queue2（page-unload queue2）" '[nav] page-unload queue2 live=' 1
assert_count "A: 平台销毁 queue（page-unload queue live=，不含 queue2）" '[nav] page-unload queue live=' 1
assert_count "A: 槽位释放后 go queue 重新 push（共 2 次 push）" '[nav] go queue -> queue (push)' 2
assert_count "A: 重开后 page-load queue 共 2 次" '[nav] page-load queue live=' 2
assert_stack_eq "A: 重新入队后栈含新 queue" \
  "$(stack_line 'after requeue')" '["index","list","playlists","player","queue"]'

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

