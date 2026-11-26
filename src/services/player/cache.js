

// 缓存数据层 —— 两条媒体通道（downloads/ 与 cache/）的元数据、枚举、统计与清理。
// 两个音频概念、两个目录、同一套「每 track 一个目录」布局：
//   下载 download = data/downloads/<id>/（下载音质；出现在本地下载页/首页下载卡/播放页下载键；用户主动下，永久保留）
//   缓存 cache    = data/cache/<id>/（播放音质；不出现在任何下载清单；边听边存，受「缓存上限」LRU 滚动）
//   浏览缩略图    = data/cache/thumbs/（不属于任何曲目，可整体清空）
// 元数据在状态库 state.db 的 track_meta / track_lyric，读写都经 media.js；本模块只管内存快照与清理。
// 文件系统为真相、元数据可缺失：readdir 永远准，元数据只负责「显示得好看」与 LRU 排序，缺了不影响功能。
// 容量实测：fs.statfs 返回 {free,total} 但语义可疑（free>total），可用空间一律走 exec df，不可用时回退纯 fs。
import * as media from '../../services/player/media.js'
import { trackDir, trackFile } from '../../core/infra/paths.js'
import { clearCovers } from '../../services/cover/cover.js'
import { clearLocalLibrary } from './localmeta.js'
import { clearAllOrigins } from './dlorigin.js'
import { log } from '../../core/infra/log.js'
import config, { DEFAULTS } from '../../core/infra/config.js'
import { cacheDir, downloadsDir, musicDir, rootOf, thumbsDir } from '../../core/infra/paths.js'
import { fileExists, readNames, statOf } from '../../core/platform/fsutil.js'
import { has, run as shRun } from '../../core/platform/exec.js'
import { ensureRoot } from './files.js'

// 下载根目录的历史导出名（实现 = paths.downloadsDir）；目前 src 内已无引用，保留是为了调用方不必改
export { musicDir }

// 播放缓存目录的历史名（scheduler.js 从这里 import）；实现 = paths.cacheDir
export function playCacheDir() {
  return cacheDir()
}

