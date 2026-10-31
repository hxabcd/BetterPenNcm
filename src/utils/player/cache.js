/**
 * 缓存数据层 —— 三个目录的元数据、枚举、统计与清理。
 *
 * **两个音频概念，两个目录，两张元数据表**：
 *   | 概念 | 目录 | 音质 | 出现位置 | 生命周期 |
 *   |---|---|---|---|---|
 *   | 下载 download | $dataDir/music | 「下载音质」 | **本地下载页 / 首页下载卡 / 播放页下载键** | 用户主动下，永久保留，只在用户删时消失 |
 *   | 缓存 cache | $dataDir/cache | 「播放音质」 | **不出现**在任何「本地下载」清单里 | 边听边存，受「缓存上限」LRU 滚动，满了按最久未播放先删 |
 *   | 封面 | $dataDir/covers | — | — | 与音频缓存独立 |
 *
 * 元数据表（JSON；落点按体积 × 写频次定，见 utils/filestore.js）：
 *   - 下载元数据 → 文件 `$dataDir/store/cache_meta.json`（41KB 的整表，搬出 preferences.json；
 *     这张表只服务用户下载，对应目录一直是 music/）
 *   - 播放缓存元数据 → 仍走 storage 单 key `bpncm_playcache_meta`（8KB，且 LRU 随播放频繁改；
 *     写 150KB 的 preferences.json ≈ 20ms，写文件要 fork ≈ 50ms，搬出去反而更慢），
 *     条目多一个 `u`（lastUsed，LRU 排序键）。
 *
 * 设计原则：**文件系统为真相，元数据可缺失**
 *   - 有什么文件（readdir）永远是准的，不维护「索引说有人、文件却没了」的伪真相；
 *   - storage 里的元数据表只负责「显示得好看」与「LRU 排序」，缺了不影响功能。
 *
 * 容量实测（真机探针）：
 *   - storage 写 500KB 字符串 65ms、回读一致 → 元数据表（约 80B/首）余量充足
 *   - fs.statfs 返回 {free,total} 但语义可疑（free>total），**可用空间一律走 exec df**
 *
 * 所有 shell 走 `process.exec('/bin/sh', ['-c', cmd])`（root；见 运行时API参考 §6）；
 * exec 不可用时回退纯 fs 实现（慢但不失败）。
 */
import { getStorage, setStorage, removeStorage } from '../store.js'
import { loadTable, saveTable, storePath, removeAt } from '../filestore.js'
import { coversDir, clearCovers } from '../cover.js'
import { clearLocalLibrary } from './localmeta.js'
import { clearAllOrigins } from './dlorigin.js'
import { log } from '../log.js'
import config from '../config.js'
import { cacheDir, musicDir } from '../paths.js'
import { fileExists, readNames, rmQuiet, statOf } from '../fsutil.js'
import { has, run as shRun } from '../exec.js'

/* ---------------- 路径（统一走 utils/paths.js —— 别再各拼各的） ---------------- */

// musicDir 从 paths.js 直接 re-export（历史导出名，download.js 从这里 import）
export { musicDir }

/** 播放缓存目录的历史名（download.js 从这里 import）；实现 = paths.cacheDir */
export function playCacheDir() {
  return cacheDir()
}

/* ---------------- 元数据表（两套实例） ----------------
 * 两套表结构完全一样，只是落点不同、缓存表多记一个 u（lastUsed）：
 *   - 下载元数据（41KB）= 大表 → 落文件 `$dataDir/store/cache_meta.json`（filestore）
 *   - 播放缓存元数据（8KB）= 小表，且 LRU 会随播放频繁改 → **仍走 storage**：
 *     写文件要 fork（≈50ms），写 150KB 的 preferences.json 只要 20ms，搬出去反而慢。
 * 用工厂生成，避免把「load/save/合并写」的逻辑抄两遍抄出偏差。
 */

