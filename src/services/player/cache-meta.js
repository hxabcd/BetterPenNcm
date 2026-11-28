import * as media from '../../services/player/media.js'
import { cacheDir, musicDir } from '../../core/infra/paths.js'

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

// 跨文件接线：内存快照只有这一份，扫描/清理/滚动都从这里取
export { dlMeta, pcMeta }
