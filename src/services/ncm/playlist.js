/**
 * 歌单：用户歌单列表 / 歌单曲目（weapi 加密）
 *
 * PC 端实测结论（一个 100+ 歌单规模的账号）：
 *   - /api/user/playlist 返回全部歌单（含订阅）：
 *       我喜欢  = specialType==5 且 creator.userId==自己
 *                 （坑：收藏别人的「XX喜欢的音乐」也是 specialType=5，必须带 creator 判断）
 *       我创建  = creator.userId==自己（含 privacy=10 私密歌单）
 *       我收藏  = 其余（subscribed=true）
 *   - /api/v6/playlist/detail 的 n 参数控制 tracks 内联条数（=min(n, trackCount)），
 *     trackIds 始终全量；>1000 首的歌单服务器只内联 20 条，但这里 n<=300 够用
 *   - /api/v3/song/detail 批量取曲目（c=[{id},…]），用于「加载更多」；
 *     /api/playlist/track/all 实测 404 不可用
 *   - 增删曲目都走 /api/playlist/manipulate/tracks（add/del，可批量），见 addToPlaylist / removeFromPlaylist
 */
import { weapiPost } from './weapi.js'
import { normalizeSong } from './api.js'

/** 取用户全部歌单并分类；返回 {liked, created[], subscribed[]}，item={id,name,count,cover,creator} */
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
      // 歌单列表页「按更新时间排序」用（加）
      updateTime: p.updateTime || p.createTime || 0
    }
    if (p.specialType === 5 && creator.userId === uid) liked.push(item)
    else if (creator.userId === uid) created.push(item)
    else subscribed.push(item)
  }
  return { liked: liked[0] || null, created: created, subscribed: subscribed }
}

/**
 * 歌单曲目首页：返回 {name, trackCount, trackIds, addTimes, songs, inline}
 * songs 为前 first 首（默认 50），更多用 fetchTracksMore(trackIds.slice(已加载))
 * inline = 回包实际内联的 trackIds 条数（分页游标用，见返回值注释）
 *
 * addTimes：{ 曲目id: 收藏时间戳(ms) }，**整张歌单全量**（trackIds 里每个条目都带 at），
 * 供曲目列表页「按收藏时间排序」用。注意时间戳**不在曲目对象上**——真机探针实测：
 * tracks[] 里没有可用的时间字段（pst 恒为 0），只有 trackIds[] 的条目上有
 * `{id, v, t, at, uid, alg, …}`，`at` 就是加入歌单的时间。
 */
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
    /* 这次内联回包实际占用的 trackIds 个数（= raw.length）。分页游标必须用它：
       songs.length 可能小于内联条数（下架曲目没有曲目对象），拿它当游标会让下一页
       从偏小的下标开始、把上一批末尾重复取回来。 */
    inline: raw.length
  }
}

/* ---- 用户歌单缓存（主页 / 歌单列表页 / 个人中心共用，避免重复请求） ---- */

let userCache = null
let inflight = null

/**
 * 带缓存的用户歌单；force=true 强制刷新。
 * **并发的相同请求合并成一个 Promise**：首页、歌单页、个人中心会同时要这份数据
 * （页面还会挂两遍），不合并就是同一个动作打两三次接口。
 */
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

export function cachedUserPlaylists() {
  return userCache
}

/**
 * 作废用户歌单缓存 —— **账号变化时必须调**（登录成功 / 退出登录）。
 * 缓存只按模块级变量存、不区分 uid，不清的话换账号后会拿到上一个账号的歌单。
 */
export function invalidateUserPlaylists() {
  userCache = null
}

/**
 * 把一首歌加进歌单（weapi）
 *
 * PC 端实测（见 docs/运行时API参考.md §7）：
 *   POST /api/playlist/manipulate/tracks {op:'add', pid, trackIds:'[id]', imme:'true'}
 *     → {trackIds, code:200, count}       成功
 *     → {code:502, '歌单内歌曲重复'}       重复（结果已达成）
 *     → {code:401, '无权限操作歌单'}       订阅（别人的）歌单加不了
 *     → {code:301}                        未登录
 * 返回 {ok, code, dup, needLogin, message}；异常 → {ok:false, code:0}
 */
export async function addToPlaylist(playlistId, songId) {
  try {
    const r = await weapiPost(
      '/api/playlist/manipulate/tracks',
      { op: 'add', pid: playlistId, trackIds: JSON.stringify([songId]), imme: 'true' },
      { tag: 'pl-add' }
    )
    const j = r.json || {}
    const code = j.code || 0
    if (code === 200) {
      bumpCachedPlaylistCount(playlistId, 1)
      return { ok: true, code: 200, dup: false, needLogin: false, count: j.count || 0 }
    }
    return {
      ok: false,
      code: code,
      dup: code === 502,
      needLogin: code === 301,
      message: j.message || ''
    }
  } catch (e) {
    return { ok: false, code: 0, dup: false, needLogin: false, message: (e && e.message) || '' }
  }
}

