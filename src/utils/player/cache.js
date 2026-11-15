/**
 * 缓存数据层 —— 两条媒体通道（downloads/ 与 cache/）的元数据、枚举、统计与清理。
 *
 * **两个音频概念，两个目录，同一套「每 track 一个目录」布局**（契约见 docs/存储重构.md §2）：
 *   | 概念 | 目录 | 音质 | 出现位置 | 生命周期 |
 *   |---|---|---|---|---|
 *   | 下载 download | data/downloads/<id>/ | 「下载音质」 | **本地下载页 / 首页下载卡 / 播放页下载键** | 用户主动下，永久保留，只在用户删时消失 |
 *   | 缓存 cache | data/cache/<id>/ | 「播放音质」 | **不出现**在任何「本地下载」清单里 | 边听边存，受「缓存上限」LRU 滚动，满了按最久未播放先删 |
 *   | 浏览缩略图 | data/cache/thumbs/ | — | — | 可整体清空，不属于任何曲目（cover.js / clearCoverCache） |
 *
 * 元数据：**不再有整表 JSON**，每首一条记录在索引库 `local_index.db` 的 `track_meta` 表
 * （{n,a,b,y,q,d,c,origin,addedAt}；缓存多一个 u=lastUsed、p=续传档位标记）：
 *   - 读：media.readMeta（一次 prepare，微秒级）
 *   - 写：media.patchMeta（合并写，单行 upsert）
 *   - 删：随目录一起走（media.dropTrackDir，原生 fs.rm 递归删除）
 *
 * ⚠ 元数据**不写 metadata.json**：平台 `fs` 没有写接口，写文件只能 fork 一次 shell
 *   （真机 92~139ms），而下载一首歌会写它两次、播放打点再写一次 —— 全在播放链路上。
 *
 * 设计原则不变：**文件系统为真相，元数据可缺失**
 *   - 有什么目录（readdir）永远是准的，不维护「索引说有人、文件却没了」的伪真相；
 *   - 元数据只负责「显示得好看」与「LRU 排序」，缺了不影响功能。
 *
 * 容量实测（真机探针）：
 *   - fs.statfs 返回 {free,total} 但语义可疑（free>total），**可用空间一律走 exec df**
 *
 * 所有 shell 走 `process.exec('/bin/sh', ['-c', cmd])`（root；见 运行时API参考 §6）；
 * exec 不可用时回退纯 fs 实现（慢但不失败）。
 */
import * as media from '../media.js'
import { trackDir } from '../paths.js'
import { clearCovers } from '../cover.js'
import { clearLocalLibrary } from './localmeta.js'
import { clearAllOrigins } from './dlorigin.js'
import { log } from '../log.js'
import config from '../config.js'
import { cacheDir, downloadsDir, musicDir, rootOf, thumbsDir } from '../paths.js'
import { fileExists, readNames, statOf } from '../fsutil.js'
import { has, run as shRun } from '../exec.js'
import { ensureRoot } from './files.js'

/* ================= 路径（统一走 utils/paths.js —— 别再各拼各的） ================= */

/** 下载根目录的历史导出名（download.js / 页面沿用旧名；实现 = paths.downloadsDir） */
export { musicDir }

/** 播放缓存目录的历史名（download.js 从这里 import）；实现 = paths.cacheDir */
export function playCacheDir() {
  return cacheDir()
}

/* ================= 元数据（每曲目录一份 metadata.json，两个通道各一套语义） =================
 * 导出名与返回结构保持与「整表 JSON」时期一致：metaOf(id) 同步取一条、loadMeta() 预热。
 * 但存储已从「一张表」变成「每目录一份文件」，所以：
 *   - loadMeta/loadPlayMeta 保留（调用点多，且它是「可以开始查了」的语义；现在无表可载）
 *   - metaOf/playMetaOf 同步查**内存快照**；快照由 put/markPending 写入，
 *     以及 warm(id) 按需从 metadata.json 回读（download.js 的查盘路径用）
 *   - loadMeta/loadPlayMeta 仍然清一次快照（清空通道后调用方用它做失效）
 */

/**
 * 每目录元数据的内存快照工厂（kind = 'download' | 'cache'）。
 * 内存只是加速层，**盘上的 metadata.json 才是真相**。
 */
