/**
 * 下载归属标记 —— 区分「用户自己的单曲」与「为本地索引歌单批量下载的文件」。
 *
 * 为什么需要它：本地下载页把已下载文件分成三类——
 *   单曲下载 / 歌单内歌曲 / 遗留歌曲（原歌单已移出索引，但按策略 A 保留文件）。
 * 只靠文件系统无法知道一首歌是怎么来的；于是给每首已下载歌曲记一个**归属标记**：
 *
 *   user     —— 用户主动下载（播放器下载键、专辑/歌手/搜索、列表多选），
 *               以及本功能上线前就存在的遗留文件（没有标记 = 按 user 处理）。
 *   playlist —— 只在「歌单详情 → 下载全部」、同步、自动同步时写入；
 *               这类文件在失去所有已索引歌单引用后，才归入「遗留歌曲」。
 *
 * 分类不需要记「来自哪个歌单」：只要知道它是不是歌单批量下载的，
 * 再结合当前所有已索引歌单的 baseIds ∪ remoteIds 动态派生即可
 * （见 locallists.js 的 classifyDownloaded）。这样移出索引 / 同步 D 都不必维护
 * 一张容易过期的孤儿表，重启、重复同步、崩溃都不会留下陈旧状态。
 *
 * 规则（与 download.js 的调用点一一对应）：
 *   - user 一旦写入就是终态：后续歌单批量下载只跳过，不改写。
 *   - playlist 写入前先看已有标记：已有 user 则保持 user。
 *   - 批量下载**跳过已存在的文件**时：没有标记 → 补 user（遗留文件按用户资产处理，
 *     绝不把用户已有的文件「认领」成歌单归属）；已有标记 → 保持。
 *   - 删除文件（任何入口）→ 清标记；清空已下载 → 清全表。
 *
 * 存储：单 key `bpncm_dl_origin`，JSON `{ "<songId>": 1|2 }`。
 */
import { getStorage, setStorage, removeStorage } from '../store.js'
import { log } from '../log.js'

const KEY = 'bpncm_dl_origin'
export const ORIGIN_USER = 1
export const ORIGIN_PLAYLIST = 2

let mem = null
let loading = null

async function load() {
  if (mem) return mem
  if (loading) return loading
  loading = (async function () {
    let obj = {}
    try {
      const raw = await getStorage(KEY)
      if (raw) obj = JSON.parse(raw) || {}
    } catch (e) {
      obj = {}
    }
    mem = obj
    loading = null
    return obj
  })()
  return loading
}

async function saveNow() {
  if (!mem) return
  try {
    await setStorage(KEY, JSON.stringify(mem))
  } catch (e) {}
}

/** 确保已载入（各导出函数内部都会等它） */
export function loadOrigin() {
  return load()
}

/** 归属标记（须先 await loadOrigin；未载入时返回 0） */
export function originOf(id) {
  if (!mem) return 0
  return mem[String(id)] || 0
}

/** 是不是用户自己的单曲；**没有标记也按 user 处理**（遗留文件） */
export function isUserOrLegacy(id) {
  return originOf(id) !== ORIGIN_PLAYLIST
}

export function isUser(id) {
  return originOf(id) === ORIGIN_USER
}

export function isPlaylistOwned(id) {
  return originOf(id) === ORIGIN_PLAYLIST
}

/**
 * 标记用户自己的单曲（手动下载）。数组批量，写一次盘。
 * 已有 playlist 标记会被 user 覆盖（用户明确要了这首，归属归用户）。
 */
export async function markUser(ids) {
  await load()
  const arr = ids || []
  let n = 0
  for (let i = 0; i < arr.length; i++) {
    const id = String(arr[i] || '')
    if (!id) continue
    if (mem[id] !== ORIGIN_USER) {
      mem[id] = ORIGIN_USER
      n++
    }
  }
  if (n) {
    await saveNow()
    log('origin', '标记用户单曲 ' + n + ' 首')
  }
  return n
}

/**
 * 标记歌单批量下载。数组批量，写一次盘。
 * 已有 user 的保持 user；已有 playlist 的保持；没有标记的写成 playlist。
 * 返回新标记数量。
 */
export async function markPlaylist(ids) {
  await load()
  const arr = ids || []
  let n = 0
  for (let i = 0; i < arr.length; i++) {
    const id = String(arr[i] || '')
    if (!id) continue
    if (mem[id]) continue
    mem[id] = ORIGIN_PLAYLIST
    n++
  }
  if (n) {
    await saveNow()
    log('origin', '标记歌单归属 ' + n + ' 首')
  }
  return n
}

/**
 * 歌单批量下载**跳过已存在文件**时的归属处理：
 *   - 没有任何标记 → 补 user（遗留文件 / 用户以前自己下的，按用户资产处理）
 *   - 已有标记 → 原样保留
 * 这样「下载全部」不会把用户已有的文件认领成歌单归属，移出索引时也不会误进遗留。
 */
export async function markSkippedExisting(ids) {
  await load()
  const arr = ids || []
  let n = 0
  for (let i = 0; i < arr.length; i++) {
    const id = String(arr[i] || '')
    if (!id) continue
    if (mem[id]) continue
    mem[id] = ORIGIN_USER
    n++
  }
  if (n) {
    await saveNow()
    log('origin', '跳过已存在文件，补记用户归属 ' + n + ' 首')
  }
  return n
}

/** 删单首/多首 → 清标记（文件删掉后归属也失效） */
export async function clearOrigin(ids) {
  await load()
  const arr = ids || []
  let n = 0
  for (let i = 0; i < arr.length; i++) {
    const id = String(arr[i] || '')
    if (id && mem[id]) {
      delete mem[id]
      n++
    }
  }
  if (n) await saveNow()
  return n
}

/** 清空全部标记（存储管理「清空已下载」时调） */
export async function clearAllOrigins() {
  mem = {}
  try {
    await removeStorage(KEY)
  } catch (e) {}
  log('origin', '已清空下载归属标记')
}

/** 当前标记表快照（诊断/日志用；返回 ids 数组） */
export async function originSnapshot() {
  await load()
  const user = []
  const playlist = []
  const keys = Object.keys(mem || {})
  for (let i = 0; i < keys.length; i++) {
    if (mem[keys[i]] === ORIGIN_USER) user.push(keys[i])
    else if (mem[keys[i]] === ORIGIN_PLAYLIST) playlist.push(keys[i])
  }
  return { user: user, playlist: playlist }
}
