/**
 * 目录契约（路径唯一真源是 core/infra/paths.js）：
 *   <downloads|cache>/<id>/track.mp3 | track.flac   正式文件（永远是完整文件）
 *   <downloads|cache>/<id>/track.*.part(.cur)       续传残片（下载中）
 *
 * 半截文件约定：curl 通道下到 `track.<ext>.part`，下满校验后 mv 成正式文件，所以探测永远不会把半截文件当成命中；
 * 中断的 .part 留原地，下次按其实际大小续传（>30KB 判定在 media.MIN_AUDIO_BYTES）。回退通道（内建 http.download）没有 mv，只能直落正式路径。
 * 删一首歌 = 删整个 `<id>/` 目录（音频 + 封面）。
 */


import { rootOf, trackDir } from '../../core/infra/paths.js'
import { audioPath, otherAudioPath, hitAudio } from '../../services/player/media.js'
import { getFs, fileExists, readNames, statOf, removeTree } from '../../core/platform/fsutil.js'

// 音频文件路径：扩展名由直链格式定（无 type 时按 mp3，兼容老接口回包）
export function songPath(id, ext, kind) {
  return audioPath(id, ext, kind)
}

// 同一目录里另一格式的路径（换音质后清理旧文件用；只在本目录内找）
export function altPath(id, ext, kind) {
  return otherAudioPath(id, ext, kind)
}

// 存在且 >30KB 才算命中（走 media.hitAudio），半截文件不算；返回路径或 null
async function hitIn(kind, songId) {
  const hit = await hitAudio(songId, kind)
  return hit ? hit.path : null
}

// 只探下载目录：用户主动下载才算「已下载」（播放页下载键 / 升质比较用）
export async function dlPath(songId) {
  return hitIn('download', songId)
}

// 只探播放缓存目录（cache/）
export async function playCachePath(songId) {
  return hitIn('cache', songId)
}

// 任意本地命中（播放用）：下载优先（用户主动下的通常音质更高、且是要留着的），其次播放缓存
export async function cachedPath(songId) {
  const d = await dlPath(songId)
  if (d) return d
  return playCachePath(songId)
}

// 清掉某个 track 的整个目录（正式文件 + .part/.part.cur 续传残片 + 封面；元数据行由调用方删）
// 返回 {files, bytes}（删之前的统计，UI 提示「释放 X」用）
export async function purgeTrack(id, kind) {
  return purgePath(trackDir(id, kind))
}

// 目录不存在也照删一次（rm -rf 对不存在路径是成功；顺带兜住「只有同名平铺文件」的旧残留）
async function purgePath(target) {
  const names = await readNames(target)
  let bytes = 0
  for (let i = 0; i < names.length; i++) {
    const st = await statOf(target + '/' + names[i])
    bytes += (st && st.size) || 0
  }

  if (names.length || (await fileExists(target))) await removeTree(target)
  return { files: names.length, bytes: bytes }
}

// 确保目录真的存在（原生 exists + mkdir，不 fork）
// 不能直接用 fsutil.ensureDir：它带进程内 readyDirs 缓存，rm -rf 删掉目录后该缓存不失效 → 后续 ensureDir 误报已存在而不建目录，写入全失败
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

// 确保某条通道的根目录在盘上（清空目录后再写入时必须先调它）
export async function ensureRoot(kind) {
  return ensureNativeDir(rootOf(kind))
}

// 下载前的目录准备：通道根目录 + `<root>/<id>/`；返回目录是否可用，失败只记日志（上层当成普通下载失败处理）
export async function prepareTrackDir(id, kind) {
  await ensureRoot(kind)
  const dir = trackDir(id, kind)
  await ensureNativeDir(dir)
  return fileExists(dir)
}