function makeDirMeta(kind) {
  const mem = {}

  return {
    kind: kind,
    /** 预热（无表可载；保留导出是为了让调用点不改） */
    load: async function () {
      return true
    },
    /** 按需把某 id 的 metadata.json 读进内存快照；返回记录或 null */
    warm: async function (id) {
      const k = String(id)
      const rec = await media.readMeta(k, kind)
      if (rec) mem[k] = rec
      else delete mem[k]
      return rec
    },
    /** 同步取一条（未 warm 过时为 null，调用方自会兜底「没有元数据」） */
    of: function (id) {
      return mem[String(id)] || null
    },
    /**
     * 写入（与盘上已有条目**合并写**：新快照缺的字段保留旧值，别覆盖成空）。
     * br=接口实际码率；type='mp3'|'flac'；q=本次档位 key（升级判定用）。
     * `p`（下载中的档位标记）在这里清掉 —— 下载已完成，残片认定到此为止。
     */
    put: async function (song, br, type, q) {
      if (!song || !song.id) return null
      const k = String(song.id)
      const prev = (await media.readMeta(k, kind)) || mem[k] || {}
      const rec = {
        n: song.name || prev.n || '',
        a: song.artist || prev.a || '',
        b: br || prev.b || 0,
        y: type || prev.y || 'mp3',
        q: q || prev.q || '',
        d: song.durationMs || prev.d || 0,
        c: song.cover || prev.c || '',
        p: '',
        t: Date.now()
      }
      // 缓存表带 lastUsed（LRU 排序键，第一次落盘即算「刚用过」）；
      // 下载表保留原有归属/时间字段（patchMeta 本就会合并，这里显式带上以免快照丢字段）
      if (kind === 'cache') rec.u = Date.now()
      else {
        if (prev.u) rec.u = prev.u
        if (prev.origin) rec.origin = prev.origin
        if (prev.addedAt) rec.addedAt = prev.addedAt
      }
      mem[k] = rec
      await media.patchMeta(k, kind, rec)
      return rec
    },
    /**
     * 标记「本次下载用的档位」（下载一开始就写；成功后 put 会清掉）。
     * 用途：续传时判断 `.part` 残片是不是当前档位留下的 —— 中途改过音质的话，
     * 旧档残片必须丢弃，否则字节接在一起会写出「长度对但内容是垃圾」的文件。
     */
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
      await media.dropMeta(k, kind) // 只删库里那条元数据；音频/封面由目录删除负责
    },
    /** 只清内存快照（目录清空后调用，避免同步查还拿到旧数据） */
    clear: async function () {
      const ks = Object.keys(mem)
      for (let i = 0; i < ks.length; i++) delete mem[ks[i]]
    }
  }
}

const dlMeta = makeDirMeta('download')
const pcMeta = makeDirMeta('cache')

/* ---- 下载元数据（历史导出名保持不变，语义就是「用户下载」） ---- */
export const loadMeta = dlMeta.load
export const metaOf = dlMeta.of
export const putMeta = dlMeta.put
export const markPending = dlMeta.markPending
export const dropMeta = dlMeta.drop
export const clearMeta = dlMeta.clear
/** 按需把某首的 metadata.json 读进内存快照（查盘前调；可能读盘） */
export const warmMeta = dlMeta.warm

/* ---- 播放缓存元数据 ---- */
export const loadPlayMeta = pcMeta.load
export const playMetaOf = pcMeta.of
export const putPlayMeta = pcMeta.put
export const markPlayPending = pcMeta.markPending
export const dropPlayMeta = pcMeta.drop
export const clearPlayMeta = pcMeta.clear
export const warmPlayMeta = pcMeta.warm

/* ================= 元数据：缓存「最近使用」时间（LRU 排序键） ================= */

let touchTimer = null
const touched = {} // id(String) -> true（攒一批，400ms 合并写盘）

/**
 * 记一次「这首歌被播放了」（播放器在真正出声的分支调）——「缓存上限」LRU 的排序键，
 * 满了先淘汰最久没播的。**只更新已存在的条目**（还没 metadata.json 说明这首还没缓存完，
 * 等写入时给初值）。写盘做成 ~400ms 合并写（连点切歌别反复写文件，一次写 ≈50ms）。
 *
 * 内存快照可能是空的（刚启动、这首还没进过 put 路径）→ 这里**异步**从盘上补读一次
 * 再决定要不要记。硬性要求是同步返回（播放器事件回调里不能 await），所以补读走
 * 无人等待的 promise；补到了就按同一套 400ms 合并写落盘。
 */
export function touchPlayMeta(id) {
  if (!id) return
  const k = String(id)
  const rec = pcMeta.of(k)
  if (rec) {
    rec.u = Date.now()
    markTouched(k)
    return
  }
  // 快照里没有：可能只是没预热过（metadata.json 在盘上）→ 补读一次再打点
  pcMeta.warm(k).then(function (got) {
    if (!got) return // 真的没有（这首还没缓存完）：等 put 时给初值
    got.u = Date.now()
    markTouched(k)
  }).catch(function () {})
}

