// 歌单读接口（用户歌单列表 / 歌单曲目 / 歌单详情 / 批量取曲目，weapi 加密）。
// PC 端实测结论（100+ 歌单规模的账号）：
//   - /api/user/playlist 返回全部歌单（含订阅）：我喜欢 = specialType==5 且 creator.userId==自己
//     （坑：收藏别人的「XX喜欢的音乐」也是 specialType=5，必须带 creator 判断）；
//     我创建 = creator.userId==自己（含 privacy=10 私密歌单）；我收藏 = 其余（subscribed=true）
//   - /api/v6/playlist/detail 的 n 参数控制 tracks 内联条数（=min(n, trackCount)），trackIds 始终全量；
//     >1000 首的歌单服务器只内联 20 条，但这里 n<=300 够用
//   - /api/v3/song/detail 批量取曲目（c=[{id},…]），用于「加载更多」；/api/playlist/track/all 实测 404 不可用
import { weapiPost } from './weapi.js'
import { normalizeSong } from './api.js'

// 歌单归属的唯一判定点：'liked' | 'created' | 'subscribed'；拿不到创建者 id → ''。
// 「我喜欢」= specialType==5 且创建者是自己（收藏别人的「XX喜欢的音乐」也带 specialType=5）；
// creatorId / me 一律 Number 归一。
export function roleOf(o) {
  const t = o || {}
  const creatorId = Number(t.creatorId) || 0
  const me = Number(t.me) || 0
  if (!creatorId) return ''
  if (creatorId !== me) return 'subscribed'
  return Number(t.specialType) === 5 ? 'liked' : 'created'
}

// 取用户全部歌单并分类；返回 {liked, created[], subscribed[]}，item={id,name,count,cover,creator,updateTime}
export async function fetchUserPlaylists(uid) {
  const r = await weapiPost(
    '/api/user/playlist',
    { uid: uid, limit: 1000, offset: 0, includeVideo: true },
    { tag: 'playlists' }
  )
  const j = r.json || {}
  const list = j.playlist || (j.data && j.data.playlist) || []
  const liked = []
  const created = []
  const subscribed = []
  for (let i = 0; i < list.length; i++) {
    const p = list[i] || {}
    const creator = p.creator || {}
    const item = {
      id: p.id,
      name: p.name || '',
      count: p.trackCount || 0,
      cover: p.coverImgUrl || '',
      creator: creator.nickname || '',

      // 歌单列表页「按更新时间排序」用
      updateTime: p.updateTime || p.createTime || 0
    }
    const role = roleOf({ creatorId: creator.userId, specialType: p.specialType, me: uid })
    if (role === 'liked') liked.push(item)
    else if (role === 'created') created.push(item)
    else subscribed.push(item)
  }
  return { liked: liked[0] || null, created: created, subscribed: subscribed }
}

// 歌单曲目首页：返回 {name, trackCount, trackIds, addTimes, songs, inline}
// songs 为前 first 首（默认 50），更多用 fetchTracksMore(trackIds.slice(已加载))
// addTimes：{ 曲目id: 收藏时间戳(ms) }，整张歌单全量（trackIds 里每个条目都带 at），供「按收藏时间排序」用。
// 注意时间戳不在曲目对象上 —— 真机探针实测 tracks[] 里没有可用时间字段（pst 恒为 0），
// 只有 trackIds[] 的条目上有 {...at}，`at` 才是加入歌单的时间。
export async function fetchPlaylistTracks(playlistId, first) {
  const n = first || 50
  const r = await weapiPost('/api/v6/playlist/detail', { id: playlistId, n: n, s: 8 }, { tag: 'pl-detail' })
  const j = r.json || {}
  const pl = j.playlist || (j.data && j.data.playlist) || {}
  const raw = pl.tracks || []
  const songs = []
  for (let i = 0; i < raw.length; i++) songs.push(normalizeSong(raw[i]))
  const ids = []
  const addTimes = {}
  const tids = pl.trackIds || []
  for (let i = 0; i < tids.length; i++) {
    if (tids[i] && tids[i].id) {
      ids.push(tids[i].id)
      if (tids[i].at) addTimes[tids[i].id] = tids[i].at
    }
  }
  return {
    name: pl.name || '',
    trackCount: pl.trackCount || ids.length,
    trackIds: ids,
    addTimes: addTimes,
    songs: songs,

    // 这次内联回包实际占用的 trackIds 个数（= raw.length）。分页游标必须用它：
    // songs.length 可能小于内联条数（下架曲目没有曲目对象），拿它当游标会让下一页
    // 从偏小的下标开始、把上一批末尾重复取回来。
    inline: raw.length
  }
}

