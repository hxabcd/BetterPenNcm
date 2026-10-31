/**
 * 「喜欢」状态 —— 收藏到「我喜欢的音乐」（weapi 加密）
 *
 * PC 端实测（见 docs/运行时API参考.md §7）：
 *   POST /api/song/like/check  {trackIds:'[id]'}（JSON 字符串）→ {ids:[已喜欢的 id…], code:200}；未登录 301
 *   POST /api/song/like        {trackId, like:'true'|'false'} → {playlistId, code:200}；未登录 301
 *   csrf_token 由 weapi.js 统一附加。
 *
 * 缓存：id → bool 的模块级 map（跨页面同一实例，播放页查过就不再打接口）。
 * **只在服务端确认（200）时写缓存**，失败一律不写 —— 保证「失败后重进页面看到的是真值」。
 */
import { weapiPost } from './weapi.js'
import { bumpCachedPlaylistCount } from './playlist.js'

export const NEED_LOGIN = 301

const cache = {} // 'id' -> true/false

function key(id) {
  return String(id || 0)
}

/** 读缓存：true / false；没查过 → null */
export function cachedLiked(id) {
  const k = key(id)
  return cache[k] === undefined ? null : cache[k]
}

/**
 * 查一首歌是否已喜欢；返回 true/false；
 * 未登录 / 接口失败 / 网络异常 → null（不写缓存，下次还会重试）
 */
export async function checkLiked(id) {
  if (!id) return null
  try {
    const r = await weapiPost(
      '/api/song/like/check',
      { trackIds: JSON.stringify([id]) },
      { tag: 'like-check' }
    )
    const j = r.json || {}
    if (j.code !== 200) return null
    const ids = j.ids || []
    // 回包 ids 是数字数组；调用方可能传字符串 id，两种都比一遍
    const liked = ids.indexOf(Number(id)) >= 0 || ids.indexOf(key(id)) >= 0
    cache[key(id)] = liked
    return liked
  } catch (e) {
    return null
  }
}

/**
 * 本地把一批 id 置为「未喜欢」——**只在服务端确认删除成功后调**
 * （曲目列表页的「管理」从「我喜欢」里删歌 = 取消喜欢，走 playlist/manipulate/tracks 的 op:'del'，
 * 那条路不经过 setLiked，所以缓存要在这里手动对齐；播放页读的是缓存，
 * 不对齐就会一直显示红心，直到重启应用）。
 *
 * 为什么由页面调而不是 playlist.js 里调：like.js 已经 import playlist.js，
 * 反向 import 会成环（同 bumpCachedPlaylistCount 的注释）。
 */
export function markUnliked(ids) {
  const a = ids || []
  for (let i = 0; i < a.length; i++) cache[key(a[i])] = false
}

/**
 * 喜欢 / 取消；返回 {ok, code, needLogin, playlistId}
 * 网络异常也包成 {ok:false, code:0}（调用方只管回滚 + 提示）
 */
export async function setLiked(id, on) {
  try {
    const r = await weapiPost(
      '/api/song/like',
      { trackId: id, like: on ? 'true' : 'false' },
      { tag: 'like' }
    )
    const j = r.json || {}
    if (j.code === 200) {
      cache[key(id)] = !!on
      // 「我喜欢」就是一张歌单：回包的 playlistId 就是它 —— 同步缓存里的曲目数
      // （account 页/首页的统计不用等下次重拉；playlist.js 不反向依赖本模块，无循环）
      const pid = j.playlistId || 0
      if (pid) bumpCachedPlaylistCount(pid, on ? 1 : -1)
      return { ok: true, code: 200, needLogin: false, playlistId: pid }
    }
    return {
      ok: false,
      code: j.code || 0,
      needLogin: j.code === NEED_LOGIN,
      message: j.message || ''
    }
  } catch (e) {
    return { ok: false, code: 0, needLogin: false, message: (e && e.message) || '' }
  }
}
