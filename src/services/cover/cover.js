// 封面缓存：两路落点、一条读取路径
//   ① 已下载/已缓存曲目的封面 = <downloads|cache>/<id>/cover.jpg（单尺寸 200px，跟随曲目目录同生共死）
//   ② 浏览时的列表缩略图（搜索、在线歌单、歌手头像、专辑卡等没有本地曲目的）= cache/thumbs/<key>_<size>.jpg
//      —— 可整体清空、不属于任何曲目，按尺寸各存一份（这份收益是列表行的网络带宽，不是曲目属性）
// 曲目封面只有 200 这一档：设备高度仅 240px，全应用最大的封面盒是播放页 152px，200 已覆盖并有余量
import { download } from '../../core/infra/net/request.js'
import { log } from '../../core/infra/log.js'
import { fileExists, fileSize, readNames, rmQuiet, getFs } from '../../core/platform/fsutil.js'
import { sleep } from '../../core/infra/util.js'
import { thumbsDir, trackDir } from '../../core/infra/paths.js'
import * as media from '../../services/player/media.js'

const CONC = 2 

// 浏览缩略图默认边长：列表行 17vh ≈ 40.8px，60 够用且网络成本约 1.8KB
export const THUMB = 60

// 大封面边长，也是曲目封面 cover.jpg 的唯一尺寸：全应用最大封面盒（播放页）139~158px，
// 200 已点对点有余；同一张图 param=300y300 要 204KB、200y200 只要 100KB，没必要取大
export const BIG_COVER = 200

const TRACK_SIZE = BIG_COVER

// 网易云 CDN 标准缩略图参数：?param=<边长>y<边长>（实测 216KB 原图 → 60y60 约 1.8KB）
function thumbFor(size) {
  const s = size || THUMB
  return '?param=' + s + 'y' + s
}

// 浏览缩略图的键：同一张图在列表要 60、播放页要 200，不能互相顶掉
function thumbKey(id, size) {
  return String(id) + '@' + (size || THUMB)
}

// 歌曲 id 是纯数字；带前缀的键（见 coverKey）不是
function isSongId(id) {
  return /^\d+$/.test(String(id))
}

// 封面缓存的键：歌曲就是纯数字 id，非歌曲实体带前缀（album/artist/playlist/user）
// 前缀是磁盘上的既有约定（cache/thumbs/<id>_<size>.jpg），改了等于让老缓存全部失效
export function coverKey(kind, id) {
  if (kind === 'album') return 'al' + id
  if (kind === 'artist') return 'arp' + id
  if (kind === 'artistFallback') return 'arf' + id
  if (kind === 'playlist') return 'pl' + id
  if (kind === 'user') return 'ac' + id
  return String(id)
}

const mem = {} // 缩略图：'id@size' -> file url
const memTrack = {} // 曲目封面：'id' -> file url（单尺寸，一把键）
const inflight = {} // 缩略图：'id@size' -> [回调, ...]
const trackJobs = {} // 曲目封面：'id' -> Promise（同一首的 cover.jpg 只下一次）
const queue = [] // [{key, id, url, size}]
let workers = 0

// 封面缩略图目录（实现收敛到 core/infra/paths.js；这里保持历史导出名）
export function coversDir() {
  return thumbsDir()
}

// 清空封面缓存（存储管理页「清空封面缓存」用）= 缩略图目录整体清掉 + 已缓存曲目（cache/）的 cover.jpg。
// 下载目录（downloads/）的 cover.jpg 不动：那是用户资产的离线视图，删了要联网才回得来。
// ⚠ 必须同时清内存：否则本会话内的 <image> 仍拿着已删文件的 file:// 路径（黑图）。
// 返回尽力删掉的文件数
export async function clearCovers() {
  let n = 0
  try {

    const dir = thumbsDir()
    const names = await readNames(dir)
    for (let i = 0; i < names.length; i++) {
      const p = dir + '/' + names[i]
      if (!(await fileExists(p))) continue
      await rmQuiet(p)
      if (!(await fileExists(p))) n++
    }

    const cached = await media.listTracks('cache')
    for (let i = 0; i < cached.length; i++) {
      const p = media.coverPath(cached[i].id, 'cache')
      if (!(await fileExists(p))) continue
      await rmQuiet(p)
      if (!(await fileExists(p))) n++
    }
    const keys = Object.keys(mem)
    for (let i = 0; i < keys.length; i++) delete mem[keys[i]]
    const tk = Object.keys(memTrack)
    for (let i = 0; i < tk.length; i++) delete memTrack[tk[i]]
    log('cover', '已清空封面缓存 ' + n + ' 个文件')
  } catch (e) {}
  return n
}