// 每目录元数据的内存快照工厂（kind = 'download' | 'cache'）；内存只是加速层，状态库 track_meta 才是真相
function makeDirMeta(kind) {
  const mem = {}

  return {
    kind: kind,

    // 预热（元数据已在状态库，无可载）；保留导出是为了让调用点不改
    load: async function () {
      return true
    },
    // 按需把某 id 的 track_meta 读进内存快照；返回记录或 null

    warm: async function (id) {
      const k = String(id)
      const rec = await media.readMeta(k, kind)
      if (rec) mem[k] = rec
      else delete mem[k]
      return rec
    },
    // 同步取一条（未 warm 过时为 null，调用方自会兜底「没有元数据」）

    of: function (id) {
      return mem[String(id)] || null
    },
    // 下载开始时先写「基础元数据」：歌名/歌手/时长/封面 + p（本次档位）+ z（接口给的预期大小）。
    // 为什么在下载**前**写：音频 mv 成正式文件之后、put 之前若应用退出，只留下一条 {p} 行 → 界面上就是「有歌没名字」。
    // **不动 q/b/y**：升级重下时旧文件还在，提前写新档位会让「升级失败」被误判成已升级（旧音频 + 新档位标记）。
    // hadOld = 下载开始时盘上已有完整音频（升级），用于区分「fresh 下载完成但没来得及 put」与「升级下到一半、旧文件还在」。

    begin: async function (song, qk, total, hadOld) {
      if (!song || !song.id) return null
      const k = String(song.id)
      const prev = (await media.readMeta(k, kind)) || mem[k] || {}
      const patch = {
        n: song.name || prev.n || '',
        a: song.artist || prev.a || '',
        d: song.durationMs || prev.d || 0,
        c: song.cover || prev.c || '',
        p: qk || '',
        z: total || prev.z || 0,
        f: hadOld ? 0 : 1,
        t: prev.t || Date.now()
      }
      mem[k] = Object.assign({}, prev, patch)
      const ok = await media.patchMeta(k, kind, patch)
      return ok ? mem[k] : null
    },
    // 写完成态（与库里已有条目合并写：缺的字段保留旧值，别覆盖成空）。br=接口实际码率；type='mp3'|'flac'；q=本次档位 key。
    // p（下载中的档位标记）与 z（预期大小）在这里清掉 —— 下载已完成；返回 {rec, ok}，调用方据此判断元数据是否真的落库。
    // opts.clearBr：码率未知时把 b 清零（完整残片转正用 —— 旧文件的 br 可能属于旧档位）。

    put: async function (song, br, type, q, opts) {
      if (!song || !song.id) return { rec: null, ok: false }
      const k = String(song.id)
      const prev = (await media.readMeta(k, kind)) || mem[k] || {}
      const rec = {
        n: song.name || prev.n || '',
        a: song.artist || prev.a || '',
        b: (opts && opts.clearBr) ? 0 : (br || prev.b || 0),
        y: type || prev.y || 'mp3',
        q: q || prev.q || '',
        d: song.durationMs || prev.d || 0,
        c: song.cover || prev.c || '',
        p: '',
        z: 0,
        f: 0,
        t: Date.now()
      }
      // 缓存表带 lastUsed（LRU 排序键，第一次落盘即算「刚用过」）；下载表保留原有归属/时间字段（patchMeta 本就会合并，显式带上以免快照丢字段）

      
      if (kind === 'cache') rec.u = Date.now()
      else {
        if (prev.u) rec.u = prev.u
        if (prev.origin) rec.origin = prev.origin
        if (prev.addedAt) rec.addedAt = prev.addedAt
      }
      mem[k] = rec
      const ok = await media.patchMeta(k, kind, rec)
      return { rec: rec, ok: ok === true }
    },
    // 只标记「本次下载用的档位」（保留给旧调用点；新代码用 begin）。
    // 用途：续传时判断 .part 残片是不是当前档位留下的 —— 中途改过音质的话，旧档残片必须丢弃，
    // 否则字节接在一起会写出「长度对但内容是垃圾」的文件。

    markPending: async function (id, qk) {
      const k = String(id)
      const prev = (await media.readMeta(k, kind)) || mem[k] || {}
      prev.p = qk || ''
      prev.t = prev.t || Date.now()
      mem[k] = prev
      await media.patchMeta(k, kind, { p: prev.p, t: prev.t })
      return prev
    },
    drop: async function (id) {
      const k = String(id)
      delete mem[k]
      // 只删库里那条元数据；音频/封面由目录删除负责
      await media.dropMeta(k, kind) 
    },

    // 只清内存快照（目录清空后调用，避免同步查还拿到旧数据）
    clear: async function () {
      const ks = Object.keys(mem)
      for (let i = 0; i < ks.length; i++) delete mem[ks[i]]
    }
  }
}

const dlMeta = makeDirMeta('download')
const pcMeta = makeDirMeta('cache')

export const loadMeta = dlMeta.load
export const metaOf = dlMeta.of
export const beginMeta = dlMeta.begin
export const putMeta = dlMeta.put
export const markPending = dlMeta.markPending
export const dropMeta = dlMeta.drop
export const clearMeta = dlMeta.clear

// 按需把某首的 track_meta 读进内存快照（查盘前调；可能读库）
export const warmMeta = dlMeta.warm

export const loadPlayMeta = pcMeta.load
export const playMetaOf = pcMeta.of
export const beginPlayMeta = pcMeta.begin
export const putPlayMeta = pcMeta.put
export const dropPlayMeta = pcMeta.drop
export const clearPlayMeta = pcMeta.clear
export const warmPlayMeta = pcMeta.warm

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

// 把 media.listTracks 的条目归一成页面要的 Song 行（字段名与旧 listDir 完全一致）；meta 可能为 null（track_meta 缺失）→ 给默认值
function toRow(it) {
  const m = it.meta || null
  return {
    id: it.id,
    ext: it.ext || 'mp3',
    size: it.size || 0,
    mtime: it.mtime || 0,
    path: it.path || '',
    name: (m && m.n) || '',
    artist: (m && m.a) || '',
    br: (m && m.b) || 0,

    // 档位 key / 时长 / 封面 url（旧条目可能没有：给默认值，调用方兜底）
    qualityKey: (m && m.q) || '',
    durationMs: (m && m.d) || 0,
    cover: (m && m.c) || '',
    usedAt: (m && m.u) || 0
  }
}