/**
 * 把**多首**歌加进歌单（多选态「收藏到歌单」用）
 *
 * 与 removeFromPlaylist 对称：trackIds 一次传多个 id（接口本来就收数组，
 * addToPlaylist 只传一个是因为它服务「单曲加入」）。**逐条吞掉 502（重复）**：
 * 多选里常有几首目标歌单已经有了，整批按失败处理会让用户以为一首都没进去。
 *
 * 返回 {ok, added, dup, code, needLogin, denied, message}
 *   ok   = 至少有一首真正加进去（或全部本就是重复 —— 结果已达成）
 *   401/301 这类整体性失败直接返回，不再逐首重试。
 */
export async function addToPlaylistMany(playlistId, songIds) {
  const ids = songIds || []
  if (!playlistId || !ids.length) {
    return { ok: false, added: 0, dup: 0, code: 0, needLogin: false, denied: false, message: '未选择歌曲' }
  }
  try {
    const r = await weapiPost(
      '/api/playlist/manipulate/tracks',
      { op: 'add', pid: playlistId, trackIds: JSON.stringify(ids), imme: 'true' },
      { tag: 'pl-add-many' }
    )
    const j = r.json || {}
    const code = j.code || 0
    if (code === 200) {
      bumpCachedPlaylistCount(playlistId, ids.length)
      return { ok: true, added: ids.length, dup: 0, code: 200, needLogin: false, denied: false, message: '' }
    }
    if (code === 502) {
      // 整批里有重复 → 退回逐首加，把「重复」与「真失败」分开计
      return await addEach(playlistId, ids)
    }
    return {
      ok: false,
      added: 0,
      dup: 0,
      code: code,
      needLogin: code === 301,
      denied: code === 401,
      message: j.message || ''
    }
  } catch (e) {
    return { ok: false, added: 0, dup: 0, code: 0, needLogin: false, denied: false, message: (e && e.message) || '' }
  }
}

/** 逐首加（批量接口回 502 时的兜底）：返回口径同 addToPlaylistMany */
async function addEach(playlistId, ids) {
  let added = 0
  let dup = 0
  let failCode = 0
  for (let i = 0; i < ids.length; i++) {
    const r = await addToPlaylist(playlistId, ids[i])
    if (r.ok) added++
    else if (r.dup) dup++
    else failCode = r.code || failCode
  }
  return {
    ok: added > 0 || dup === ids.length,
    added: added,
    dup: dup,
    code: added > 0 ? 200 : failCode,
    needLogin: failCode === 301,
    denied: failCode === 401,
    message: ''
  }
}

/**
 * 从歌单**批量**移除曲目（weapi）——「歌单管理 → 多选删除」用
 *
 * PC 端实测（`test_del_batch.py` + `test_del_liked.py`，
 * 两轮都做了往返恢复、账号净零改动）：
 *   POST /api/playlist/manipulate/tracks {op:'del', pid, trackIds:'[id,…]'}
 *     → {code:200, count}           **一次可传多个 id**；回包**不带 trackIds**（与 add 不同）
 *     → {code:200, count 不变}      曲目本就不在歌单里（幂等，不算错）
 *     → {code:401, '无权限操作歌单'} 订阅（别人的）歌单
 *     → {code:301}                  未登录
 *   **「我喜欢」也是同一张歌单**：对它 op:'del' 就是取消喜欢（test_del_liked.py 用
 *   like/check 前后验证过），所以 liked 分支不用另走 /api/song/like 逐首取消。
 *   `imme:'true'` 实测不加也生效，这里与 addToPlaylist 保持一致写上。
 *
 * 返回 {ok, code, count, needLogin, denied, message}；异常 → {ok:false, code:0}
 */
export async function removeFromPlaylist(playlistId, ids) {
  const arr = ids || []
  if (!playlistId || !arr.length) {
    return { ok: false, code: 0, count: 0, needLogin: false, denied: false, message: '未选择歌曲' }
  }
  try {
    const r = await weapiPost(
      '/api/playlist/manipulate/tracks',
      { op: 'del', pid: playlistId, trackIds: JSON.stringify(arr), imme: 'true' },
      { tag: 'pl-del' }
    )
    const j = r.json || {}
    const code = j.code || 0
    if (code === 200) {
      bumpCachedPlaylistCount(playlistId, -arr.length)
      return { ok: true, code: 200, count: j.count || 0, needLogin: false, denied: false, message: '' }
    }
    return {
      ok: false,
      code: code,
      count: 0,
      needLogin: code === 301,
      denied: code === 401,
      message: j.message || ''
    }
  } catch (e) {
    return {
      ok: false,
      code: 0,
      count: 0,
      needLogin: false,
      denied: false,
      message: (e && e.message) || ''
    }
  }
}

