/**
 * 关注歌手 / 收藏专辑（写操作走 weapi，与 like.js 同款）
 *
 * 接口（网易云 web 端同一套，PC 端尚未实测，**首次真机使用请核对日志**）：
 *   关注   POST /api/artist/sub    {artistId, artistIds:'[id]'} → {code:200, data:true}
 *   取关   POST /api/artist/unsub  {artistId, artistIds:'[id]'}
 *   收藏   POST /api/album/sub     {id}                        → {code:200}
 *   取消   POST /api/album/unsub   {id}
 *   状态   GET  /api/album/detail/dynamic?id= → {isSub:boolean, …}
 *          （歌手的关注状态取 /api/artist/{id} 回包的 artist.followed，见 api.js 的 fetchArtist）
 *
 * 状态口径：读不到就是 null（**不知道**），页面据此按「未关注/未收藏」显示；
 * 只有服务端 200 才写本地状态，失败一律回滚 —— 与 like.js 的既有约定一致。
 * 失败返回 {ok:false, code, needLogin, message}，不抛异常（页面只管回滚 + 提示）。
 */
import { weapiPost } from './weapi.js'
import { request } from '../net/request.js'

const BASE = 'https://music.163.com'
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com/',
  Accept: 'application/json, text/plain, */*'
}

const NEED_LOGIN = 301

/** weapi 写操作的统一返回口径 */
function pick(j, extra) {
  const code = (j && j.code) || 0
  if (code === 200) return Object.assign({ ok: true, code: 200, needLogin: false, message: '' }, extra || {})
  return {
    ok: false,
    code: code,
    needLogin: code === NEED_LOGIN,
    message: (j && j.message) || ''
  }
}

/** 关注 / 取关歌手；返回 {ok, code, needLogin, message} */
export async function setArtistFollowed(artistId, on) {
  if (!artistId) return { ok: false, code: 0, needLogin: false, message: '缺少歌手 id' }
  try {
    const r = await weapiPost(
      on ? '/api/artist/sub' : '/api/artist/unsub',
      { artistId: artistId, artistIds: JSON.stringify([artistId]) },
      { tag: 'artist-' + (on ? 'sub' : 'unsub') }
    )
    return pick(r.json, {})
  } catch (e) {
    return { ok: false, code: 0, needLogin: false, message: (e && e.message) || '' }
  }
}

/** 收藏 / 取消收藏专辑；返回 {ok, code, needLogin, message} */
export async function setAlbumSubscribed(albumId, on) {
  if (!albumId) return { ok: false, code: 0, needLogin: false, message: '缺少专辑 id' }
  try {
    const r = await weapiPost(
      on ? '/api/album/sub' : '/api/album/unsub',
      { id: albumId },
      { tag: 'album-' + (on ? 'sub' : 'unsub') }
    )
    return pick(r.json, {})
  } catch (e) {
    return { ok: false, code: 0, needLogin: false, message: (e && e.message) || '' }
  }
}

/**
 * 专辑收藏状态：true / false；未登录或接口不可用 → null（不写本地状态，下次还会重试）。
 * 这个端点只读、不产生副作用，所以放宽到「拿不到就当不知道」。
 */
export async function albumSubscribed(albumId) {
  if (!albumId) return null
  try {
    const r = await request({
      url: BASE + '/api/album/detail/dynamic?id=' + albumId,
      headers: HEADERS,
      timeout: 8000
    })
    if (r.status !== 200) return null
    const j = JSON.parse(r.body)
    if (j.code !== 200) return null
    return j.isSub === true
  } catch (e) {
    return null
  }
}
