/**
 * 媒体源层之一：本地文件（从 download.js 拆出，实现零改动）。
 *
 * 半截文件约定：curl 通道下载到 `<id>.<ext>.part`，下满校验后 `mv` 成 `<id>.<ext>`
 * （ext 由直链回包的 type 定：无损档 = .flac，其余 .mp3）。所以**正式路径永远是完整文件**，
 * cachedPath 不会把半截文件当成缓存命中；中断的 .part 留在原地，下次自动从它的实际大小续传。
 * （回退通道 builtin 没有 mv，只能直落正式路径，失败即删。）
 */
import { playCacheDir, musicDir } from './cache.js'
import { fileExists, fileSize, readNames, rmQuiet, statOf } from '../fsutil.js'

/** kind → 目录：cache = 边听边存（cache/），download = 用户下载（music/） */
export function dirOf(kind) {
  return kind === 'download' ? musicDir() : playCacheDir()
}

/** 音频文件路径：扩展名由直链格式定（无 type 时按 mp3，兼容老接口回包） */
export function songPath(id, ext, kind) {
  return dirOf(kind) + '/' + id + '.' + (ext === 'flac' ? 'flac' : 'mp3')
}

/** 同一目录里另一格式的路径（换音质后清理旧文件用；**只在本目录内找**） */
export function altPath(id, ext, kind) {
  return songPath(id, ext === 'flac' ? 'mp3' : 'flac', kind)
}

/** 单目录命中探测：存在且 >30KB 才算数（半截文件不算）；返回路径或 null */
async function hitIn(dir, songId) {
  const cands = [dir + '/' + songId + '.flac', dir + '/' + songId + '.mp3']
  for (let i = 0; i < cands.length; i++) {
    const size = await fileSize(cands[i])
    if (size > 30000) return cands[i]
  }
  return null
}

/** 只探**下载目录**（music/）：用户主动下载才算「已下载」（播放页下载键 / 升质比较用） */
export async function dlPath(songId) {
  return hitIn(musicDir(), songId)
}

/** 只探**播放缓存目录**（cache/） */
export async function playCachePath(songId) {
  return hitIn(playCacheDir(), songId)
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

/** 清掉某目录里某 id 的全部文件（正式文件 + .part/.part.cur 续传残片）；返回 {files, bytes} */
export async function purgeInDir(dir, id) {
  const names = await readNames(dir)
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('^' + esc + '\\.(mp3|flac)(\\.part(\\.cur)?)?$')
  let files = 0
  let bytes = 0
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    if (!name || !re.test(name)) continue
    const p = dir + '/' + name
    const st = await statOf(p)
    bytes += (st && st.size) || 0
    if (await fileExists(p)) {
      await rmQuiet(p)
      if (!(await fileExists(p))) files++
    }
  }
  return { files: files, bytes: bytes }
}
