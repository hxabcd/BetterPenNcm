/**
 * 单个 track 的读写 —— 音频/封面在目录里，元数据/歌词在 SQLite 里。
 *
 *   <downloads|cache>/<track_id>/
 *       track.mp3 | track.flac     音频（扩展名由直链回包 type 定）
 *       track.*.part(.cur)         续传残片（下载中）
 *       cover.jpg                  封面（**单尺寸 200px**，理由见 §0.1）
 *
 *   索引库 local_index.db：
 *       track_meta  (id, kind) → metadata.json 的内容
 *       track_lyric (id)       → lyrics.json 的内容
 *
 * 为什么要这一层：本次重构把「一首歌 = 一个目录」定成不变式，音频/封面同生共死。
 * 若各处自己拼 `<root>/<id>/xxx`，删歌时就必然漏清某一样，留下孤儿文件（旧布局
 * `music/<id>.mp3` + `lrc/<id>.json` + `covers/<id>_200.jpg` 三处分散，就是这个问题的来源）。
 * 所有路径都从 utils/paths.js 出，本模块只负责「读写什么」。
 *
 * ⚠ 元数据与歌词**不再落 JSON 文件**：平台 `fs` 没有写接口，写文件只能 fork 一次 shell
 *   （真机 92~139ms）。下载一首歌要写 metadata 两次、歌词一次，全落在播放链路上。
 *   改走 SQLite 的 upsert 后是微秒级，且天然原子（不再需要 `.tmp` + `mv -f` 那套）。
 */
import {
  trackDir,
  trackFile,
  altTrackFile,
  trackCover,
  rootOf
} from './paths.js'
import {
  ensureDir,
  fileExists,
  fileSize,
  readNames,
  removePath,
  removeTree,
  statOf
} from './fsutil.js'
import { docGet, docPut, docDel, docAll } from './db.js'

/**
 * 音频文件最小可信尺寸。
 * 半截文件（下载中断、curl 被 kill）**不得**当成缓存命中 —— 否则播放器拿到一个
 * 能打开但播到一半就断的文件，比「没缓存、重新下」体验差得多。
 */
export const MIN_AUDIO_BYTES = 30000

const AUDIO_EXT = ['mp3', 'flac']

/** 文档表名（只在这里出现） */
const T_META = 'track_meta'
const T_LYRIC = 'track_lyric'

/* ---------------- 目录 ---------------- */

/** 确保某 track 的目录存在（下载前调；幂等） */
export async function ensureTrackDir(id, kind) {
  return ensureDir(trackDir(id, kind))
}

/** 该 track 是否有目录（用于「有没有任何本地痕迹」判断） */
export async function hasTrackDir(id, kind) {
  return fileExists(trackDir(id, kind))
}

/* ---------------- 音频 ---------------- */

/**
 * 探一首歌在本通道下的**完整**音频文件。
 * 两个扩展名都看（换音质会换容器），返回 `{path, ext, size}` 或 null。
 * 小于 MIN_AUDIO_BYTES 的不算命中。
 */
export async function hitAudio(id, kind) {
  for (let i = 0; i < AUDIO_EXT.length; i++) {
    const p = trackFile(id, AUDIO_EXT[i], kind)
    const size = await fileSize(p)
    if (size > MIN_AUDIO_BYTES) return { path: p, ext: AUDIO_EXT[i], size: size }
  }
  return null
}

/** 音频文件路径（按已知扩展名；不做存在性检查） */
export function audioPath(id, ext, kind) {
  return trackFile(id, ext, kind)
}

/** 同目录另一格式的路径（换音质后清理用） */
export function otherAudioPath(id, ext, kind) {
  return altTrackFile(id, ext, kind)
}

/* ---------------- 元数据（索引库 track_meta） ---------------- */

/**
 * 读一条曲目的元数据。
 * 字段：{n 歌名, a 歌手串, b 码率, y 容器, q 档位 key, d 时长 ms, c 封面 url,
 *        origin 下载归属(1=user 2=playlist), addedAt 下载时间, u 最近播放, p 续传档位标记, t 写入时间}
 * 缺失/损坏一律给 null（调用方按「没有」处理）。
 */
export async function readMeta(id, kind) {
  const raw = await docGet(T_META, id, kind)
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : null
  } catch (e) {
    return null
  }
}

/**
 * 写元数据（**与已有条目合并**：传进来的字段覆盖，其余保留）。
 * 合并语义很重要：下载完成写码率、播放时写 lastUsed、删除归属写 origin，
 * 三处各自只知道自己那几个字段，覆盖写会把别人的字段擦掉。
 */
export async function patchMeta(id, kind, patch) {
  const prev = (await readMeta(id, kind)) || {}
  const next = {}
  const keys = Object.keys(prev)
  for (let i = 0; i < keys.length; i++) next[keys[i]] = prev[keys[i]]
  const pk = Object.keys(patch || {})
  for (let i = 0; i < pk.length; i++) next[pk[i]] = patch[pk[i]]
  return writeJson(T_META, id, kind, next)
}