// 列一条通道下的全部曲目（**按目录扫**：一个 id 一条记录，两种扩展名不会各成一条）
async function listDir(kind) {
  const list = await media.listTracks(kind)
  const out = []
  for (let i = 0; i < list.length; i++) {
    // 没有完整音频：不算这一条
    if (!(list[i].size > 0)) continue 
    out.push(toRow(list[i]))
  }
  return out
}

// 已下载歌曲清单（本地下载页用）
export async function listSongs() {
  return listDir('download')
}

// 播放缓存清单（LRU 滚动 / 缓存列表从这里取）
export async function listPlayCache() {
  return listDir('cache')
}

// 目录统计（下载 / 播放缓存 / 封面缩略图各 {count, bytes}）。
// 走 exec 一次调用（三条路径各一个 du -sk + 曲目目录计数）：逐目录 stat 在几百首时是几百次原生调用，du 一次 fork 就够。
// **计数口径**：songs/cache 只数「数字目录 + 里面有非空 track.mp3/flac」——.part 残片不算，cache/thumbs/ 不算（它不是曲目）；
// cache/thumbs/ 是浏览缩略图，单独算 covers，并从 cache 字节里扣掉（新布局下它在 cache/ 里面，du 会把两部分算在一起）。
// 与 listSongs/listPlayCache 的差别只在「1~30KB 的残次文件」：shell 侧只判非空，列表侧按 media.MIN_AUDIO_BYTES 判可播。
export async function stats() {
  const res = {
    // 下载（downloads/）
    songs: { count: 0, bytes: 0 }, 
    // 播放缓存（cache/，不含 thumbs/）
    cache: { count: 0, bytes: 0 }, 
    // 浏览缩略图（cache/thumbs/）
    covers: { count: 0, bytes: 0 } 
  }
  const okExec = await has('du')
  if (okExec) {
    try {
      const M = downloadsDir()
      const P = cacheDir()
      const C = thumbsDir()

      // 曲目计数：只数「数字目录 + 有非空 track.mp3/flac」，两种扩展名只计一次
      const trackCount = function (dir) {

        // 文件名从 paths.trackFile 取（扩展名集合 = media.AUDIO_EXT），别在这里重写一遍
        const hasAudio = media.AUDIO_EXT.map(function (ext) {
          const p = trackFile('0', ext)
          return '[ -s "$d/' + p.slice(p.lastIndexOf('/') + 1) + '" ]'
        }).join(' || ')
        return 'for d in "' + dir + '"/*/; do [ -d "$d" ] || continue; ' +
          'b=${d%/}; b=${b##*/}; case "$b" in ""|*[!0-9]*) continue; esac; ' +
          'if ' + hasAudio + '; then n=$((n+1)); fi; done'
      }
      const fileCount = function (dir) {
        return 'for f in "' + dir + '"/*; do [ -f "$f" ] && n=$((n+1)); done'
      }
      const one = function (tag, dir, isTrack) {
        return 'n=0; ' + (isTrack ? trackCount(dir) : fileCount(dir)) + '; ' +
          'echo "' + tag + ':$n:$(du -sk "' + dir + '" 2>/dev/null | cut -f1)"; '
      }
      // tag -> KB
      const kb = {} 
      {
        const r = await shRun(one('S', M, true) + one('P', P, true) + one('C', C, false), 20000)
        const lines = String((r && r.stdout) || '').split('\n')
        for (let i = 0; i < lines.length; i++) {
          // 目录不存在时 du 的 KB 列是空串（真机实测），第三段允许空

          const m = /^([SPC]):(\d+):(\d*)\s*$/.exec(lines[i].trim())
          if (!m) continue
          const count = parseInt(m[2], 10) || 0
          kb[m[1]] = parseInt(m[3], 10) || 0
          if (m[1] === 'S') res.songs.count = count
          else if (m[1] === 'P') res.cache.count = count
          else res.covers.count = count
        }
      }

      // cache 的 du 含 thumbs 子目录：扣掉，两条通道的字节才互不重叠
      const thumbsKb = kb.C || 0
      const cacheKb = Math.max((kb.P || 0) - thumbsKb, 0)
      res.covers.bytes = thumbsKb * 1024
      res.cache.bytes = cacheKb * 1024
      res.songs.bytes = (kb.S || 0) * 1024
      return res
    } catch (e) {
      log('cache', 'exec 统计失败: ' + ((e && e.message) || e))
    }
  }

  // 回退：fs 逐目录（慢但不失败）
  res.songs = await media.dirStats('download')
  res.cache = await media.dirStats('cache')
  {
    const dir = thumbsDir()
    const names = await readNames(dir)
    let bytes = 0
    for (let i = 0; i < names.length; i++) {
      const st = await statOf(dir + '/' + names[i])
      bytes += (st && st.size) || 0
    }
    res.covers = { count: names.length, bytes: bytes }
  }
  return res
}

