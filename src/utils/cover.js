/**
 * 封面缓存：网络封面用缩略图下载到 $dataDir/covers/<id>.jpg，再交给 <image> 显示
 *
 * 为什么落地再显示：
 *   1) 运行时 <image> 对网络 URL 的支持未经验证；社区应用（PenMusic）用的就是本地文件路径
 *   2) 带宽：网易云 CDN 支持 ?param=60y60 缩略图（实测 216KB 原图 → 1.8KB 缩略图）
 *
 * 流畅性设计（列表滚动优先）：
 *   - 全程异步：页面渲染绝不等待网络；下载完成后由回调 $set 更新对应行
 *   - 全局限流队列（并发 2）+ 去重（mem/inflight）：慢网络下不抢占带宽
 *   - 磁盘缓存跨页面/重启复用；切页不取消下载（等于后台预热缓存，下次进列表直接命中）
 *
 * 页面用法：
 *   import { cachedCover, enqueueCovers } from '…/utils/cover.js'
 *   // 数据到位后：
 *   const init = {}; songs.forEach(s => { const p = cachedCover(s.id); if (p) init[s.id] = p })
 *   this.covers = init
 *   enqueueCovers(songs, (id, path) => { if (!this._destroyed) this.$set(this.covers, id, path) })
 */
import { download } from './net/request.js'
import { log } from './log.js'
import { ensureDir, fileExists, fileSize, readNames, rmQuiet } from './fsutil.js'
import { sleep } from './util.js'
import { coversDir as coversDirPath } from './paths.js'

const CONC = 2 // 并发下载上限
const THUMB_DEFAULT = 60 // 默认缩略图边长（列表行足够）
/**
 * 大封面边长：播放页/歌曲信息/歌手/专辑页用。
 * 本设备 1020×240 就是原生分辨率（帧缓冲解码出来一比一），封面盒 139~158px，
 * 所以 200px 已经点对点有余；实测同一张图 param=300y300 要 204KB、
 * 200y200 只要 100KB（网易云这个尺寸的 JPEG 压得差），没必要取大。
 */
export const BIG_COVER = 200
// 网易云 CDN 标准缩略图参数：?param=<边长>y<边长>（实测 216KB 原图 → 60y60 约 1.8KB）
function thumbFor(size) {
  const s = size || THUMB_DEFAULT
  return '?param=' + s + 'y' + s
}

/** 内存/磁盘的键都带尺寸：同一首歌在列表页要 60、播放页要 300，不能互相顶掉 */
function keyOf(id, size) {
  return id + '@' + (size || THUMB_DEFAULT)
}

const mem = {} // key -> 本地路径（本次会话已就绪）
const inflight = {} // key -> [回调, ...]（下载中，防重复入队）
const queue = [] // [{key, id, url, size}]
let workers = 0

/** 封面缓存目录（实现收敛到 utils/paths.js；这里保持历史导出名） */
export function coversDir() {
  return coversDirPath()
}

/**
 * 清空封面磁盘缓存 + 内存缓存（存储管理页「清空封面缓存」用）。
 * **必须同时清 mem**：否则本会话内的 <image> 仍拿着已删文件的 file:// 路径（黑图）。
 * 返回尽力删掉的文件数。
 */
export async function clearCovers() {
  let n = 0
  try {
    const dir = coversDirPath()
    const names = await readNames(dir)
    for (let i = 0; i < names.length; i++) {
      if (await fileExists(dir + '/' + names[i])) {
        await rmQuiet(dir + '/' + names[i])
        if (!(await fileExists(dir + '/' + names[i]))) n++
      }
    }
    const keys = Object.keys(mem)
    for (let i = 0; i < keys.length; i++) delete mem[keys[i]]
    log('cover', '已清空封面缓存 ' + n + ' 个文件')
  } catch (e) {}
  return n
}

/**
 * 给 <image> 用的本地文件 URL。
 * 诊断页 A/B/C 对照实测：image 组件**不认裸绝对路径**，
 * 必须 file:// 前缀（B、C 出图，A 黑块）；http 直链也支持（C），但为了
 * 离线可用与并发可控仍走「缩略图下载 + 磁盘缓存 + file:// 显示」这条线。
 */
function fileUrl(path) {
  return 'file://' + path
}

async function ensureCoverDir() {
  return ensureDir(coversDirPath())
}

/** 同步取已就绪的封面（file:// URL，可直接给 image src）；未就绪返回 '' */
export function cachedCover(id, size) {
  return mem[keyOf(id, size)] || ''
}

