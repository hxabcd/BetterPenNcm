import * as media from '../../services/player/media.js'
import { trackDir, rootOf } from '../../core/infra/paths.js'
import { clearCovers } from '../../services/cover/cover.js'
import { clearLocalLibrary } from './localmeta.js'
import { clearAllOrigins } from './dlorigin.js'
import { log } from '../../core/infra/log.js'
import { fileExists, readNames } from '../../core/platform/fsutil.js'
import { ensureRoot } from './files.js'
import { clearMeta, clearPlayMeta } from './cache-meta.js'
import { stats } from './cache-scan.js'

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
