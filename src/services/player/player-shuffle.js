// 播放器（拆分自 player.js）：随机模式的临时队列构造与步进。

import { S } from './player-state.js'


export function buildShuffle(anchor) {
  const anchorId = anchor && anchor.id
  const rest = []
  let head = null
  for (let i = 0; i < S.queue.length; i++) {

    if (!head && anchorId && S.queue[i].id === anchorId) {
      head = S.queue[i]
      continue
    }
    rest.push(S.queue[i])
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = rest[i]
    rest[i] = rest[j]
    rest[j] = t
  }
  S.shuf = head ? [head].concat(rest) : rest
  return !!head
}

export function shuffleNext(from) {
  const n = S.shuf ? S.shuf.length : 0
  if (n === 0) return -1
  if (n === 1) return 0 
  if (from + 1 < n) return from + 1
  const anchored = buildShuffle(S.cur.id ? S.cur : null)
  return anchored ? 1 : 0 
}

export function shufflePrev(from) {
  const n = S.shuf ? S.shuf.length : 0
  if (n === 0) return -1
  if (n === 1) return 0
  return from - 1 >= 0 ? from - 1 : n - 1
}

export function rebuildShuffle(ids) {
  const out = []
  if (!ids || !ids.length) return out
  for (let i = 0; i < ids.length; i++) {
    for (let k = 0; k < S.queue.length; k++) {
      if (S.queue[k].id === ids[i]) {
        out.push(S.queue[k])
        break
      }
    }
  }
  return out
}