/**
 * 歌单详情（封面 / 介绍 / 归属 / 计数）—— 「歌单详情」页（pages/plinfo）用
 *
 * 与 fetchPlaylistTracks 同一个接口（v6/playlist/detail），但 n:0 不取曲目、只要元信息：
 * PC 端实测该接口带有 description / coverImgUrl / subscribed / specialType / creator.userId / trackCount。
 * **trackIds 仍然全量返回**，所以本地歌单索引（locallists.js）用一次请求就能拿到全量 id 快照。
 * 失败抛异常（页面自己 try/catch 显示「加载失败」）。
 */
/**
 * 封面 URL 归一：详情接口给**订阅歌单**回的常是带签名的长 URL
 * （`…jpg?imageView=1&thumbnail=800y800&enlarge=…`）。cover.js 只在 URL **没有** query 时才追加
 * `?param=200y200`，带 query 的一律原样下载 —— PC 端实测同一张图：带 query 的 990KB、剥掉 query 走
 * param 通道只要 96KB。所以这里先剥掉 query，交给 cover.js 的缩略图通道。
 */
function coverBase(url) {
  const s = String(url || '')
  const i = s.indexOf('?')
  return i >= 0 ? s.slice(0, i) : s
}

export async function fetchPlaylistInfo(playlistId) {
  const r = await weapiPost(
    '/api/v6/playlist/detail',
    { id: playlistId, n: 0, s: 8 },
    { tag: 'pl-info' }
  )
  const j = r.json || {}
  const pl = j.playlist || (j.data && j.data.playlist) || {}
  const c = pl.creator || {}
  // trackIds 始终全量（见 docs/歌单接口边界.md）；本地索引只存 id 快照，
  // 不把几千首曲目对象塞进 storage。n:0 时 tracks 为空，但 trackIds 仍在。
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

/**
 * 取整张歌单的曲目对象（播放全部 / 下载全部用）：
 * 先用 playlist/detail 的 n:0 拿全量 trackIds，再按 300/批走 /api/v3/song/detail。
 * 大歌单（>1000 首）也走这条，不依赖 detail 的内联曲目。
 * onProgress(done, total) 可选；失败抛异常。
 */
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

/**
 * 收藏 / 取消收藏（订阅）别人的歌单；on=true 收藏、false 取消。
 *
 * PC 端实测（`test_plinfo*.py`，往返恢复、账号净零改动）：
 *   POST /api/playlist/subscribe   {id} → {code:200}
 *   POST /api/playlist/unsubscribe {id} → {code:200}
 *   ⚠ **subscribe 的 `t` 参数实测无效**：`t:0` 也当「订阅」；`t:-1` / `t:"false"` → `{code:501}`。
 *     所以「取消收藏」必须走 unsubscribe 这条独立路径，别指望一个接口加 t 参数搞定。
 *   ⚠ 订阅自己的歌单 → `{code:401, '歌单创建者已设置隐私'}`（客户端只对别人的歌单给这个按钮）。
 * 成功后作废歌单缓存（收藏状态/歌单列表都变了）。
 */
export async function setSubscribed(playlistId, on) {
  const path = on ? '/api/playlist/subscribe' : '/api/playlist/unsubscribe'
  const r = await callWrite(path, { id: playlistId }, on ? 'pl-sub' : 'pl-unsub')
  if (r.ok) invalidateUserPlaylists()
  return r
}

/**
 * 重命名歌单
 *
 * PC 端实测：`POST /api/playlist/update/name {id, name}` → `{code:200}`。
 * ⚠ 老的「整包更新」`playlist/update`（带 name/desc/tags）实测 **404 接口未找到**，别走那条。
 */
export async function renamePlaylist(playlistId, name) {
  const r = await callWrite('/api/playlist/update/name', { id: playlistId, name: name }, 'pl-rename')
  if (r.ok) invalidateUserPlaylists()
  return r
}

/**
 * 新建歌单
 *
 * PC 端实测（`probe_plcreate.py` / `probe_plcreate2.py`，建→读→删，账号净零改动）：
 *   POST /api/playlist/create {name} → {code:200, id, playlist:{id,name,trackCount:0,…}}
 *     - **新歌单 id 从顶层 `id` 取**（`playlist.id` 同值，两者都给，写 `j.id || pl.id` 就稳）
 *     - 回包的 `playlist.creator` 是 **null**，别指望从它拿创建者
 *     - 建完**立刻**就能在 /api/user/playlist 里查到，也能立刻 manipulate/tracks 加歌
 *       （这是「添加到歌单」里「新建并加入」能一步完成的前提）
 *   失败口径：
 *     - `{code:400,'标题字数异常，请修改'}`  空名 / 纯空格 / 超长（见 fitPlaylistName）
 *     - `{code:405,'操作过于频繁，请稍后再试'}`  **连续新建会被限频**（间隔 15s 才不限）
 *     - `{code:301}` 未登录
 * 成功后作废歌单缓存（列表变了）；返回 {ok, id, name, code, needLogin, message}。
 */
export async function createPlaylist(name) {
  try {
    const r = await weapiPost('/api/playlist/create', { name: name }, { tag: 'pl-create' })
    const j = r.json || {}
    const code = j.code || 0
    if (code === 200) {
      invalidateUserPlaylists()
      const pl = j.playlist || {}
      return {
        ok: true,
        id: j.id || pl.id || 0,
        name: pl.name || name,
        code: 200,
        needLogin: false,
        message: ''
      }
    }
    return {
      ok: false,
      id: 0,
      name: '',
      code: code,
      needLogin: code === 301,
      message: j.message || ''
    }
  } catch (e) {
    return { ok: false, id: 0, name: '', code: 0, needLogin: false, message: (e && e.message) || '' }
  }
}

/**
 * 歌单名的长度校验/截断 —— 服务端按**显示宽度**卡 40（CJK 记 2、ASCII 记 1），
 * 不是按字符数也不是按字节数。PC 端实测（probe_plcreate2.py，创建后即时删除）：
 *   20 汉字(宽40) ✅ / 21 汉字(宽42) ❌ / 40 ASCII(宽40) ✅ / 41 ASCII(宽41) ❌
 *   18 汉字+4 字母(宽40) ✅ / 19 汉字+3 字母(宽41) ❌ —— 所以既不是 ≤20 字也不是 ≤60 字节。
 * 超过 → `{code:400,'标题字数异常，请修改'}`，客户端先截到合法宽度再发，别让用户白点一次。
 * 返回 {name, cut}（cut=true 表示被截过）。
 */
export const PLAYLIST_NAME_WIDTH = 40

export function fitPlaylistName(s) {
  const str = String(s || '')
  let w = 0
  let end = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    const step = c > 0x2e80 ? 2 : 1 // CJK（含中日韩及全角标点）记 2
    if (w + step > PLAYLIST_NAME_WIDTH) break
    w += step
    end = i + 1
  }
  return { name: str.slice(0, end), cut: end < str.length }
}

