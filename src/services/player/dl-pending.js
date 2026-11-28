// 媒体源层（拆分自 download.js）：待续传快照（state 库的 dl_pending 行）与退出收尾。
import { getStorage, setStorage, removeStorage, KEY_DL_PENDING } from '../../core/infra/store.js'
import { stopFetching, resetFetching } from './fetcher.js'
import { log } from '../../core/infra/log.js'
import * as sched from './scheduler.js'
import { st } from './dl-state.js'

const PENDING_MAX = 1000
let pendingMap = null

function slimSong(s) {
  return {
    id: s.id,
    name: s.name || '',
    artist: s.artist || '',
    durationMs: s.durationMs || 0,
    cover: s.cover || ''
  }
}
async function pendingLoad() {
  if (pendingMap) return pendingMap
  pendingMap = {}
  try {
    const raw = await getStorage(KEY_DL_PENDING)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i]
          if (it && it.id) pendingMap[String(it.id)] = it
        }
      }
    }
  } catch (e) {}
  return pendingMap
}

export async function pendingAdd(list, qk, mode) {
  if (!list || !list.length) return
  const map = await pendingLoad()
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    if (!s || !s.id) continue
    map[String(s.id)] = Object.assign(slimSong(s), { q: qk || '', origin: mode, at: Date.now() })
  }
  const arr = Object.keys(map).map(function (k) { return map[k] })
  if (arr.length > PENDING_MAX) {
    arr.sort(function (a, b) { return (b.at || 0) - (a.at || 0) })
    arr.length = PENDING_MAX
  }
  try {
    await setStorage(KEY_DL_PENDING, JSON.stringify(arr))
  } catch (e) {}
}

// 队列正常结束/用户取消时清空；退出时保留（下次启动续传）
export async function pendingClear() {
  pendingMap = null
  try {
    await removeStorage(KEY_DL_PENDING)
  } catch (e) {}
}

// 一批正常结束/被用户取消：只摘掉**这一批**的 id，不碰别的批次留下的待续传项
// （例如上次被强杀的旧队列还没开始续传时，用户又手动下了一首）
export async function pendingDrop(list) {
  if (!list || !list.length) return
  const map = await pendingLoad()
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id) delete map[String(list[i].id)]
  }

  // 还有别的批次在跑：把它们留在 map 里（下一次 pendingAdd 会合并写）
  if (st.activeBatches > 0) return
  const arr = Object.keys(map).map(function (k) { return map[k] })
  if (!arr.length) {
    await pendingClear()
    return
  }
  try {
    await setStorage(KEY_DL_PENDING, JSON.stringify(arr))
  } catch (e) {}
}
/* 退出前收尾（index.vue 的退出链调用）：① 取消批量队列（未开始的结算为 cancelled）
 * ② 清播放通道排队项，别在退出过程中再起新的缓存下载 ③ 杀掉正在写的 curl（fetcher 按 .part 路径 pkill）
 * ④ 最多等 800ms 让当前项落地（.part 保留，下次续传）。**不清 dl_pending** —— 下次启动据此续传 */
export async function stopForExit() {
  if (st.exiting) return
  st.exiting = true
  try { sched.cancelDownload() } catch (e) {}
  try { sched.abortPlayQueue() } catch (e) {}
  try { await stopFetching() } catch (e) {}
  let idle = false
  try { idle = await sched.waitIdle(800) } catch (e) {}

  // 收尾后仍有未完成的：任务已按 cancelled 结算，.part 与 dl_pending 留给下次
  log('dl', '退出前停止下载（' + (idle ? '已收尾' : '超时，残片保留') + '）')
}

// closeApp 失败（应用还活着）时复位退出标志，别让本次进程内的下载永久不可用
export function resetExit() {
  st.exiting = false
  try {
    resetFetching()
  } catch (e) {}
}