/**
 * 只查磁盘（不触发下载），命中时顺带填本会话 mem。
 * 给「离线时也要判断本地有没有图」的调用方用：ensureCover 会先查盘再下载，
 * 但断网时未知的图会走一次注定失败的传输；这里先分开判断。
 */
export async function cachedCoverOnDisk(id, size) {
  const key = keyOf(id, size)
  if (mem[key]) return mem[key]
  const path = coversDirPath() + '/' + id + '_' + (size || THUMB_DEFAULT) + '.jpg'
  try {
    if (await fileExists(path)) {
      mem[key] = fileUrl(path)
      return mem[key]
    }
  } catch (e) {}
  return ''
}

/**
 * 丢弃某个缓存键的指定尺寸（默认只丢 60）。
 * runJob 只判断文件是否存在就直接复用，URL 变了不删旧文件就永远拿不到新图；
 * 歌手换头像时由 artistavatar 调用。
 */
export async function dropCover(id, sizes) {
  const list = sizes && sizes.length ? sizes : [THUMB_DEFAULT]
  for (let i = 0; i < list.length; i++) {
    const sz = list[i] || THUMB_DEFAULT
    delete mem[keyOf(id, sz)]
    try {
      await rmQuiet(coversDirPath() + '/' + id + '_' + sz + '.jpg')
    } catch (e) {}
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

async function runJob(job) {
  const key = job.key
  const path = coversDirPath() + '/' + job.id + '_' + job.size + '.jpg'
  try {
    await ensureCoverDir()
    // 磁盘已有（跨会话缓存）
    if (await fileExists(path)) {
      mem[key] = fileUrl(path)
      fire(key, job.id, mem[key])
      return
    }
    // 下载缩略图（已在 URL 上带参数的不重复加）
    const url = job.url + (job.url.indexOf('?') >= 0 ? '' : thumbFor(job.size))
    try {
      await download({ url: url, outPath: path, timeout: 20000 })
    } catch (e) {
      await rmQuiet(path) // 清残留，本次不重试（避免重试风暴）
      fire(key, job.id, '')
      return
    }
    // http.download 返回时最后一块可能还没落盘（实测 1KB 首次 stat=0、100ms 后才完整）。
    // 交给 <image> 前做短暂等待，避免把 0 字节文件写进 mem 并显示成黑图。
    let size = await fileSize(path)
    for (let i = 0; i < 2 && !size; i++) {
      await sleep(50)
      size = await fileSize(path)
    }
    if (!size) {
      await rmQuiet(path)
      fire(key, job.id, '')
      return
    }
    mem[key] = fileUrl(path)
    fire(key, job.id, mem[key])
  } catch (e) {
    fire(key, job.id, '')
    log('cover', '封面失败 id=' + job.id + ': ' + ((e && e.message) || e))
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

/**
 * 单张确保（行组件用）：已就绪立即回调，否则入队等完成。
 * 行组件在 mounted 里调，回调里给自己组件的普通属性赋值 —— 绕开
 * 「页面 data 动态 key + $set」在 falcon 渲染器上不触发重渲染的问题（实测）。
 * cb: (id, fileUrl) => void（失败时 fileUrl 为空串）
 * size: 缩略图边长，默认 60（列表行）；播放页/歌手页用 300
 */
export function ensureCover(item, cb, size) {
  if (!item || !item.id || !item.cover) return
  enqueueCovers([item], cb, size)
}

/**
 * 批量入队封面下载（去重 + 限流）
 * items: [{id, cover}]，无 cover 的自动跳过（如搜索结果）
 * onReady: (id, fileUrl) => void —— 每张就绪回调一次（失败时为空串）
 * size: 见 ensureCover。id 不必是歌曲 id —— 头像/专辑封面可传 'arp123' / 'al456'
 *       这类前缀 id（cover.js 只把它当缓存键，不关心语义）
 */
export function enqueueCovers(items, onReady, size) {
  if (!items || !items.length) return
  const sz = size || THUMB_DEFAULT
  let n = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it || !it.id || !it.cover) continue
    const key = keyOf(it.id, sz)
    if (mem[key]) {
      onReady(it.id, mem[key])
      continue
    }
    if (inflight[key]) {
      inflight[key].push(onReady) // 已在下载：挂上回调，完成时一起通知
      continue
    }
    inflight[key] = [onReady]
    queue.push({ key: key, id: it.id, url: it.cover, size: sz })
    n++
  }
  if (n) log('cover', '入队 ' + n + ' 张 @' + sz + '（队列剩 ' + queue.length + '）')
  pump()
}