// 给 <image> 用的本地文件 URL：诊断页 A/B/C 对照实测，image 组件不认裸绝对路径，
// 必须 file:// 前缀（B、C 出图，A 黑块）；http 直链也支持（C），但为了
// 离线可用与并发可控仍走「缩略图下载 + 磁盘缓存 + file:// 显示」这条线
function fileUrl(path) {
  return 'file://' + path
}

// 确保目录存在（原生 exists + mkdir，不 fork）
async function ensureNativeDir(dir) {
  try {
    const fs = await getFs()
    if (await fs.exists(dir)) return true
    await fs.mkdir(dir)
    return true
  } catch (e) {
    return false
  }
}

// 缩略图文件路径：cache/thumbs/<id>_<size>.jpg
function thumbPath(id, size) {
  return thumbsDir() + '/' + String(id) + '_' + (size || THUMB) + '.jpg'
}

// 同步取已就绪的封面（file:// URL，可直接给 image src）；未就绪返回 ''
export function cachedCover(id, size) {
  if (!id) return ''
  if (memTrack[id]) return memTrack[id]
  return mem[thumbKey(id, size)] || ''
}

// 这个 id 对应哪条本地通道（'download' | 'cache' | ''）。
// 只看目录在不在 —— 目录里已经有音频/封面/残片都算「这首在本机有落点」，
// 封面就该跟着它走（目录删掉时一起走）
async function trackKindOf(id) {
  if (!isSongId(id)) return ''
  if (await media.hasTrackDir(id, 'download')) return 'download'
  if (await media.hasTrackDir(id, 'cache')) return 'cache'
  return ''
}

// 确保某首本地曲目的 cover.jpg 在盘上并返回 file:// URL（失败给 ''）。
// 单尺寸：不管调用方要 60 还是 200，盘上就这一份 200px 的图。
// 同一首并发请求合并到一次下载（trackJobs）
function ensureTrackCover(id, url) {
  const running = trackJobs[id]
  if (running) return running
  const p = (async function () {
    try {
      const kind = await trackKindOf(id)
      if (!kind) return ''
      const path = media.coverPath(id, kind)

      // 磁盘已有（跨会话缓存）
      if ((await fileSize(path)) > 0) return fileUrl(path)
      await ensureNativeDir(trackDir(id, kind))
      const full = url + (url.indexOf('?') >= 0 ? '' : thumbFor(TRACK_SIZE))
      try {
        await download({ url: full, outPath: path, timeout: 20000 })
      } catch (e) {
        // 清残留，本次不重试（避免重试风暴）
        await rmQuiet(path) 
        return ''
      }

      // http.download 返回时最后一块可能还没落盘（实测 1KB 首次 stat=0、100ms 后才完整）。
      // 交给 <image> 前做短暂等待，避免把 0 字节文件写进 mem 并显示成黑图
      let size = await fileSize(path)
      for (let i = 0; i < 2 && !size; i++) {
        await sleep(50)
        size = await fileSize(path)
      }
      if (!size) {
        await rmQuiet(path)
        return ''
      }
      return fileUrl(path)
    } catch (e) {
      log('cover', '曲目封面失败 id=' + id + ': ' + ((e && e.message) || e))
      return ''
    } finally {
      delete trackJobs[id]
    }
  })()
  trackJobs[id] = p
  return p
}

// 只查磁盘（不触发下载），命中时顺带填本会话 mem。
// 给「离线时也要判断本地有没有图」的调用方用：ensureCover 会先查盘再下载，
// 但断网时未知的图会走一次注定失败的传输；这里先分开判断
export async function cachedCoverOnDisk(id, size) {
  if (!id) return ''
  const tk = memTrack[id]
  if (tk) return tk
  const key = thumbKey(id, size)
  if (mem[key]) return mem[key]
  try {

    // ① 本地曲目：cover.jpg（单尺寸）
    const kind = await trackKindOf(id)
    if (kind) {
      const p = media.coverPath(id, kind)
      if ((await fileSize(p)) > 0) {
        memTrack[id] = fileUrl(p)
        return memTrack[id]
      }
    }

    // ② 浏览缩略图
    const path = thumbPath(id, size)
    if (await fileExists(path)) {
      mem[key] = fileUrl(path)
      return mem[key]
    }
  } catch (e) {}
  return ''
}

