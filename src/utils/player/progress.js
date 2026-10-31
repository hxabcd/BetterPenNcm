/**
 * 媒体源层之一：下载进度回调转发（从 download.js 拆出，实现零改动）。
 *
 * 用途：同一首歌在下载时可能有多个「搭车方」（播放请求 / 批量请求 / 提权的批量项），
 * 各自的进度回调都挂在这里，由真正在跑的那次下载统一 fire 出去
 * （不然搭车方的界面停在「缓冲中 0%」）。
 */

const progressHooks = {} // id(String) -> [fn(done,total,speed)]

export function addProgressHook(id, fn) {
  if (typeof fn !== 'function') return
  if (!progressHooks[id]) progressHooks[id] = []
  progressHooks[id].push(fn)
}

/** 队列项结算/被顶掉时清掉挂它的进度回调（回调生命周期 = 该 id 这一次下载） */
export function dropProgressHooks(id) {
  delete progressHooks[id]
}

export function fireProgress(id, done, total, speed) {
  const hs = progressHooks[id]
  if (!hs) return
  for (let i = 0; i < hs.length; i++) {
    try {
      hs[i](done, total, speed)
    } catch (e) {}
  }
}
