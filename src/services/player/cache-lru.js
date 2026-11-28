import * as media from '../../services/player/media.js'
import { trackDir } from '../../core/infra/paths.js'
import { log } from '../../core/infra/log.js'
import config, { DEFAULTS } from '../../core/infra/config.js'
import { fileExists } from '../../core/platform/fsutil.js'
import { pcMeta, dropPlayMeta } from './cache-meta.js'

// 缓存上限（MB）；0 = 不限。设置页写 config.cacheLimitMb。
// 0 是合法值，所以只把「未设置 / 非法」回落成默认（DEFAULTS），不能用 `|| 0` 兜 —— 那会把默认混成不限。
export function cacheLimitMb() {
  const raw = Number(config.get('cacheLimitMb'))
  const mb = isNaN(raw) ? DEFAULTS.cacheLimitMb : raw
  return mb > 0 ? mb : 0
}

// 缓存上限（字节）；0 = 不限
export function cacheLimitBytes() {
  return Math.round(cacheLimitMb() * 1048576)
}

// 保护名单钩子：player.js 注册，返回「正在播放 / 不能被回收」的 id 数组（多注册者共存；同一函数重复注册忽略并记日志）
const protectHooks = []
export function setCacheProtectHook(fn) {
  if (typeof fn !== 'function') return
  for (let i = 0; i < protectHooks.length; i++) {
    if (protectHooks[i] === fn) {
      log('cache', 'setCacheProtectHook 重复注册（同名函数），已忽略')
      return
    }
  }
  protectHooks.push(fn)
}

// 汇总所有注册者交出的保护名单（去重后的 id 字符串数组）
function collectProtected() {
  const out = []
  const seen = {}
  for (let i = 0; i < protectHooks.length; i++) {
    let ids = []
    try {
      ids = protectHooks[i]() || []
    } catch (e) {
      ids = []
    }
    for (let j = 0; j < ids.length; j++) {
      const k = String(ids[j])
      if (k && !seen[k]) {
        seen[k] = 1
        out.push(k)
      }
    }
  }
  return out
}

// 扫缓存通道（**按目录**：一个 id 一份，两种扩展名合并成一条）。
// 走 media.listTracks（原生 readdir + stat，不 fork；thumbs/ 等非数字目录自动跳过）。返回 [{id, size, mtime, meta}]
async function scanPlayCache() {
  const list = await media.listTracks('cache')
  const out = []
  for (let i = 0; i < list.length; i++) {
    if (!(list[i].size > 0)) continue
    out.push({
      id: list[i].id,
      size: list[i].size,
      mtime: list[i].mtime || 0,
      meta: list[i].meta
    })
  }
  return out
}

// 执行「缓存上限」滚动（LRU）：总量超出上限时，从**最久没被播放**的开始删，直到落到上限以内。
// 排序键：track_meta 的 u（最近一次播放）→ t（写入时间）→ 目录 mtime（兜底，处理「元数据丢了但文件还在」的老条目）。
// 删一首 = 删整个 <id>/ 目录（音频 + cover.jpg 一起走；track_meta 行由 media.dropTrackDir 同删）。
// 保护：player.js 通过 setCacheProtectHook 交出正在播放的 id，**绝不删在放的那首**。
// 调用时机（都由 download.js / 设置页触发，页面不直接调）：播放缓存写入成功后、设置页改了「缓存上限」之后。
export async function enforceCacheLimit() {
  const limit = cacheLimitBytes()
  if (!limit) return { ok: true, skipped: true, removed: 0, freed: 0, total: 0, limit: 0 }
  const items = await scanPlayCache()
  let total = 0
  const keep = collectProtected()
  for (let i = 0; i < items.length; i++) {
    const meta = items[i].meta || (await pcMeta.warm(items[i].id)) || null
    items[i].at = (meta && (meta.u || meta.t)) || items[i].mtime || 0
    total += items[i].size
  }
  if (total <= limit) return { ok: true, removed: 0, freed: 0, total: total, limit: limit }

  // 旧 → 新
  items.sort(function (a, b) {
    return a.at - b.at
  }) 
  const gone = []
  let freed = 0
  for (let i = 0; i < items.length && total > limit; i++) {
    const it = items[i]
    let protectedIt = false
    for (let j = 0; j < keep.length; j++) {
      if (keep[j] && String(keep[j]) === it.id) protectedIt = true
    }
    if (protectedIt) continue
    await media.dropTrackDir(it.id, 'cache')

    // 目录真没了才算删成功（删不掉就跳过，别把统计数对错）
    if (await fileExists(trackDir(it.id, 'cache'))) continue
    total -= it.size
    freed += it.size
    gone.push(it.id)
    await dropPlayMeta(it.id)
  }
  log('cache', '缓存滚动：删 ' + gone.length + ' 首 / 释放 ' + Math.round(freed / 1048576) +
    'MB → 现 ' + Math.round(total / 1048576) + 'MB（上限 ' + Math.round(limit / 1048576) + 'MB）')
  return { ok: true, removed: gone.length, freed: freed, total: total, limit: limit, ids: gone }
}
