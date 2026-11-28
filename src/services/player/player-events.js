// 播放器（拆分自 player.js）：媒体事件订阅与实参形状的容错解析。

import { log } from '../../core/infra/log.js'
import { bindEvents } from './sound.js'
import { persist } from './player-persist.js'
import { requestEnd } from './player-play.js'
import { NEAR_END_MS, S, activeList, emit, stopTimer } from './player-state.js'
 

/* 媒体事件：SoundPlayer 是全系统单例 —— 事件全服务广播（别的应用/服务在播什么也会收到），
 * 必须按 playFile 返回的 uuid 过滤，再叠加「正在播 && 非暂停」守卫。
 * 回调形参已实证的是 position 的 (uuid, ms)；End/Duration 的形状未实证 →
 * pickUuid 容忍式解析 + 每种事件首次打一条带实参的形状日志。
 * ⚠ 事件 20~25 条/秒：回调里禁止打日志（log 每条一次 HTTP POST），也不要 emit
 *   （显示仍由 500ms tick 输出，这里只重锚墙钟）。 */
const shapeSeen = {} 

function pickUuid(args) {
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === 'string' && /^[0-9a-f]{8,}$/.test(args[i])) return args[i]
  }
  return ''
}

function lastNum(args) {
  for (let i = args.length - 1; i >= 0; i--) {
    const n = Number(args[i])
    if (isFinite(n)) return n
  }
  return NaN
}

function firstShape(name, args) {
  if (shapeSeen[name]) return
  shapeSeen[name] = 1
  let s = ''
  for (let i = 0; i < args.length; i++) {
    s += (i ? ', ' : '') + typeof args[i] + ':' + String(args[i]).slice(0, 40)
  }
  log('player', '事件形状 ' + name + ' [' + s + ']')
}

// 位置事件：只重锚墙钟（显示由 tick 输出）；首个事件顺带清「缓冲中...」（≈ 真的出声了）
function onPos() {
  const args = arguments
  firstShape('position', args)
  const u = pickUuid(args)
  const ms = lastNum(args)
  if (!u || String(u) !== String(S.uuid)) return
  if (!S.isPlaying || S.paused) return
  if (!isFinite(ms) || ms < 0) return
  S.positionMs = ms
  S.baseMs = ms
  S.startedAt = Date.now()
  if (S.status === '缓冲中...') S.status = ''
}

function onDur() {
  const args = arguments
  firstShape('duration', args)
  const u = pickUuid(args)
  const v = Math.round(lastNum(args) || 0)
  if (u) {
    if (!S.uuid || String(u) !== String(S.uuid)) return
  } else if (!S.isPlaying || S.paused) return
  if (!(v > 0)) return

  // 合理性窗：已知时长时只接受 0.5x~2x 内的值（防「剩余时长」类误报把进度条顶满）
  if (S.durationMs && (v < S.durationMs * 0.5 || v > S.durationMs * 2)) {
    log('player', '时长事件舍去 id=' + S.cur.id + ' v=' + v + '（现 ' + S.durationMs + '）')
    return
  }
  const changed = Math.abs(v - S.durationMs) > 500
  S.durationMs = v
  if (S.cur.id && S.cur.durationMs !== v) S.cur.durationMs = v 
  const al = activeList()
  for (let i = 0; i < al.length; i++) {
    if (al[i] && String(al[i].id) === String(S.cur.id) && !al[i].durationMs) al[i].durationMs = v
  }
  if (changed) {
    log('player', '时长(事件) id=' + S.cur.id + ' v=' + v)
    emit()
    persist()
  }
}

// 结束事件：临近结尾 = 自然播完；否则是外部 stop（别的应用/服务抢了单例）→ 中断收尾不连播
function onEnd() {
  const args = arguments
  firstShape('end', args)
  const u = pickUuid(args)
  if (u) {
    if (!S.uuid || String(u) !== String(S.uuid)) return
  } else if (!S.isPlaying || S.paused) return
  if (!S.isPlaying || S.paused) return
  S.uuid = '' 
  if (!S.durationMs || S.positionMs >= S.durationMs - NEAR_END_MS) {
    requestEnd()
  } else {
    S.isPlaying = false
    stopTimer()
    S.hint = '播放中断'
    emit()
    persist() 
    log('player', '播放中断(外部停止): ' + S.cur.name + ' @' + Math.round(S.positionMs / 1000) + 's')
  }
}

function onErr() {
  const args = arguments
  firstShape('error', args)
  const u = pickUuid(args)
  if (u) {
    if (!S.uuid || String(u) !== String(S.uuid)) return
  }
  if (!S.isPlaying || S.paused) return
  S.uuid = ''
  S.isPlaying = false
  stopTimer()
  S.hint = '播放出错'
  emit()
  persist()
  log('player', '播放出错(事件): ' + S.cur.name + ' err=' + String(args[args.length - 1]).slice(0, 60))
}

// 进度事件：语义未探明 —— 只留形状日志，不参与逻辑
function onProg() {
  firstShape('progress', arguments)
}

// 事件登记（同步；真正的 .on 在 sound.js 实例创建后自动补挂）
bindEvents({
  mediaPlayerPositionChanged: onPos,
  mediaPlayerDurationChanged: onDur,
  mediaPlayerProgressChanged: onProg,
  mediaPlayerEndChanged: onEnd,
  mediaPlayerEndWithErrorChanged: onErr
})