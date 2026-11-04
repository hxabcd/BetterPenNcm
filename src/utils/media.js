/**
 * 单个 track 目录的读写 —— 目录布局见 docs/存储重构.md §2。
 *
 *   <downloads|cache>/<track_id>/
 *       track.mp3 | track.flac     音频（扩展名由直链回包 type 定）
 *       track.*.part(.cur)         续传残片（下载中）
 *       cover.jpg                  封面（**单尺寸 200px**，理由见 §0.1）
 *       lyrics.json                歌词（**只有 downloads/ 有**）
 *       metadata.json              显示信息 + 档位 + 下载归属 + LRU 时间
 *
 * 为什么要这一层：本次重构把「一首歌 = 一个目录」定成不变式，音频/封面/歌词/元数据
 * 全在同一个目录里、同生共死。若各处自己拼 `<root>/<id>/xxx`，删歌时就必然漏清某一样，
 * 留下孤儿文件（旧布局 `music/<id>.mp3` + `lrc/<id>.json` + `covers/<id>_200.jpg` 三处分散，
 * 就是这个问题的来源）。所有路径都从 utils/paths.js 出，本模块只负责「读写什么」。
 *
 * 写通道：文本走 fsutil.writeTextFile（printf 重定向 + mv -f 原子替换，不抛）。
 * 读通道：原生 fs.readFile，不分叉。
 */
import {
  trackDir,
  trackFile,
  altTrackFile,
  trackCover,
  trackLyrics,
  trackMeta,
  rootOf
} from './paths.js'
import {
  ensureDir,
  fileExists,
  fileSize,
  readTextFile,
  removePath,
  removeTree,
  statOf
} from './fsutil.js'

/**
 * 音频文件最小可信尺寸。
 * 半截文件（下载中断、curl 被 kill）**不得**当成缓存命中 —— 否则播放器拿到一个
 * 能打开但播到一半就断的文件，比「没缓存、重新下」体验差得多。
 */
export const MIN_AUDIO_BYTES = 30000

const AUDIO_EXT = ['mp3', 'flac']

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

/* ---------------- 元数据 ---------------- */

/**
 * 读 metadata.json。
 * 字段：{n 歌名, a 歌手串, b 码率, y 容器, q 档位 key, d 时长 ms, c 封面 url,
 *        origin 下载归属(1=user 2=playlist), addedAt 下载时间, u 最近播放, p 续传档位标记, t 写入时间}
 * 缺失/损坏一律给 null（调用方按「没有」处理）。
 */
export async function readMeta(id, kind) {
  const raw = await readTextFile(trackMeta(id, kind))
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : null
  } catch (e) {
    return null
  }
}

/**
 * 写 metadata.json（**与已有条目合并**：传进来的字段覆盖，其余保留）。
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
  return writeJson(trackMeta(id, kind), next)
}

/** 整份覆盖写 metadata.json（迁移用） */
export async function writeMeta(id, kind, obj) {
  return writeJson(trackMeta(id, kind), obj)
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

/* ---------------- 歌词 ---------------- */

/** 读歌词：{v, lrc, tlyric, yrc, pureMusic} 或 null */
export async function readLyrics(id, kind) {
  const raw = await readTextFile(trackLyrics(id, kind))
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

/** 写歌词（没词又不是纯音乐就什么都不写 —— 别在盘上留空壳） */
export async function writeLyrics(id, kind, obj) {
  if (!obj || (!obj.lrc && !obj.pureMusic)) return false
  return writeJson(trackLyrics(id, kind), {
    v: obj.v || 1,
    lrc: obj.lrc || '',
    tlyric: obj.tlyric || '',
    yrc: obj.yrc || '',
    pureMusic: obj.pureMusic ? 1 : 0
  })
}

/* ---------------- 删除 ---------------- */

/**
 * 删掉某 track 的整个目录（音频 + 封面 + 歌词 + 元数据一起走）。
 * `rm -rf` 一次 shell 调用；比逐文件删快得多，也不会漏项。
 */
export async function dropTrackDir(id, kind) {
  return removeTree(trackDir(id, kind))
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
 */
export async function listTracks(kind) {
  const { readNames } = await import('./fsutil.js')
  const root = rootOf(kind)
  const names = await readNames(root)
  const out = []
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    if (!name || !/^\d+$/.test(name)) continue // 跳过 thumbs/ 与任何非数字目录
    const dir = root + '/' + name
    const st = await statOf(dir)
    if (!st) continue
    const hit = await hitAudio(name, kind)
    const meta = await readMeta(name, kind)
    out.push({
      id: name,
      size: hit ? hit.size : 0,
      ext: hit ? hit.ext : '',
      path: hit ? hit.path : '',
      mtime: Number(st.mtimeMs || st.mtime || 0),
      meta: meta
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

/** 原子写 JSON（走 fsutil 的 printf + mv 通道；失败只记日志） */
async function writeJson(path, obj) {
  const { writeTextFile } = await import('./fsutil.js')
  let text = ''
  try {
    text = JSON.stringify(obj)
  } catch (e) {
    return false
  }
  return writeTextFile(path, text)
}