// 封面 URL 归一：详情接口给订阅歌单回的常是带签名的长 URL（…jpg?imageView=1&thumbnail=800y800&enlarge=…）。
// cover.js 只在 URL 没有 query 时才追加 ?param=200y200，带 query 的一律原样下载 ——
// PC 端实测同一张图：带 query 990KB、剥掉 query 走 param 通道只要 96KB。
function coverBase(url) {
  const s = String(url || '')
  const i = s.indexOf('?')
  return i >= 0 ? s.slice(0, i) : s
}

// 歌单详情（封面/介绍/归属/计数）——「歌单详情」页用。与 fetchPlaylistTracks 同一接口，但 n:0 不取曲目、只要元信息；
// PC 端实测该接口带 description / coverImgUrl / subscribed / specialType / creator.userId / trackCount。
// trackIds 仍然全量返回，所以本地歌单索引用一次请求就能拿到全量 id 快照。失败抛异常（页面自己 try/catch）。
export async function fetchPlaylistInfo(playlistId) {
  const r = await weapiPost(
    '/api/v6/playlist/detail',
    { id: playlistId, n: 0, s: 8 },
    { tag: 'pl-info' }
  )
  const j = r.json || {}
  const pl = j.playlist || (j.data && j.data.playlist) || {}
  const c = pl.creator || {}

  
  // trackIds 始终全量：本地索引只存 id 快照，不把几千首曲目对象塞进 storage。
  // n:0 时 tracks 为空，但 trackIds 仍在。
  const trackIds = []
  const tids = pl.trackIds || []
  for (let i = 0; i < tids.length; i++) {
    if (tids[i] && tids[i].id) trackIds.push(tids[i].id)
  }
  return {
    id: pl.id || playlistId,
    name: pl.name || '',
    desc: pl.description || '',
    cover: coverBase(pl.coverImgUrl),
    subscribed: !!pl.subscribed,
    specialType: pl.specialType || 0,
    creatorId: c.userId || 0,
    creator: c.nickname || '',
    trackCount: pl.trackCount || trackIds.length,
    playCount: pl.playCount || 0,
    updateTime: pl.updateTime || pl.createTime || 0,
    trackIds: trackIds
  }
}

// 取整张歌单的曲目对象（播放全部 / 下载全部用）：先用 playlist/detail 的 n:0 拿全量 trackIds，
// 再按 300/批走 /api/v3/song/detail；大歌单（>1000 首）也走这条，不依赖 detail 的内联曲目。
// onProgress(done, total) 可选；失败抛异常。
export async function fetchPlaylistAllSongs(playlistId, onProgress) {
  let ids = []
  try {
    const info = await fetchPlaylistInfo(playlistId)
    ids = info.trackIds || []
    if (!ids.length && info.trackCount > 0) {

      // 极少数回包不带 trackIds：退回 detail 的内联列表（最多 20 条）再尽量补
      const first = await fetchPlaylistTracks(playlistId, 50)
      ids = first.trackIds || []
    }
  } catch (e) {
    throw e
  }
  if (!ids.length) return []
  const out = []
  for (let off = 0; off < ids.length; off += 300) {
    const batch = ids.slice(off, off + 300)
    const more = await fetchTracksMore(batch)
    out.push.apply(out, more)
    if (typeof onProgress === 'function') {
      try {
        onProgress(out.length, ids.length)
      } catch (e) {}
    }
  }
  return out
}

// 批量取曲目详情的单批上限（接口请求体积）
export const TRACKS_CHUNK = 300

// 按 id 批量取曲目（保持传入顺序）；单次 id 太多体积吃不消，按 TRACKS_CHUNK 一批
export async function fetchTracksMore(ids) {
  const out = []
  const CHUNK = TRACKS_CHUNK
  for (let off = 0; off < ids.length; off += CHUNK) {
    const chunk = ids.slice(off, off + CHUNK)
    const c = []
    for (let i = 0; i < chunk.length; i++) c.push({ id: chunk[i] })
    const r = await weapiPost('/api/v3/song/detail', { c: JSON.stringify(c) }, { tag: 'tracks' })
    const j = r.json || {}
    const raw = j.songs || (j.data && j.data.songs) || []
    const map = {}
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] && raw[i].id) map[raw[i].id] = normalizeSong(raw[i])
    }
    for (let i = 0; i < chunk.length; i++) {
      if (map[chunk[i]]) out.push(map[chunk[i]])
    }
  }
  return out
}