/**
 * 删除歌单
 *
 * PC 端实测：`POST /api/playlist/remove {ids: '[id]'}` → `{code:200}`（歌单随即从 /api/user/playlist 消失）。
 * ⚠ 直觉上的 `playlist/delete` 实测是 **400 请求参数错误**，正确路径是 `playlist/remove`。
 */
export async function deletePlaylist(playlistId) {
  const r = await callWrite(
    '/api/playlist/remove',
    { ids: JSON.stringify([playlistId]) },
    'pl-del-playlist'
  )
  if (r.ok) invalidateUserPlaylists()
  return r
}

/**
 * 三个写接口共用的调用/解析壳（返回形状对齐 addToPlaylist / removeFromPlaylist）：
 * `{ok, code, needLogin, message}`；网络异常也包成 `{ok:false, code:0}`。
 */
async function callWrite(path, payload, tag) {
  try {
    const r = await weapiPost(path, payload, { tag: tag })
    const j = r.json || {}
    const code = j.code || 0
    if (code === 200) return { ok: true, code: 200, needLogin: false, message: '' }
    return {
      ok: false,
      code: code,
      needLogin: code === 301,
      message: j.message || ''
    }
  } catch (e) {
    return { ok: false, code: 0, needLogin: false, message: (e && e.message) || '' }
  }
}

/**
 * 在**已缓存的**用户歌单里查 pid 的归属：'liked' | 'created' | 'subscribed'；查不到（缓存没热）→ null。
 *
 * 用途：曲目列表页据此**对订阅歌单隐藏「管理」键** —— 订阅歌单实测删不了（401 无权限），
 * 没必要让用户白走一遍。⚠ 缓存里的 id 是数字，而 navTo 传进来的参数可能是字符串，
 * 比对前必须 Number() 归一（页面侧做）。
 */
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

/**
 * 已缓存的歌单曲目数 ±1（只动内存，不重新请求）——收藏/取消、加歌成功后调，
 * account 页与首页的统计数字就不用等下次重拉（`loadUserPlaylists(force)`）。
 */
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

/** 按 id 批量取曲目（保持传入顺序）；单次 id 太多体积吃不消，按 300 一批 */
export async function fetchTracksMore(ids) {
  const out = []
  const CHUNK = 300
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
