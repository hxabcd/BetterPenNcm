/**
 * 歌手头像的唯一入口。
 *
 * 统一规则：**真头像优先，专辑封面兜底**，且两者用不同的缓存键——
 *   - 真头像：arp<artistId>@<size>，URL 存 artistmeta（来自 /api/artist/head/info/get）
 *   - 兜底图：al<albumId>@<size>，就是代表专辑封面（下载落盘时已预热，离线可命中）
 * 老实现把「在线真头像」和「本地专辑封面」都写在 ar<id>@200 上，谁先落盘谁生效，
 * 且列表另用 ar<id>@120，导致同一歌手在不同页面显示不同来源；这里不再共用那个键。
 *
 * 谁在什么时机请求接口：
 *   - 下载完成：只入队预热列表尺寸 60（异步、去重、限流、失败即止），不阻塞下载；
 *   - 本地下载-歌手列表：行组件在线时按需解析（命中 meta 或已有封面就不发请求）；
 *   - 歌手详情：在线路径本来就有 picUrl，直接记住并预热 60/200；本地视图在线时也允许
 *     解析一次真头像，离线则只用已缓存的图。
 */
import { fetchArtistHead } from './ncm/api.js'
import { ensureCover, cachedCover, cachedCoverOnDisk, dropCover } from './cover.js'
import { loadArtistMeta, artistMetaSync, rememberArtist, normalizePic } from './artistmeta.js'
import { isOffline } from './net/status.js'
import { log } from './log.js'

/** 列表行头像盒 26vh ≈ 62px，60 已点对点够用 */
export const PORTRAIT_SIZE = 60
/** 歌手详情大头像（与 cover.js 的 BIG_COVER 同值） */
export const PORTRAIT_BIG = 200

const PREFETCH_MAX = 64
const NEG_TTL = 7 * 24 * 3600 * 1000
const HEAD_CONC = 2

const headWait = {} // id -> [resolve, ...]（同 id 只发一次请求）
const headQueue = []
let headActive = 0
let prefetchChain = Promise.resolve()

/** 真头像的封面缓存键；兜底图请用 al<albumId> */
export function portraitId(artistId) {
  return 'arp' + artistId
}

/**
 * 解析一位歌手的真头像本地文件（file:// URL）；没有/取不到返回 ''。
 * allowNet=false 时只看缓存与 meta，不发请求。
 */
export async function resolveArtistPortrait(artistId, size, allowNet) {
  const id = Number(artistId) || 0
  if (!id) return ''
  const sz = size || PORTRAIT_SIZE
  const key = portraitId(id)

  const hit = cachedCover(key, sz)
  if (hit) return hit
  const disk = await cachedCoverOnDisk(key, sz)
  if (disk) return disk

  await loadArtistMeta()
  const meta = artistMetaSync(id)
  // 负缓存：查过没有头像；过了负缓存期允许重试
  if (meta && !meta.p && meta.t && Date.now() - meta.t < NEG_TTL) return ''
  if (allowNet === false) return ''
  if (await isOffline()) return ''

  let url = (meta && meta.p) || ''
  if (!url) {
    const head = await requestHead(id)
    if (!head || !head.cover) return ''
    url = head.cover
  }
  return await ensureAsync({ id: key, cover: url }, sz)
}

/**
 * 记住在线接口拿到的头像（歌手详情页 fetchArtist 的 picUrl）。
 * URL 变了先删旧的 arp 缓存，否则 runJob 只会复用旧文件。
 * 顺手预热列表尺寸 60，返回规范化的 URL。
 */
export async function rememberArtistPortrait(artistId, name, cover) {
  const id = Number(artistId) || 0
  if (!id) return ''
  await loadArtistMeta()
  const prev = artistMetaSync(id)
  const url = normalizePic(cover)
  if (!url && prev && prev.p) return prev.p // 接口这次没给图：保留已知头像
  const rec = await rememberArtist(id, name, url)
  const now = (rec && rec.p) || ''
  if (now && prev && prev.p && prev.p !== now) {
    await dropCover(portraitId(id), [PORTRAIT_SIZE, PORTRAIT_BIG])
  }
  if (now) preheatOne(id, now, PORTRAIT_SIZE)
  return now
}

/**
 * 下载完成后的旁路预热：只取列表尺寸 60，按歌手去重、串行、限量、连续失败即止。
 * 调用方不要 await（saveSongExtras 只负责把任务挂上）。
 */
export function enqueueArtistPortraits(artists) {
  try {
    if (!artists || !artists.length) return
    prefetchChain = prefetchChain.then(function () {
      return prefetchBatch(artists)
    }).catch(function () {})
  } catch (e) {}
}

/* ---------------- 内部实现 ---------------- */

async function prefetchBatch(artists) {
  try {
    await loadArtistMeta()
    if (await isOffline()) return
    const seen = {}
    const ids = []
    for (let i = 0; i < artists.length; i++) {
      const a = artists[i] || {}
      const id = Number(a.id) || 0
      if (!id || seen[id]) continue
      seen[id] = 1
      const meta = artistMetaSync(id)
      if (meta && (meta.p || (meta.t && Date.now() - meta.t < NEG_TTL))) continue
      ids.push(id)
      if (ids.length >= PREFETCH_MAX) break
    }
    if (!ids.length) return
    let fails = 0
    for (let i = 0; i < ids.length; i++) {
      if (fails >= 2) {
        log('avatar', '连续失败，本轮头像预热提前结束')
        break
      }
      const head = await requestHead(ids[i])
      if (!head) {
        fails++
        continue
      }
      fails = 0
      if (head.cover) await preheatOne(ids[i], head.cover, PORTRAIT_SIZE)
    }
    log('avatar', '预热歌手头像 ' + ids.length + ' 位')
  } catch (e) {}
}

function preheatOne(artistId, url, size) {
  return ensureAsync({ id: portraitId(artistId), cover: url }, size)
}

function ensureAsync(item, size) {
  return new Promise(function (resolve) {
    if (!item || !item.id || !item.cover) {
      resolve('')
      return
    }
    ensureCover(item, function (cid, path) {
      resolve(path || '')
    }, size)
  })
}

function requestHead(artistId) {
  const id = Number(artistId) || 0
  if (!id) return Promise.resolve(null)
  return new Promise(function (resolve) {
    if (headWait[id]) {
      headWait[id].push(resolve)
      return
    }
    headWait[id] = [resolve]
    headQueue.push(id)
    pumpHead()
  })
}

function finishHead(id, res) {
  const waits = headWait[id] || []
  delete headWait[id]
  for (let i = 0; i < waits.length; i++) {
    try {
      waits[i](res)
    } catch (e) {}
  }
}

function pumpHead() {
  while (headActive < HEAD_CONC && headQueue.length) {
    const id = headQueue.shift()
    headActive++
    Promise.resolve()
      .then(function () {
        return fetchArtistHead(id)
      })
      .then(function (a) {
        const cover = (a && a.cover) || ''
        return rememberArtist(id, (a && a.name) || '', cover).then(function () {
          finishHead(id, { id: (a && a.id) || id, name: (a && a.name) || '', cover: cover })
        })
      })
      .catch(function (e) {
        log('avatar', '歌手头像接口失败 id=' + id + ' ' + ((e && e.message) || e))
        finishHead(id, null)
      })
      .then(function () {
        headActive--
        pumpHead()
      })
  }
}
