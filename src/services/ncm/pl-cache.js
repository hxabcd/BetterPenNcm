// 歌单缓存：模块级 userCache + 并发合并，以及依赖缓存的查询/计数。
import { fetchUserPlaylists } from './pl-read.js'

let userCache = null
let inflight = null

// 带缓存的用户歌单；force=true 强制刷新。
// 并发的相同请求合并成一个 Promise：首页、歌单页、个人中心会同时要这份数据（页面还会挂两遍），
// 不合并就是同一个动作打两三次接口。
export async function loadUserPlaylists(uid, force) {
  if (userCache && !force) return userCache
  if (inflight) return inflight
  inflight = fetchUserPlaylists(uid).then(
    function (r) {
      userCache = r
      inflight = null
      return r
    },
    function (e) {
      inflight = null
      throw e
    }
  )
  return inflight
}

// 作废用户歌单缓存 —— 账号变化时必须调（登录成功 / 退出登录）。
// 缓存只按模块级变量存、不区分 uid，不清的话换账号后会拿到上一个账号的歌单。
export function invalidateUserPlaylists() {
  userCache = null
}

// 在已缓存的用户歌单里查 pid 的归属：'liked' | 'created' | 'subscribed'；查不到（缓存没热）→ null。
// 用途：曲目列表页据此对订阅歌单隐藏「管理」键 —— 订阅歌单实测删不了（401 无权限），没必要让用户白走一遍。
// ⚠ 缓存里的 id 是数字，而 navTo 传进来的参数可能是字符串，比对前必须 Number() 归一（页面侧做）。
export function cachedPlaylistRole(playlistId) {
  const c = userCache
  const pid = Number(playlistId) || 0
  if (!c || !pid) return null
  if (c.liked && c.liked.id === pid) return 'liked'
  const groups = [['created', c.created], ['subscribed', c.subscribed]]
  for (let g = 0; g < groups.length; g++) {
    const arr = groups[g][1] || []
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === pid) return groups[g][0]
    }
  }
  return null
}

// 已缓存的歌单曲目数 ±1（只动内存，不重新请求）——收藏/取消、加歌成功后调，
// account 页与首页的统计数字就不用等下次重拉（loadUserPlaylists(force)）。
export function bumpCachedPlaylistCount(playlistId, d) {
  const c = userCache
  if (!c) return
  const groups = [c.created, c.subscribed]
  for (let g = 0; g < groups.length; g++) {
    const arr = groups[g] || []
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === playlistId) {
        arr[i].count = Math.max(0, (arr[i].count || 0) + d)
        return
      }
    }
  }
  if (c.liked && c.liked.id === playlistId) {
    c.liked.count = Math.max(0, (c.liked.count || 0) + d)
  }
}
