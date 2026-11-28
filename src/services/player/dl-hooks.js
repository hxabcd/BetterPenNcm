// 媒体源层（拆分自 download.js）：文件变更钩子。
import { log } from '../../core/infra/log.js'

// 删缓存 / 升质重下都会让 player 手里的 localPath 失效（文件没了或换成了新内容），
// player.js 注册钩子清掉对应曲目的 localPath。**在 promise resolve 之前调**，保证随后各调用方写 localPath 的顺序仍然正确
export const fileChangedHooks = []

// 注册钩子：fn(songIdString)。**数组追加**（单槽覆盖会让第二个注册者无声顶掉第一个）；
// 同一函数重复注册会被忽略并记日志（防同一模块挂两遍时回调翻倍）
export function setFileChangedHook(fn) {
  if (typeof fn !== 'function') return
  for (let i = 0; i < fileChangedHooks.length; i++) {
    if (fileChangedHooks[i] === fn) {
      log('dl', 'setFileChangedHook 重复注册（同名函数），已忽略')
      return
    }
  }
  fileChangedHooks.push(fn)
}

export function notifyFileChanged(id) {
  if (!fileChangedHooks.length) return
  for (let i = 0; i < fileChangedHooks.length; i++) {
    try {
      fileChangedHooks[i](String(id))
    } catch (e) {}
  }
}
