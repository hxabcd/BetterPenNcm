// 播放器（拆分自 player.js）：倍速与循环模式的设置读写。

import config from '../../core/infra/config.js'
import { log } from '../../core/infra/log.js'
import { MODES } from './player-modes.js'
import { persist } from './player-persist.js'
import { reopenAt } from './player-play.js'
import { buildShuffle } from './player-shuffle.js'
import { S, emit } from './player-state.js'


// 改倍速：按当前位置用当前源重开（playFile 第三参数，在线倍速实测可用）
export async function setRate(r) {
  const v = typeof r === 'number' ? r : parseFloat(r)
  if (!v || v <= 0) return
  S.rate = v
  await config.set('rate', v)
  log('player', '倍速 -> ' + v)
  if (!S.cur.id || S.paused) {
    emit()
    return
  }
  await reopenAt(S.positionMs, '倍速 ' + v + 'x')
}

// 切循环模式：进出随机**只重排播放顺序、不动正在放的歌**（不重开播放，只挪 index）
export async function setLoopMode(key) {
  for (let i = 0; i < MODES.length; i++) {
    if (MODES[i].key === key) {
      const prev = S.loopMode
      S.loopMode = key
      if (key === 'shuffle') {
        S.shuf = null
        if (buildShuffle(S.cur.id ? S.cur : null)) S.index = 0
      } else if (prev === 'shuffle') {
        S.shuf = null
        if (S.cur.id) {
          for (let k = 0; k < S.queue.length; k++) {
            if (S.queue[k].id === S.cur.id) {
              S.index = k
              break
            }
          }
        }
      }
      await config.set('loopMode', key)
      S.hint = '模式：' + MODES[i].label
      log('player', '循环模式 -> ' + key + (key === 'shuffle' ? '（重洗 ' + S.queue.length + ' 首）' : ''))
      emit()
      persist() 
      return
    }
  }
}

export async function cycleLoopMode() {
  let i = 0
  for (let k = 0; k < MODES.length; k++) {
    if (MODES[k].key === S.loopMode) i = k
  }
  await setLoopMode(MODES[(i + 1) % MODES.length].key)
}

export function loadPlayerSettings() {
  const r = config.get('rate')
  if (typeof r === 'number' && r > 0) S.rate = r
  const m = config.get('loopMode')
  for (let i = 0; i < MODES.length; i++) {
    if (MODES[i].key === m) S.loopMode = m
  }
  log('player', '设置恢复 rate=' + S.rate + ' mode=' + S.loopMode)
}