function makeMetaStore(key, opts) {
  const keepUsed = !!(opts && opts.keepUsed)
  const file = (opts && opts.file) || '' // 非空 = 落文件（大表）
  let mem = null
  let loading = null

  async function load() {
    if (mem) return mem
    if (loading) return loading
    loading = (async function () {
      let obj = {}
      try {
        if (file) obj = (await loadTable(file)) || {}
        else {
          const raw = await getStorage(key)
          if (raw) obj = JSON.parse(raw) || {}
        }
      } catch (e) {
        obj = {}
      }
      mem = obj
      loading = null
      return obj
    })()
    return loading
  }

  async function save() {
    if (!mem) return
    try {
      if (file) await saveTable(file, mem)
      else await setStorage(key, JSON.stringify(mem))
    } catch (e) {}
  }

  return {
    load: load,
    save: save,
    /** 同步取一条（未 load 时为 null，调用方自会兜底） */
    of: function (id) {
      return (mem && mem[String(id)]) || null
    },
    /** 全部（可能为 null，未 load） */
    all: function () {
      return mem
    },
    /**
     * 写入（与已有条目**合并写**：新快照缺的字段保留旧值，别覆盖成空）。
     * br=接口实际码率；type='mp3'|'flac'；q=本次档位 key（升级判定用）。
     * `p`（下载中的档位标记）在这里清掉 —— 下载已完成，残片认定到此为止。
     */
    put: async function (song, br, type, q) {
      if (!song || !song.id) return
      await load()
      const k = String(song.id)
      const prev = mem[k] || {}
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
      if (keepUsed) rec.u = Date.now() // 第一次落盘即算「刚用过」，LRU 排序有初值
      mem[k] = rec
      // mem 是共享对象：并发写入时后一次 stringify 也含前一次改动，不会丢
      await save()
    },
    /**
     * 标记「本次下载用的档位」（下载一开始就写；成功后 put 会清掉）。
     * 用途：续传时判断 `.part` 残片是不是当前档位留下的 —— 中途改过音质的话，
     * 旧档残片必须丢弃，否则字节接在一起会写出「长度对但内容是垃圾」的文件。
     */
    markPending: async function (id, qk) {
      await load()
      const k = String(id)
      const prev = mem[k] || {}
      prev.p = qk || ''
      prev.t = prev.t || Date.now()
      mem[k] = prev
      await save()
    },
    drop: async function (id) {
      await load()
      if (mem[String(id)]) {
        delete mem[String(id)]
        await save()
      }
    },
    clear: async function () {
      mem = {}
      try {
        if (file) await removeAt(storePath(file))
        else await removeStorage(key)
      } catch (e) {}
    }
  }
}

const dlMeta = makeMetaStore('bpncm_cache_meta', { keepUsed: false, file: 'cache_meta' })
const pcMeta = makeMetaStore('bpncm_playcache_meta', { keepUsed: true })

/* ---- 下载元数据（历史导出名保持不变，语义就是「用户下载」） ---- */
export const loadMeta = dlMeta.load
export const metaOf = dlMeta.of
export const putMeta = dlMeta.put
export const markPending = dlMeta.markPending
export const dropMeta = dlMeta.drop
export const clearMeta = dlMeta.clear

/* ---- 播放缓存元数据 ---- */
export const loadPlayMeta = pcMeta.load
export const playMetaOf = pcMeta.of
export const putPlayMeta = pcMeta.put
export const markPlayPending = pcMeta.markPending
export const dropPlayMeta = pcMeta.drop
export const clearPlayMeta = pcMeta.clear

/* ---------------- 元数据：缓存「最近使用」时间（LRU 排序键） ---------------- */

let touchTimer = null

/**
 * 记一次「这首歌被播放了」（播放器在真正出声的分支调）。**只更新已存在的条目** ——
 * 还没有条目说明这首还没缓存完，等缓存完成时 put 会给初值。
 * 写盘做成 ~400ms 合并写（连点切歌别反复整份写 storage）。
 */