/** 记进「待合并写」集合并起一个 400ms 的合并写定时器 */
function markTouched(k) {
  touched[k] = true
  if (touchTimer) return
  touchTimer = setTimeout(function () {
    touchTimer = null
    flushTouched()
  }, 400)
}

/** 合并写：把攒下的 u 一次写进各自的 metadata.json（失败只记日志） */
async function flushTouched() {
  const ids = Object.keys(touched)
  for (let i = 0; i < ids.length; i++) delete touched[ids[i]]
  for (let i = 0; i < ids.length; i++) {
    const rec = pcMeta.of(ids[i])
    if (!rec || !rec.u) continue
    await media.patchMeta(ids[i], 'cache', { u: rec.u })
  }
}

/* ================= 枚举与统计 ================= */

/**
 * 把 media.listTracks 的条目归一成页面要的 Song 行（字段名与旧 listDir 完全一致）。
 * meta 可能为 null（metadata.json 缺失）→ 给默认值，调用方兜底。
 */
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

/**
 * 列一条通道下的全部曲目（**按目录扫**：一个 id 一条记录，两种扩展名不会各成一条）。
 * 目录在但音频缺失/不足 30KB 的条目会被过滤掉 —— 「已下载/已缓存」的定义仍是有可播文件。
 */
async function listDir(kind) {
  const list = await media.listTracks(kind)
  const out = []
  for (let i = 0; i < list.length; i++) {
    if (!(list[i].size > 0)) continue // 没有完整音频：不算这一条
    out.push(toRow(list[i]))
  }
  return out
}

/** 已下载歌曲清单（本地下载页用） */
export async function listSongs() {
  return listDir('download')
}

/** 播放缓存清单（LRU 滚动 / 将来若要看缓存列表都从这里取） */
export async function listPlayCache() {
  return listDir('cache')
}

/**
 * 目录统计（下载 / 播放缓存 / 封面缩略图各 {count, bytes}）。
 *
 * 走 exec 一次调用（三条路径各一个 du -sk + 曲目目录计数）：逐目录 stat 在几百首时是几百次
 * 原生调用，du 一次 fork 就够。**计数口径**：
 *   - songs/cache 只数「数字目录 + 里面有非空 track.mp3/flac」——`.part` 残片不算，
 *     `cache/thumbs/` 不算（它不是曲目）；
 *   - `cache/thumbs/` 是浏览缩略图，单独算 covers，**并从 cache 字节里扣掉**
 *     （新布局下它在 cache/ 里面，du 会把两部分算在一起）。
 *   口径与 `listSongs/listPlayCache` 的差别只在「1~30KB 的残次文件」：
 *   shell 侧只判非空，列表侧按 media.MIN_AUDIO_BYTES 判可播。这种文件只可能来自
 *   「内建 http.download 通道中途失败且没删掉」，实际不会停留（失败即删）。
 * exec 不可用时回退纯 fs。
 */
