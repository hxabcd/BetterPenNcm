// 播放器（拆分自 player.js）：会话快照的组装与落盘（session.js 负责实际的串行合并写）。

import { log } from '../../core/infra/log.js'
import { load as loadSession, save as saveSession, slimQueue, slimShuffle, slimSong } from './session.js'
import { buildShuffle, rebuildShuffle } from './player-shuffle.js'
import { S, activeList, emit, inShuffle, stopTimer } from './player-state.js'


function snapshotRecord(posOverride) {
  if (!S.cur.id) return null
  const song = slimSong(S.cur)
  if (!song) return null

  // 快照里的 queue 始终是**原始队列**；随机模式下 index 指的是临时队列里的位置，
  // 得先按 id 在原始队列里找回当前曲（找不到就沿用 index 并夹紧，别让窗口算飞）
  
  let qi = S.index
  if (inShuffle()) {
    qi = -1
    for (let k = 0; k < S.queue.length; k++) {
      if (S.queue[k].id === S.cur.id) {
        qi = k
        break
      }
    }
    if (qi < 0) qi = S.index >= 0 ? Math.min(S.index, S.queue.length - 1) : 0
  }
  const q = slimQueue(S.queue, qi)
  let pos = typeof posOverride === 'number' ? posOverride : S.positionMs
  pos = Math.max(0, Math.round(pos || 0))
  const rec = {
    v: 1,
    at: Date.now(),
    playing: S.isPlaying && !S.paused, 
    queue: q.list,
    index: q.index,
    song: song,
    positionMs: pos,
    src: S.queueSrc 
  }

  if (inShuffle()) rec.shuffle = slimShuffle(S.shuf, S.index)
  return rec
}

// 立即落盘一次（不节流）。posOverride 显式指定快照位置：切歌瞬间传 0（新歌还没出声，
// 别把上一首的位置记到新歌头上）；「播完停下」传 0（恢复时是重播这首，而不是从末尾立刻结束）
export function persist(posOverride) {
  const rec = snapshotRecord(posOverride)
  if (!rec) return
  S.lastSaveAt = Date.now()
  saveSession(rec)
}

export function flushNow() {
  persist()
}

/* 启动时恢复「上次播放状态」（boot 里 await，幂等）—— 快照由 session.js 落盘。
 * 恢复态**一律暂停**：队列/当前曲/进度都回到内存、首页卡片与播放页立刻显示上次的歌，但不出声；
 * 按 ▶ 才走 toggle() 的续播分支。位置落在末尾 2 秒内的按 0 处理
 * （多半是「快播完时被关机/强杀」，恢复成立刻结束没有意义）。 */
export async function loadLastState() {
  const s = await loadSession()
  if (!s) {
    log('player', '上次播放状态: 无')
    return false
  }
  S.queue = s.queue
  S.queueSrc = s.src || '' 
  S.qgen++
  S.shuf = null

  // 随机模式：按快照存的 id 序列重建临时队列（顺序与退出前一致）；老快照没有该字段、或大歌单窗口
  // 裁得只剩一两首时，退化为「以当前曲为锚点重洗」
  
  if (S.loopMode === 'shuffle') {
    S.shuf = rebuildShuffle(s.shuffle)
    if (S.shuf.length < 2) buildShuffle(s.song)
    log('player', '随机队列重建: ' + S.shuf.length + ' 首（快照 ' +
      ((s.shuffle && s.shuffle.length) || 0) + ' 个 id）')
  }

  // 当前曲在**生效队列**里的位置（随机模式 = 临时队列）
  const list = activeList()
  let i = -1
  for (let k = 0; k < list.length; k++) {
    if (list[k].id === s.song.id) {
      i = k
      break
    }
  }
  if (i < 0) {
    i = s.index
    if (!(i >= 0)) i = 0
    if (i > list.length - 1) i = list.length - 1
  }
  S.index = i
  S.cur = s.song
  S.durationMs = S.cur.durationMs || 0
  let pos = Math.max(0, Math.round(s.positionMs || 0))
  if (S.durationMs && pos > S.durationMs - 2000) pos = 0
  stopTimer()
  S.baseMs = pos
  S.startedAt = Date.now()
  S.positionMs = pos
  S.paused = true
  S.isPlaying = false
  S.loading = false
  S.srcMode = ''
  // 缓存/直链一律现查（reopenAt / playAt），别信上次的快照
  S.localPath = '' 
  S.uuid = ''
  S.status = ''
  S.hint = '上次播放 · 按 ▶ 继续'
  emit()
  log('player', '恢复上次播放: ' + S.cur.name + ' @' + Math.round(pos / 1000) + 's（队列 ' +
    S.queue.length + ' 首，第 ' + (S.index + 1) + ' 首，退出时' + (s.playing ? '在播' : '未在播') + '）')
  return true
}