export function touchPlayMeta(id) {
  if (!id) return
  const all = pcMeta.all()
  if (!all) return
  const rec = all[String(id)]
  if (!rec) return
  rec.u = Date.now()
  if (touchTimer) return
  touchTimer = setTimeout(function () {
    touchTimer = null
    pcMeta.save()
  }, 400)
}

/* ---------------- 枚举与统计 ---------------- */

const AUDIO_RE = /\.(mp3|flac)$/i

/** 列一个目录里的音频（元数据缺失只影响显示） */
async function listDir(dir, metaOfFn) {
  const names = await readNames(dir)
  const out = []
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    if (!name || !AUDIO_RE.test(name)) continue
    const id = name.replace(AUDIO_RE, '')
    const ext = AUDIO_RE.exec(name)[1].toLowerCase()
    const st = await statOf(dir + '/' + name)
    const size = (st && st.size) || 0
    const mtime = Number((st && (st.mtimeMs || st.mtime)) || 0)
    const meta = (metaOfFn && metaOfFn(id)) || null
    out.push({
      id: id,
      ext: ext,
      size: size,
      mtime: mtime,
      name: (meta && meta.n) || '',
      artist: (meta && meta.a) || '',
      br: (meta && meta.b) || 0,
      // 档位 key / 时长 / 封面 url（旧条目可能没有：给默认值，调用方兜底）
      qualityKey: (meta && meta.q) || '',
      durationMs: (meta && meta.d) || 0,
      cover: (meta && meta.c) || '',
      usedAt: (meta && meta.u) || 0
    })
  }
  return out
}

/** 已下载歌曲清单（本地下载页用） */
export async function listSongs() {
  await loadMeta()
  return listDir(musicDir(), metaOf)
}

/** 播放缓存清单（LRU 滚动 / 将来若要看缓存列表都从这里取） */
export async function listPlayCache() {
  await loadPlayMeta()
  return listDir(playCacheDir(), playMetaOf)
}

/**
 * 目录统计（下载 / 播放缓存 / 封面各 {count, bytes}）。
 * exec 通道一次调用（du -sk + ls 计数），避免 fs.stat 逐文件；exec 不可用时回退 fs。
 */
