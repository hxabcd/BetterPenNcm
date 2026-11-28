import * as media from '../../services/player/media.js'
import { pcMeta } from './cache-meta.js'

let touchTimer = null
// id(String) -> true（攒一批，400ms 合并写盘）
const touched = {} 

// 记一次「这首歌被播放了」（播放器在真正出声的分支调）——「缓存上限」LRU 的排序键，满了先淘汰最久没播的。
// **只更新已存在的条目**（还没有 track_meta 行说明这首还没缓存完，等 put 时给初值）。
// 写盘做成 ~400ms 合并写（一次写 ≈50ms，连点切歌别反复写）。
// 硬性要求同步返回（播放器事件回调里不能 await），所以快照没命中时补读走无人等待的 promise，补到了按同一套合并写落盘。
export function touchPlayMeta(id) {
  if (!id) return
  const k = String(id)
  const rec = pcMeta.of(k)
  if (rec) {
    rec.u = Date.now()
    markTouched(k)
    return
  }

  // 快照里没有：可能只是没预热过（track_meta 在库里）→ 补读一次再打点
  pcMeta.warm(k).then(function (got) {
    // 真的没有（这首还没缓存完）：等 put 时给初值
    if (!got) return 
    got.u = Date.now()
    markTouched(k)
  }).catch(function () {})
}

// 记进「待合并写」集合并起一个 400ms 的合并写定时器
function markTouched(k) {
  touched[k] = true
  if (touchTimer) return
  touchTimer = setTimeout(function () {
    touchTimer = null
    flushTouched()
  }, 400)
}

// 合并写：把攒下的 u 一次写进各自的 track_meta（失败只记日志）
async function flushTouched() {
  const ids = Object.keys(touched)
  for (let i = 0; i < ids.length; i++) delete touched[ids[i]]
  for (let i = 0; i < ids.length; i++) {
    const rec = pcMeta.of(ids[i])
    if (!rec || !rec.u) continue
    await media.patchMeta(ids[i], 'cache', { u: rec.u })
  }
}