// /userdisk 可用字节（exec df；不可用时 0）
export async function freeBytes() {
  const okExec = await has('df')
  if (!okExec) return 0
  try {
    const r = await shRun("df -k /userdisk 2>/dev/null | tail -1 | awk '{print $4}'", 10000)
    const kb = parseInt(String((r && r.stdout) || '').trim(), 10)
    return isNaN(kb) ? 0 : kb * 1024
  } catch (e) {
    return 0
  }
}

// 清空**下载**通道：逐目录删 downloads/ 下每个曲目目录（音频 + 封面 + 歌词 + 元数据一次走），再清空快照、本地库索引与下载归属标记。
// **调用方负责先 player.stop()**（不在这里 import player，避免循环依赖）；返回删除前的 {count, bytes} 供 UI 提示。
// 为什么逐目录删而不是 rm -rf downloads/：那会把根目录本身删掉，后续写入要么失败要么靠调用方记得重建。
export async function clearSongs() {
  let before = { count: 0, bytes: 0 }
  try {
    const s = await stats()
    before = s.songs
  } catch (e) {}
  const n = await wipeTrackDirs('download')
  await clearMeta()
  await ensureRoot('download')
  try {
    // 本地库（索引 + 歌词）随下载目录一起清（localmeta.js）
    await clearLocalLibrary() 
  } catch (e) {}
  try {
    // 下载归属标记（单曲/歌单批量，dlorigin.js）
    await clearAllOrigins() 
  } catch (e) {}
  log('cache', '清空下载 删 ' + n + ' 个目录，之前 ' + before.count + ' 首/' +
    Math.round(before.bytes / 1048576) + 'MB')
  return { ok: true, removed: before }
}

// 清空**播放缓存**通道（曲目目录逐个删；cache/thumbs/ 浏览缩略图**不在其中**——那是封面缓存，由 clearCoverCache 管，
// 顺手清掉会让所有列表重新下载缩略图）。不必停播：正在放的歌若用的是缓存文件，unlink 后 fd 仍在（Linux 语义），声音不断；
// 但要清 localPath 让 player 下次 seek 重新找文件（download.invalidateLocalPaths 做失效）。
export async function clearPlayCache() {
  let before = { count: 0, bytes: 0 }
  try {
    const s = await stats()
    before = s.cache
  } catch (e) {}
  const n = await wipeTrackDirs('cache')
  await clearPlayMeta()
  await ensureRoot('cache')
  log('cache', '清空播放缓存 删 ' + n + ' 个目录，之前 ' + before.count + ' 首/' +
    Math.round(before.bytes / 1048576) + 'MB')
  return { ok: true, removed: before }
}

// 清空封面缓存（cover.js 内清缩略图文件 + 内存 mem；已缓存曲目的 cover.jpg 随各自目录走）
export async function clearCoverCache() {
  let before = { count: 0, bytes: 0 }
  try {
    const s = await stats()
    before = s.covers
  } catch (e) {}
  const n = await clearCovers()
  log('cache', '清空封面缓存 ' + n + ' 个')
  return { ok: true, removed: before }
}

// 逐目录清一条通道（只清数字命名的曲目目录；cache/thumbs 这类非曲目目录原地不动）。
// 删除走 media.dropTrackDir（内部 fsutil.removeTree = rm -rf，失败回退逐个 fs.rm）。返回删掉的目录数。
async function wipeTrackDirs(kind) {
  const root = rootOf(kind)
  const names = await readNames(root)
  let n = 0
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    if (!name || !/^\d+$/.test(name)) continue
    await media.dropTrackDir(name, kind)
    if (!(await fileExists(trackDir(name, kind)))) n++
  }
  return n
}

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
