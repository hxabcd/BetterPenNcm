// 播放器（拆分自 player.js）：队列编辑（起播、移除、插入下一首、尾部补齐、清空回空态）。

import { log } from '../../core/infra/log.js'
import { clear as clearSession } from './session.js'
import { stop } from './sound.js'
import { persist } from './player-persist.js'
import { playAt } from './player-play.js'
import { buildShuffle } from './player-shuffle.js'
import { S, activeList, emit, inShuffle, stopTimer } from './player-state.js'


// src：队列来源标记（可选）—— 目前只有 'downloads'（本地下载页），删下载曲目时按它决定要不要同步清理队列
export function playList(songs, i, src) {
  S.queue = songs || []
  S.queueSrc = src || ''
  S.qgen++
  S.shuf = null 
  const at = i || 0
  if (S.loopMode === 'shuffle') {
    buildShuffle(S.queue[at])
    return playAt(0)
  }
  return playAt(at)
}

/* 队列被清空 → 播放器回到**空态**（编辑队列允许清空）。
 * 与 stopPlay 不是一回事：stopPlay 保留曲目、只把位置归零（按 ▶ 是重播这首）；这里连 cur 一起清掉。
 * 三件必须做的事：
 *   ① gen++ / uuid='' 作废在途的起播流程（这次 stop 的结束事件不能被认成「播完」→ 连播）
 *   ② clearSession() 删掉会话快照：不删的话下次启动会把刚清空的队列恢复回来
 *   ③ emit 之后再 stop：订阅者先拿到空态，随后原生播放器才停 */
function clearPlayback(hintText) {
  S.gen++
  S.uuid = ''
  stopTimer()
  S.qgen++
  S.queue = []
  S.queueSrc = ''
  S.shuf = null
  S.cur = {}
  S.index = -1
  S.durationMs = 0
  S.positionMs = 0
  S.baseMs = 0
  S.startedAt = 0
  S.paused = false
  S.isPlaying = false
  S.loading = false
  S.srcMode = ''
  S.localPath = ''
  S.status = ''
  S.streamUrl = null
  S.cacheKick = { id: '', at: 0 }
  S.hint = hintText || '队列已清空'
  emit()
  clearSession()
  try {
    const p = stop()
    if (p && p.catch) p.catch(function () {})
  } catch (e) {}
  log('player', '队列已清空 → 播放器空态')
}

// 只换当前曲、**不出声**（移除在播曲后接下一首；暂停态走这条）：用户本来没在听，不能因为「删了一首」就突然出声
function switchTo(i) {
  const s = activeList()[i]
  if (!s) return false
  S.gen++ 
  S.uuid = ''
  stopTimer()
  S.cur = s
  S.index = i
  S.durationMs = s.durationMs || 0
  S.positionMs = 0
  S.baseMs = 0
  S.startedAt = 0
  S.paused = true
  S.isPlaying = false
  S.loading = false
  S.srcMode = ''
  S.localPath = ''
  S.status = ''
  S.hint = ''
  emit()
  persist(0)
  try {
    const p = stop()
    if (p && p.catch) p.catch(function () {})
  } catch (e) {}
  return true
}

// 在删除**前**的生效队列里找「第 from 首之后第一个活下来的」：先往后找，后面没了再绕回队首
function pickAfter(al, from, drop) {
  const n = al ? al.length : 0
  if (!n) return null
  const start = from >= 0 ? from + 1 : 0
  for (let k = start; k < n; k++) {
    if (al[k] && !drop[String(al[k].id)]) return al[k]
  }
  for (let k = 0; k < Math.min(start, n); k++) {
    if (al[k] && !drop[String(al[k].id)]) return al[k]
  }
  return null
}

/* 从当前播放队列移除若干首（播放列表页多选「移除」）。
 *   - 允许移除正在播放的那首：删完接着播「原来的下一首」（当时在出声就继续出声，暂停态只换曲不播）
 *   - 允许把队列清空：删完一首不剩 → 停播并回空态（见 clearPlayback）
 *   - 原始队列与随机临时队列同时删；在播曲没被删时 index 按它在「生效队列」里的新位置重算
 * 返回 { ok, removed, skipped, emptied, switched } */
export function removeFromQueue(ids) {
  const list = ids || []
  const drop = {}
  for (let i = 0; i < list.length; i++) drop[String(list[i])] = 1
  if (!Object.keys(drop).length) {
    return { ok: false, removed: 0, skipped: 0, emptied: false, switched: false }
  }
  const hitCur = !!(S.cur.id && drop[String(S.cur.id)])

  // 删除**前**的生效队列与下标：找「下一首」要用旧顺序，删完就找不着了
  const alOld = activeList()
  const curIdx = S.index
  const wasPlaying = S.isPlaying && !S.paused
  const keep = function (arr) {
    const out = []
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i]
      if (s && !drop[String(s.id)]) out.push(s)
    }
    return out
  }
  const before = S.queue.length
  S.queue = keep(S.queue)
  if (S.shuf) S.shuf = keep(S.shuf)
  const removed = before - S.queue.length
  if (!removed) {
    return { ok: false, removed: 0, skipped: 0, emptied: false, switched: false }
  }

  if (!S.queue.length) {
    clearPlayback('播放列表已清空')
    return { ok: true, removed: removed, skipped: 0, emptied: true, switched: false }
  }

  // 在播曲被删 → 接着放「原来的下一首」
  if (hitCur) {
    const pick = pickAfter(alOld, curIdx, drop)
    const al = activeList()
    let ni = -1
    for (let i = 0; i < al.length; i++) {
      if (al[i] && pick && String(al[i].id) === String(pick.id)) {
        ni = i
        break
      }
    }
    if (ni < 0) ni = 0
    if (wasPlaying) playAt(ni)
    else switchTo(ni)
    log('player', '队列移除 ' + removed + ' 首（含在播曲，剩 ' + S.queue.length + '）→ 接第 ' +
      (ni + 1) + ' 首' + (wasPlaying ? '（继续播放）' : '（暂停中，只换曲）'))
    return { ok: true, removed: removed, skipped: 0, emptied: false, switched: true }
  }

  // 在播曲还在 → index 按它在生效队列里的新位置重算；万一找不到（异常态）就夹紧到合法范围
  
  const al = activeList()
  if (S.cur.id) {
    let ni = -1
    for (let i = 0; i < al.length; i++) {
      if (al[i] && String(al[i].id) === String(S.cur.id)) {
        ni = i
        break
      }
    }
    S.index = ni >= 0 ? ni : Math.min(S.index, Math.max(0, al.length - 1))
  } else {
    S.index = al.length ? Math.min(Math.max(S.index, 0), al.length - 1) : -1
  }
  S.hint = '已移除 ' + removed + ' 首'
  log('player', '队列移除 ' + removed + ' 首（剩 ' + S.queue.length + '）')
  emit()
  persist()
  return { ok: true, removed: removed, skipped: 0, emptied: false, switched: false }
}

