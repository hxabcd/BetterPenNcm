/**
 * 媒体源层之一：本地音频的探测与清理。
 *
 * 目录契约见 docs/存储重构.md §2，路径唯一真源是 utils/paths.js，
 * 「一首歌一个目录」的读写封装在 utils/media.js —— 本模块不再自己拼路径。
 *
 *   <downloads|cache>/<id>/track.mp3 | track.flac   正式文件（永远是完整文件）
 *   <downloads|cache>/<id>/track.*.part(.cur)       续传残片（下载中）
 *
 * 半截文件约定不变：curl 通道下载到 `track.<ext>.part`，下满校验后 `mv` 成 `track.<ext>`，
 * 所以探测永远不会把半截文件当成命中；中断的 .part 留在原地，下次自动从它的实际大小续传
 * （>30KB 判定在 media.MIN_AUDIO_BYTES，与旧布局同一个数）。
 * 回退通道（内建 http.download）没有 mv，只能直落正式路径，失败即删。
 *
 * 删一首歌 = 删整个 `<id>/` 目录（音频 + 封面 + 歌词 + 元数据一次 rm -rf）。
 */
import { rootOf, trackDir } from '../paths.js'
import { audioPath, otherAudioPath, hitAudio } from '../media.js'
import { getFs, fileExists, readNames, statOf, removeTree } from '../fsutil.js'

/** kind → 通道根目录（cache = 边听边存，download = 用户下载） */
export function dirOf(kind) {
  return rootOf(kind)
}

/** 音频文件路径：扩展名由直链格式定（无 type 时按 mp3，兼容老接口回包） */
export function songPath(id, ext, kind) {
  return audioPath(id, ext, kind)
}

/** 同一目录里另一格式的路径（换音质后清理旧文件用；**只在本目录内找**） */
export function altPath(id, ext, kind) {
  return otherAudioPath(id, ext, kind)
}

/** 单通道命中探测：走 media.hitAudio（存在且 >30KB 才算数，半截文件不算）；返回路径或 null */
async function hitIn(kind, songId) {
  const hit = await hitAudio(songId, kind)
  return hit ? hit.path : null
}

/** 只探**下载目录**：用户主动下载才算「已下载」（播放页下载键 / 升质比较用） */
export async function dlPath(songId) {
  return hitIn('download', songId)
}

/** 只探**播放缓存目录**（cache/） */
export async function playCachePath(songId) {
  return hitIn('cache', songId)
}

/**
 * 任意本地命中（播放用）：**下载优先**（用户主动下的那首通常是更高音质、且是要留着的），
 * 其次播放缓存。返回路径或 null。
 */
export async function cachedPath(songId) {
  const d = await dlPath(songId)
  if (d) return d
  return playCachePath(songId)
}

/**
 * 清掉某个根目录下某 id 的**整个目录**（正式文件 + .part/.part.cur 续传残片 + 封面 + 元数据）；
 * 返回 {files, bytes}（删之前的统计，UI 提示「释放 X」用）。
 *
 * 参数保持「根目录 + id」形态：scheduler.js 与 download.js 各自传自己的根目录，
 * 本函数只做 `<dir>/<id>` 的 rm -rf，不关心是 download 还是 cache。
 */
export async function purgeInDir(dir, id) {
  const base = String(dir || '').replace(/\/+$/, '')
  const target = base + '/' + String(id)
  const names = await readNames(target)
  let bytes = 0
  for (let i = 0; i < names.length; i++) {
    const st = await statOf(target + '/' + names[i])
    bytes += (st && st.size) || 0
  }
  // 目录不存在也照删一次（rm -rf 对不存在路径是成功；顺带兜住「只有同名平铺文件」的旧残留）
  if (names.length || (await fileExists(target))) await removeTree(target)
  return { files: names.length, bytes: bytes }
}

/**
 * 确保目录**真的**存在（原生 exists + mkdir，不 fork）。
 *
 * 为什么不直接用 fsutil.ensureDir：它带进程内 `readyDirs` 缓存，而 `rm -rf` 删掉目录后
 * 那份缓存不会失效 → 后续 ensureDir 会误报「已存在」而不建目录，之后所有写入都会失败。
 * 本模块与 cache.js 的删除路径都走这里复核一次（原生调用，代价可忽略）。
 */
export async function ensureNativeDir(dir) {
  try {
    const fs = await getFs()
    if (await fs.exists(dir)) return true
    await fs.mkdir(dir)
    return true
  } catch (e) {
    return false
  }
}

/** 确保某条通道的根目录在盘上（清空目录后再写入时必须先调它） */
export async function ensureRoot(kind) {
  return ensureNativeDir(rootOf(kind))
}

/**
 * 下载前的目录准备：通道根目录 + `<root>/<id>/`。
 * 返回目录是否可用；失败只记日志（上层会把落盘当成普通下载失败处理）。
 */
export async function prepareTrackDir(id, kind) {
  await ensureRoot(kind)
  const dir = trackDir(id, kind)
  await ensureNativeDir(dir)
  return fileExists(dir)
}