export async function stats() {
  const res = {
    songs: { count: 0, bytes: 0 }, // 下载（downloads/）
    cache: { count: 0, bytes: 0 }, // 播放缓存（cache/，不含 thumbs/）
    covers: { count: 0, bytes: 0 } // 浏览缩略图（cache/thumbs/）
  }
  const okExec = await has('du')
  if (okExec) {
    try {
      const M = downloadsDir()
      const P = cacheDir()
      const C = thumbsDir()
      // 曲目计数：只数「数字目录 + 有非空 track.mp3/flac」，两种扩展名只计一次
      const trackCount = function (dir) {
        return 'for d in "' + dir + '"/*/; do [ -d "$d" ] || continue; ' +
          'b=${d%/}; b=${b##*/}; case "$b" in ""|*[!0-9]*) continue; esac; ' +
          'if [ -s "$d/track.mp3" ] || [ -s "$d/track.flac" ]; then n=$((n+1)); fi; done'
      }
      const fileCount = function (dir) {
        return 'for f in "' + dir + '"/*; do [ -f "$f" ] && n=$((n+1)); done'
      }
      const one = function (tag, dir, isTrack) {
        return 'n=0; ' + (isTrack ? trackCount(dir) : fileCount(dir)) + '; ' +
          'echo "' + tag + ':$n:$(du -sk "' + dir + '" 2>/dev/null | cut -f1)"; '
      }
      const kb = {} // tag -> KB
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

/** /userdisk 可用字节（exec df；不可用时 0） */
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

/* ================= 清理 ================= */

/**
 * 清空**下载**通道：删掉 downloads/ 下每个曲目目录（音频 + 封面 + 歌词 + 元数据一次走），
 * 再清空下载元数据快照、本地库索引与下载归属标记。
 * **调用方负责先 player.stop()**（不在这里 import player，避免循环依赖）。
 * 返回删除前的 {count, bytes} 供 UI 提示。
 *
 * 为什么逐目录删而不是 `rm -rf downloads/`：那会把根目录本身删掉，
 * 后续写入要么失败要么靠调用方记得重建。逐目录删完再确保根目录在，删完立刻可写。
 */
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
    await clearLocalLibrary() // 本地库（索引 + 歌词）随下载目录一起清（localmeta.js）
  } catch (e) {}
  try {
    await clearAllOrigins() // 下载归属标记（单曲/歌单批量，dlorigin.js）
  } catch (e) {}
  log('cache', '清空下载 删 ' + n + ' 个目录，之前 ' + before.count + ' 首/' +
    Math.round(before.bytes / 1048576) + 'MB')
  return { ok: true, removed: before }
}

/**
 * 清空**播放缓存**通道（曲目目录逐个删；`cache/thumbs/` 浏览缩略图**不在其中**——
 * 那是封面缓存，由 clearCoverCache 管，顺手清掉会让所有列表重新下载缩略图）。
 * 不必停播：正在放的歌若用的是缓存文件，unlink 后 fd 仍在（Linux 语义），声音不断；
 * 但要清 localPath 让 player 下次 seek 重新找文件（download.invalidateLocalPaths 做失效）。
 */
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

/** 清空封面缓存（cover.js 内清缩略图文件 + 内存 mem；已缓存曲目的 cover.jpg 随各自目录走） */
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

/**
 * 逐目录清一条通道（只清数字命名的曲目目录；`cache/thumbs` 这类非曲目目录原地不动）。
 * 删除走 media.dropTrackDir（内部 fsutil.removeTree = rm -rf，失败回退逐个 fs.rm）。
 * 返回删掉的目录数。
 */
async function wipeTrackDirs(kind) {
  const root = rootOf(kind)
  const names = await readNames(root)
  let n = 0
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    if (!name || !/^\d+$/.test(name)) continue
    await media.dropTrackDir(name, kind)
    if (!(await fileExists(root + '/' + name))) n++
  }
  return n
}

/* ================= 「缓存上限」与 LRU 滚动 ================= */

/** 缓存上限（字节）；0 = 不限。设置页写 config.cacheLimitMb（默认 1024 = 1G）。 */
export function cacheLimitBytes() {
  const mb = Number(config.get('cacheLimitMb'))
  if (!mb || isNaN(mb) || mb <= 0) return 0
  return Math.round(mb * 1048576)
}

/* 保护名单钩子：player.js 注册，返回「正在播放 / 不能被回收」的 id 数组。
 * 架构优化：单槽覆盖 → 数组追加（多注册者共存；同一函数重复注册忽略并记日志）。 */
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

/** 汇总所有注册者交出的保护名单（去重后的 id 字符串数组） */
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

/**
 * 扫缓存通道（**按目录**：一个 id 一份，两种扩展名合并成一条）。
 * 走 media.listTracks（原生 readdir + stat，不 fork；thumbs/ 等非数字目录自动跳过）。
 * 返回 [{id, size, mtime, meta}]（排序时间由调用方补：元数据 u/t → 目录 mtime 兜底）
 */
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

/**
 * 执行「缓存上限」滚动（LRU）：总量超出上限时，从**最久没被播放**的开始删，
 * 直到落到上限以内。返回 {ok, removed, freed, total, limit, skipped?}。
 *
 * 排序键：metadata.json 的 u（最近一次播放）→ t（写入时间）→ 目录 mtime（兜底，
 * 处理「元数据丢了但文件还在」的老条目）。
 * 删一首 = 删整个 `<id>/` 目录（音频 + cover.jpg + metadata.json 一起走）。
 * 保护：player.js 通过 setCacheProtectHook 交出正在播放的 id，**绝不删在放的那首**。
 *
 * 调用时机（都由 download.js / 设置页触发，页面不直接调）：
 *   - 播放缓存写入成功后（增量就在这里，趁热判断）
 *   - 设置页改了「缓存上限」之后
 */
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

  items.sort(function (a, b) {
    return a.at - b.at
  }) // 旧 → 新
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
