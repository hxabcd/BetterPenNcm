/**
 * 「播放全部 / 点行起播」的队列首段装配 + 后台补齐。
 *
 * 大歌单不再「先拉全量再起播」：首段够播就交给播放器（`player.playList`），
 * 剩下的按批取回来追加到队尾（`player.appendToQueue`），页面不等全量。
 *
 * 两条边界来自服务的取数量，别随手改：
 *   - 歌手曲目：队列上限 ARTIST_QUEUE_MAX=100 首（调用方按 /api/v1/artist/songs 的 offset 取）
 *   - 歌单曲目：首段 PLAYLIST_QUEUE_HEAD=300 首（= /api/v3/song/detail 单批上限，一次请求）
 */
import { fetchTracksMore } from '../ncm/playlist.js'
import { player } from './player.js'
import { log } from '../../core/infra/log.js'

/** 歌手曲目列表的播放队列上限（首）
 *  （周杰伦这类 500+ 首的歌手不值得为「播放全部」拉整份） */
export const ARTIST_QUEUE_MAX = 100

/** 歌单起播首段（= 一批 song/detail 的量） */
export const PLAYLIST_QUEUE_HEAD = 300

/** 后台补齐任务的序号：起新的就作废旧任务（上一次的循环在下一条日志处退出） */
let fillSeq = 0

/** 把页面给的挂载函数作用到一批曲目上（如歌单的收藏时间 at）；没给就原样返回 */
function attachTo(attach, songs) {
  if (typeof attach !== 'function') return songs
  try {
    return attach(songs) || songs
  } catch (e) {
    return songs
  }
}

/**
 * 歌单曲目队列：取前 head 个 id 的曲目对象（一次请求）立即返回；
 * 还有剩余时返回的 `fill()` 负责在后台逐批补齐（**不 await，不阻塞页面**）。
 *
 * attach：可选，(songs) => songs，用于给曲目挂页面状态（收藏时间等）。
 * 返回 { songs, fill: fn|null }；songs 可能少于 head（下架曲目取不回对象）。
 */
export async function playlistQueue(ids, head, attach) {
  const all = ids || []
  const n = Math.min(head || PLAYLIST_QUEUE_HEAD, all.length)
  const songs = attachTo(attach, await fetchTracksMore(all.slice(0, n)))
  if (n >= all.length) return { songs: songs, fill: null }
  return { songs: songs, fill: function () { startFill(all.slice(n), attach) } }
}

/**
 * 后台补齐循环：一批 300 个 id，取回后追加到队尾。
 * 队列代次对不上（用户换了队列/清空了）就停；请求失败也停 —— 不重试，
 * 免得离线时循环空转烧设备，用户重按「播放全部」即可。
 */
function startFill(restIds, attach) {
  const my = ++fillSeq
  const gen = player.queueToken()
  const total = restIds.length
  let done = 0
  ;(async function loop() {
    for (let off = 0; off < total; off += PLAYLIST_QUEUE_HEAD) {
      const batch = restIds.slice(off, off + PLAYLIST_QUEUE_HEAD)
      let songs = []
      try {
        songs = await fetchTracksMore(batch)
      } catch (e) {
        log('playqueue', '后台补齐中止：第 ' + (off + 1) + '~' + (off + batch.length) +
          ' 个 id 取回失败 ' + ((e && e.message) || e))
        return
      }
      if (my !== fillSeq) return // 又起了一份补齐任务，这份作废
      const r = player.appendToQueue(attachTo(attach, songs), { gen: gen })
      if (!r.ok) {
        log('playqueue', '后台补齐停止：' + (r.stale ? '队列已换或已清空' : '追加失败'))
        return
      }
      done += batch.length
      log('playqueue', '后台补齐 ' + done + '/' + total + ' 首，队列 ' + r.total + ' 首')
    }
  })()
}