/* 把若干首**插到当前曲之后**（「下一首播放」）：不动在播曲、不改队列顺序，按 id 去重（返回 dup 计数）。
 * 两条队列要一起改，否则「下一首」名不副实 —— 随机模式 index 指临时队列 shuf，插在 index+1 才是「马上播」；
 * 原始队列 queue 里则插在在播曲之后（切回顺序模式时顺序仍正确）。
 * 队列为空时没有「下一首」可插 → 直接起播这几首（等价于点歌）。 */
export function insertNext(songs) {
  const add = songs || []
  if (!add.length) return { ok: false, added: 0, dup: 0, played: false }
  if (!S.queue.length) {
    playList(add.slice(), 0)
    log('player', '队列为空，「下一首播放」改为直接起播 ' + add.length + ' 首')
    return { ok: true, added: add.length, dup: 0, played: true }
  }
  const has = {}
  for (let i = 0; i < S.queue.length; i++) {
    if (S.queue[i] && S.queue[i].id != null) has[String(S.queue[i].id)] = 1
  }
  const fresh = []
  let dup = 0
  for (let i = 0; i < add.length; i++) {
    const s = add[i]
    if (!s || s.id == null) continue
    const k = String(s.id)
    if (has[k]) {
      dup++
      continue
    }
    has[k] = 1
    fresh.push(s)
  }
  if (!fresh.length) return { ok: true, added: 0, dup: dup, played: false }

  // 原始队列：插在在播曲之后（在播曲不在队列里就插队首）
  let qi = 0
  if (S.cur.id) {
    for (let i = 0; i < S.queue.length; i++) {
      if (S.queue[i] && String(S.queue[i].id) === String(S.cur.id)) {
        qi = i + 1
        break
      }
    }
  }
  S.queue = S.queue.slice(0, qi).concat(fresh).concat(S.queue.slice(qi))
  if (inShuffle()) {
    const si = S.index >= 0 && S.index < S.shuf.length ? S.index + 1 : 0
    S.shuf = S.shuf.slice(0, si).concat(fresh).concat(S.shuf.slice(si))
  }
  S.hint = '已插入下一首：' + (fresh[0].name || '')
  log('player', '插入下一首 ' + fresh.length + ' 首（重复 ' + dup + '）队列 ' + S.queue.length)
  emit()
  persist()
  return { ok: true, added: fresh.length, dup: dup, played: false }
}

// 后台补齐起播时记下这个代次，见 appendToQueue
export function queueToken() {
  return S.qgen
}

/* 把若干首**追加到队尾**（大歌单「先起播、后补齐」用）。
 * opts.gen 是起播时 queueToken() 的值：对不上说明用户已经换了队列，这批歌不属于当前播放内容 → 丢弃（stale），
 * 否则会把上一份列表的歌塞进新队列；队列已空（用户清空过）同样丢弃，不擅自起播。
 * 随机模式下临时队列也追加在尾部，当前这一轮的播放路径不变。 */
export function appendToQueue(songs, opts) {
  const add = songs || []
  const gen = opts && typeof opts.gen === 'number' ? opts.gen : null
  if (gen !== null && gen !== S.qgen) {
    return { ok: false, added: 0, dup: 0, stale: true, total: S.queue.length }
  }
  if (!add.length) return { ok: true, added: 0, dup: 0, stale: false, total: S.queue.length }
  if (!S.queue.length) return { ok: false, added: 0, dup: 0, stale: true, total: 0 }
  const has = {}
  for (let i = 0; i < S.queue.length; i++) {
    if (S.queue[i] && S.queue[i].id != null) has[String(S.queue[i].id)] = 1
  }
  const fresh = []
  let dup = 0
  for (let i = 0; i < add.length; i++) {
    const s = add[i]
    if (!s || s.id == null) continue
    const k = String(s.id)
    if (has[k]) {
      dup++
      continue
    }
    has[k] = 1
    fresh.push(s)
  }
  if (!fresh.length) return { ok: true, added: 0, dup: dup, stale: false, total: S.queue.length }
  S.queue = S.queue.concat(fresh)
  if (S.shuf) S.shuf = S.shuf.concat(fresh)
  log('player', '队列追加 ' + fresh.length + ' 首（重复 ' + dup + '）队列 ' + S.queue.length)
  emit()
  persist()
  return { ok: true, added: fresh.length, dup: dup, stale: false, total: S.queue.length }
}