// 丢弃某个缓存键的指定尺寸。
// runJob 只判断文件是否存在就直接复用，URL 变了不删旧文件就永远拿不到新图；
// 歌手换头像时由 artistavatar 调用。
// 歌曲 id 额外把它在各通道里的 cover.jpg 一并清掉（换封面同理）
export async function dropCover(id, sizes) {
  if (!id) return
  const list = sizes && sizes.length ? sizes : [THUMB]
  for (let i = 0; i < list.length; i++) {
    const sz = list[i] || THUMB
    delete mem[thumbKey(id, sz)]
    try {
      await rmQuiet(thumbPath(id, sz))
    } catch (e) {}
  }
  if (isSongId(id)) {
    delete memTrack[id]
    const kinds = ['download', 'cache']
    for (let i = 0; i < kinds.length; i++) {
      try {
        if (await media.hasTrackDir(id, kinds[i])) await rmQuiet(media.coverPath(id, kinds[i]))
      } catch (e) {}
    }
  }
}

function fire(key, id, path) {
  const cbs = inflight[key] || []
  delete inflight[key]
  for (let i = 0; i < cbs.length; i++) {
    try {
      cbs[i](id, path)
    } catch (e) {}
  }
}

async function ensureCoverDir() {
  return ensureNativeDir(thumbsDir())
}

async function runJob(job) {
  const key = job.key
  const id = job.id
  try {
    // ① 已下载/已缓存曲目：单尺寸 cover.jpg（跟着曲目目录走）
    if (isSongId(id)) {
      const url = await ensureTrackCover(id, job.url)
      if (url) {
        memTrack[id] = url
        fire(key, id, url)
        return
      }
    }
    // ② 浏览缩略图：cache/thumbs/<id>_<size>.jpg（按尺寸各一份，收益是列表行带宽）
    const path = thumbPath(id, job.size)
    await ensureCoverDir()

    // 磁盘已有（跨会话缓存）
    if (await fileExists(path)) {
      mem[key] = fileUrl(path)
      fire(key, id, mem[key])
      return
    }

    // 下载缩略图（URL 上已带参数的不重复加）
    const url = job.url + (job.url.indexOf('?') >= 0 ? '' : thumbFor(job.size))
    try {
      await download({ url: url, outPath: path, timeout: 20000 })
    } catch (e) {
      // 清残留，本次不重试（避免重试风暴）
      await rmQuiet(path) 
      fire(key, id, '')
      return
    }

    // 同 ensureTrackCover：等最后一两块落盘再交给 <image>，否则会显示成黑图
    let size = await fileSize(path)
    for (let i = 0; i < 2 && !size; i++) {
      await sleep(50)
      size = await fileSize(path)
    }
    if (!size) {
      await rmQuiet(path)
      fire(key, id, '')
      return
    }
    mem[key] = fileUrl(path)
    fire(key, id, mem[key])
  } catch (e) {
    fire(key, id, '')
    log('cover', '封面失败 id=' + id + ': ' + ((e && e.message) || e))
  }
}

function pump() {
  while (workers < CONC && queue.length) {
    workers++
    const job = queue.shift()
    runJob(job).then(function () {
      workers--
      pump()
    })
  }
}

// 单张确保（行组件用）：已就绪立即回调，否则入队等完成。
// 行组件在 mounted 里调、回调里给自己组件的普通属性赋值 —— 绕开「页面 data 动态 key + $set」
// 在 falcon 渲染器上不触发重渲染的问题（实测）。
// cb: (id, fileUrl) => void（失败时 fileUrl 为空串）
// size: 缩略图边长，默认 60（列表行）；播放页/歌手页用 200。
//       歌曲 id 命中本地曲目时忽略它：曲目封面只有 200 这一档（cover.jpg）
export function ensureCover(item, cb, size) {
  if (!item || !item.id || !item.cover) return
  enqueueCovers([item], cb, size)
}

// 批量入队封面下载（去重 + 限流）：无 cover 的自动跳过（如搜索结果）
// onReady: (id, fileUrl) => void —— 每张就绪回调一次（失败时为空串）
// id 不必是歌曲 id —— 头像/专辑封面传 coverKey() 生成的键（本模块只把它当缓存键，不关心语义）
export function enqueueCovers(items, onReady, size) {
  if (!items || !items.length) return
  const sz = size || THUMB
  let n = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it || !it.id || !it.cover) continue

    if (memTrack[it.id]) {
      onReady(it.id, memTrack[it.id])
      continue
    }
    const key = thumbKey(it.id, sz)
    if (mem[key]) {
      onReady(it.id, mem[key])
      continue
    }
    if (inflight[key]) {
      inflight[key].push(onReady) 
      continue
    }
    inflight[key] = [onReady]
    queue.push({ key: key, id: it.id, url: it.cover, size: sz })
    n++
  }
  if (n) log('cover', '入队 ' + n + ' 张 @' + sz + '（队列剩 ' + queue.length + '）')
  pump()
}