/** 整份覆盖写元数据（迁移用） */
export async function writeMeta(id, kind, obj) {
  return writeJson(T_META, id, kind, obj)
}

/** 删一条元数据（不碰音频/封面） */
export async function dropMeta(id, kind) {
  return docDel(T_META, id, kind)
}

/**
 * 一次取出某通道全部元数据（`{ id: 记录 }`）。
 * 扫目录时用：`listTracks` 逐首 `readMeta` 就是 N 次 prepare，几百首很不划算。
 */
export async function allMeta(kind) {
  const raw = await docAll(T_META, kind)
  const out = {}
  const keys = Object.keys(raw)
  for (let i = 0; i < keys.length; i++) {
    try {
      const o = JSON.parse(raw[keys[i]])
      if (o && typeof o === 'object') out[keys[i]] = o
    } catch (e) {}
  }
  return out
}

/* ---------------- 封面 ---------------- */

/** 封面本地路径（不做存在性检查；交给 <image> 前请先确认文件在） */
export function coverPath(id, kind) {
  return trackCover(id, kind)
}

/** 封面是否已在盘上（存在且非空） */
export async function hasCover(id, kind) {
  return (await fileSize(trackCover(id, kind))) > 0
}

/* ---------------- 歌词（索引库 track_lyric） ---------------- */

/** 读歌词：{v, lrc, tlyric, yrc, pureMusic} 或 null */
export async function readLyrics(id) {
  const raw = await docGet(T_LYRIC, id)
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    if (!o || (!o.lrc && !o.pureMusic)) return null
    return {
      v: o.v || 1,
      lrc: o.lrc || '',
      tlyric: o.tlyric || '',
      yrc: o.yrc || '',
      pureMusic: !!o.pureMusic
    }
  } catch (e) {
    return null
  }
}

/** 写歌词（没词又不是纯音乐就什么都不写 —— 别在库里留空壳） */
export async function writeLyrics(id, obj) {
  if (!obj || (!obj.lrc && !obj.pureMusic)) return false
  return writeJson(T_LYRIC, id, undefined, {
    v: obj.v || 1,
    lrc: obj.lrc || '',
    tlyric: obj.tlyric || '',
    yrc: obj.yrc || '',
    pureMusic: obj.pureMusic ? 1 : 0
  })
}

/** 删一条歌词 */
export async function dropLyrics(id) {
  return docDel(T_LYRIC, id)
}

/* ---------------- 删除 ---------------- */

/**
 * 删掉某 track 的整个目录（音频 + 封面一起走），并清掉库里的元数据。
 * `rm` 一次原生调用（递归），比逐文件删快得多，也不会漏项。
 */
export async function dropTrackDir(id, kind) {
  const ok = await removeTree(trackDir(id, kind))
  await dropMeta(id, kind)
  return ok
}

/** 删单个文件（残留区/缩略图用） */
export async function dropFile(path) {
  return removePath(path)
}

/* ---------------- 枚举与统计 ---------------- */

/**
 * 列一条通道下的所有 track 目录。
 * 返回 [{id, size, mtime, meta}]，**只看目录**（`cache/thumbs` 这类非纯数字目录会被跳过）。
 * 音频大小用目录内 track.* 的实际大小；目录在但音频没有的条目也会返回（size=0），
 * 由调用方决定要不要清理 —— 这里不替它做决定。
 *
 * 元数据一次全取（一条 SELECT），不再逐首 prepare。
 */
export async function listTracks(kind) {
  const root = rootOf(kind)
  const names = await readNames(root)
  const metas = await allMeta(kind)
  const out = []
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    if (!name || !/^\d+$/.test(name)) continue // 跳过 thumbs/ 与任何非数字目录
    const dir = root + '/' + name
    const st = await statOf(dir)
    if (!st) continue
    const hit = await hitAudio(name, kind)
    out.push({
      id: name,
      size: hit ? hit.size : 0,
      ext: hit ? hit.ext : '',
      path: hit ? hit.path : '',
      mtime: Number(st.mtimeMs || st.mtime || 0),
      meta: metas[name] || null
    })
  }
  return out
}

/** 一条通道的总耗时/总字节（存储管理页用；exec `du` 不可用时才走这里） */
export async function dirStats(kind) {
  const list = await listTracks(kind)
  let count = 0
  let bytes = 0
  for (let i = 0; i < list.length; i++) {
    if (list[i].size > 0) {
      count++
      bytes += list[i].size
    }
  }
  return { count: count, bytes: bytes }
}

/* ---------------- 内部 ---------------- */

/** 序列化后写进文档表（失败只记日志，返回是否成功） */
async function writeJson(table, id, kind, obj) {
  let text = ''
  try {
    text = JSON.stringify(obj)
  } catch (e) {
    return false
  }
  return docPut(table, id, kind, text)
}