export async function stats() {
  const res = {
    songs: { count: 0, bytes: 0 }, // 下载（music/）
    cache: { count: 0, bytes: 0 }, // 播放缓存（cache/）
    covers: { count: 0, bytes: 0 }
  }
  const okExec = await has('du')
  if (okExec) {
    try {
      const M = musicDir()
      const P = playCacheDir()
      const C = coversDir()
      const one = function (tag, dir) {
        return 'echo "' + tag + ':$(ls -1 "' + dir + '" 2>/dev/null | grep -cE \'[.](mp3|flac)$\'):$(du -sk "' + dir + '" 2>/dev/null | cut -f1)"; '
      }
      const cmd = one('S', M) + one('P', P) +
        'echo "C:$(ls -1 "' + C + '" 2>/dev/null | wc -l):$(du -sk "' + C + '" 2>/dev/null | cut -f1)"'
      const r = await shRun(cmd, 15000)
      const lines = String((r && r.stdout) || '').split('\n')
      for (let i = 0; i < lines.length; i++) {
        // 目录不存在时 du 的 KB 列是空串（真机实测），第三段允许空
        const m = /^([SPC]):(\d+):(\d*)\s*$/.exec(lines[i].trim())
        if (!m) continue
        const count = parseInt(m[2], 10) || 0
        const kb = parseInt(m[3], 10) || 0
        const v = { count: count, bytes: kb * 1024 }
        if (m[1] === 'S') res.songs = v
        else if (m[1] === 'P') res.cache = v
        else res.covers = v
      }
      return res
    } catch (e) {
      log('cache', 'exec 统计失败: ' + ((e && e.message) || e))
    }
  }
  // 回退：fs 逐目录
  {
    const dirs = [
      { dir: musicDir(), key: 'songs', re: AUDIO_RE },
      { dir: playCacheDir(), key: 'cache', re: AUDIO_RE },
      { dir: coversDir(), key: 'covers', re: /./ }
    ]
    for (let d = 0; d < dirs.length; d++) {
      const names = await readNames(dirs[d].dir)
      let bytes = 0
      let count = 0
      for (let i = 0; i < names.length; i++) {
        const name = names[i]
        if (!name) continue
        const st = await statOf(dirs[d].dir + '/' + name)
        bytes += (st && st.size) || 0
        if (dirs[d].re.test(name)) count++
      }
      res[dirs[d].key] = { count: count, bytes: bytes }
    }
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

/* ---------------- 清理 ---------------- */

/** 删目录（exec rm -rf，失败回退 fs 逐个删）；返回是否成功 */
async function rmDir(dir) {
  const okExec = await has('du') // 与旧 getExec 的探测口径一致（只探 du，不探 df）
  if (okExec) {
    try {
      const r = await shRun('rm -rf "' + dir + '"', 20000)
      if (r && r.code === 0) return true
    } catch (e) {}
  }
  try {
    const names = await readNames(dir)
    for (let i = 0; i < names.length; i++) {
      await rmQuiet(dir + '/' + names[i])
    }
    return true
  } catch (e) {
    return false
  }
}

/**
 * 清空**下载**目录（含 .part 续传残留）与下载元数据表。
 * **调用方负责先 player.stop()**（不在这里 import player，避免循环依赖）。
 * 返回删除前的 {count, bytes} 供 UI 提示。
 */
export async function clearSongs() {
  let before = { count: 0, bytes: 0 }
  try {
    const s = await stats()
    before = s.songs
  } catch (e) {}
  const ok = await rmDir(musicDir())
  await clearMeta()
  try {
    await clearLocalLibrary() // 本地库（索引 + 歌词）随下载目录一起清（localmeta.js）
  } catch (e) {}
  try {
    await clearAllOrigins() // 下载归属标记（单曲/歌单批量，dlorigin.js）
  } catch (e) {}
  log('cache', '清空下载 ok=' + ok + ' 之前 ' + before.count + ' 首/' + Math.round(before.bytes / 1048576) + 'MB')
  return { ok: ok, removed: before }
}

/**
 * 清空**播放缓存**目录与缓存元数据表。
 * 不必停播：正在放的歌若用的是缓存文件，unlink 后 fd 仍在（Linux 语义），声音不断；
 * 但要清 localPath 让 player 下次 seek 重新找文件（download.forgetAll 里已做全量失效）。
 */
export async function clearPlayCache() {
  let before = { count: 0, bytes: 0 }
  try {
    const s = await stats()
    before = s.cache
  } catch (e) {}
  const ok = await rmDir(playCacheDir())
  await clearPlayMeta()
  log('cache', '清空播放缓存 ok=' + ok + ' 之前 ' + before.count + ' 首/' + Math.round(before.bytes / 1048576) + 'MB')
  return { ok: ok, removed: before }
}

/** 清空封面缓存（cover.js 内清文件 + 内存 mem） */
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

/* ---------------- 「缓存上限」与 LRU 滚动 ---------------- */

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
 * 扫缓存目录（文件名 + 大小 + mtime）。exec `stat` 一次拿完；不可用回退 fs 逐文件。
 * 返回 [{id, names:[...], size, mtime}]（同一 id 的两种扩展名合并成一挑）。
 */
async function scanPlayCache() {
  const dir = playCacheDir()
  const byId = {}
  const push = function (name, size, mtime) {
    if (!name || !AUDIO_RE.test(name)) return
    const id = name.replace(AUDIO_RE, '')
    if (!byId[id]) byId[id] = { id: id, names: [], size: 0, mtime: 0 }
    byId[id].names.push(name)
    byId[id].size += size
    if (mtime > byId[id].mtime) byId[id].mtime = mtime
  }
  const okExec = await has('stat')
  let done = false
  if (okExec) {
    try {
      const cmd = 'cd "' + dir + '" 2>/dev/null || exit 0; ' +
        'for f in *.mp3 *.flac; do [ -f "$f" ] && stat -c "%s %Y %n" "$f"; done'
      const r = await shRun(cmd, 20000)
      const lines = String((r && r.stdout) || '').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = /^(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(lines[i])
        if (!m) continue
        push(m[3], parseInt(m[1], 10) || 0, (parseInt(m[2], 10) || 0) * 1000)
      }
      done = true
    } catch (e) {
      done = false
    }
  }
  if (!done) {
    const names = await readNames(dir)
    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      if (!name) continue
      const st = await statOf(dir + '/' + name)
      push(name, (st && st.size) || 0, Number((st && (st.mtimeMs || st.mtime)) || 0))
    }
  }
  const out = []
  const keys = Object.keys(byId)
  for (let i = 0; i < keys.length; i++) out.push(byId[keys[i]])
  return out
}

/**
 * 执行「缓存上限」滚动（LRU）：总量超出上限时，从**最久没被播放**的开始删，
 * 直到落到上限以内。返回 {ok, removed, freed, total, limit, skipped?}。
 *
 * 排序键：playMeta.u（最近一次播放）→ playMeta.t（写入时间）→ 文件 mtime（兜底，
 * 处理「元数据丢了但文件还在」的老条目）。
 * 保护：player.js 通过 setCacheProtectHook 交出正在播放的 id，**绝不删在放的那首**。
 *
 * 调用时机（都由 download.js / 设置页触发，页面不直接调）：
 *   - 播放缓存写入成功后（增量就在这里，趁热判断）
 *   - 设置页改了「缓存上限」之后
 */
export async function enforceCacheLimit() {
  const limit = cacheLimitBytes()
  if (!limit) return { ok: true, skipped: true, removed: 0, freed: 0, total: 0, limit: 0 }
  await loadPlayMeta()
  const items = await scanPlayCache()
  let total = 0
  const keep = collectProtected()
  for (let i = 0; i < items.length; i++) {
    const meta = playMetaOf(items[i].id)
    items[i].at = (meta && (meta.u || meta.t)) || items[i].mtime || 0
    total += items[i].size
  }
  if (total <= limit) return { ok: true, removed: 0, freed: 0, total: total, limit: limit }

  items.sort(function (a, b) {
    return a.at - b.at
  }) // 旧 → 新
  const okExec = await has('du') // 与旧 getExec 的探测口径一致（只探 du）
  const gone = []
  let freed = 0
  for (let i = 0; i < items.length && total > limit; i++) {
    const it = items[i]
    let protectedIt = false
    for (let j = 0; j < keep.length; j++) {
      if (keep[j] && String(keep[j]) === it.id) protectedIt = true
    }
    if (protectedIt) continue
    let removedFiles = 0
    for (let n = 0; n < it.names.length; n++) {
      const p = playCacheDir() + '/' + it.names[n]
      let ok = false
      if (okExec) {
        try {
          const r = await shRun('rm -f "' + p + '"', 10000)
          ok = !!(r && r.code === 0)
        } catch (e) {
          ok = false
        }
      }
      if (!ok) {
        if (await fileExists(p)) {
          await rmQuiet(p)
          ok = !(await fileExists(p))
        }
      }
      if (ok) removedFiles++
    }
    if (!removedFiles) continue
    total -= it.size
    freed += it.size
    gone.push(it.id)
    await dropPlayMeta(it.id)
  }
  log('cache', '缓存滚动：删 ' + gone.length + ' 首 / 释放 ' + Math.round(freed / 1048576) +
    'MB → 现 ' + Math.round(total / 1048576) + 'MB（上限 ' + Math.round(limit / 1048576) + 'MB）')
  return { ok: true, removed: gone.length, freed: freed, total: total, limit: limit, ids: gone }
}
