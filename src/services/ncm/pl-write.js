// 歌单写接口（增删曲目 / 订阅 / 改名 / 新建 / 删除，weapi 加密）。
// 增删曲目都走 /api/playlist/manipulate/tracks（add/del，可批量）。
import { weapiPost } from './weapi.js'
import { invalidateUserPlaylists, bumpCachedPlaylistCount } from './pl-cache.js'

// 把一首歌加进歌单（weapi）。POST /api/playlist/manipulate/tracks {op:'add', pid, trackIds:'[id]', imme:'true'}
// PC 端实测：200 成功（回 {trackIds, code, count}）/ 502 '歌单内歌曲重复'（结果已达成）/
// 401 '无权限操作歌单'（别人的歌单加不了）/ 301 未登录。
// 返回 {ok, code, dup, needLogin, message}；异常 → {ok:false, code:0}
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

// 把多首歌加进歌单（多选态「收藏到歌单」用）：trackIds 一次传多个 id（接口本来就收数组，
// addToPlaylist 只传一个是因为它服务「单曲加入」）。逐条吞掉 502（重复）：多选里常有几首
// 目标歌单已经有了，整批按失败处理会让用户以为一首都没进去。
// 返回 {ok, added, dup, code, needLogin, denied, message}；ok = 至少有一首真正加进去（或全部本就重复）。
// 401/301 这类整体性失败直接返回，不再逐首重试。
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

// 逐首加（批量接口回 502 时的兜底）：返回口径同 addToPlaylistMany
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

// 从歌单批量移除曲目（weapi）——「歌单管理 → 多选删除」用。POST /api/playlist/manipulate/tracks {op:'del', pid, trackIds:'[id,…]'}
// PC 端实测：
//   → {code:200, count}           一次可传多个 id；回包不带 trackIds（与 add 不同）
//   → {code:200, count 不变}      曲目本就不在歌单里（幂等，不算错）
//   → {code:401} 订阅（别人的）歌单 / {code:301} 未登录
// 「我喜欢」也是同一张歌单：对它 op:'del' 就是取消喜欢（like/check 前后验证过），
// 所以 liked 分支不用另走 /api/song/like 逐首取消。imme:'true' 实测不加也生效，这里与 add 保持一致写上。
// 返回 {ok, code, count, needLogin, denied, message}；异常 → {ok:false, code:0}
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

// 收藏 / 取消收藏（订阅）别人的歌单；on=true 收藏、false 取消。成功后作废歌单缓存（收藏状态/歌单列表都变了）。
// PC 端实测：POST /api/playlist/subscribe {id} / /api/playlist/unsubscribe {id} 都回 {code:200}。
// ⚠ subscribe 的 t 参数实测无效：t:0 也当「订阅」；t:-1 / t:"false" → {code:501}。
//   所以「取消收藏」必须走 unsubscribe 这条独立路径，别指望一个接口加 t 参数搞定。
// ⚠ 订阅自己的歌单 → {code:401, '歌单创建者已设置隐私'}（客户端只对别人的歌单给这个按钮）。
export async function setSubscribed(playlistId, on) {
  const path = on ? '/api/playlist/subscribe' : '/api/playlist/unsubscribe'
  const r = await callWrite(path, { id: playlistId }, on ? 'pl-sub' : 'pl-unsub')
  if (r.ok) invalidateUserPlaylists()
  return r
}

// 重命名歌单：POST /api/playlist/update/name {id, name} → {code:200}（PC 端实测）。
// ⚠ 老的「整包更新」playlist/update（带 name/desc/tags）实测 404 接口未找到，别走那条。
export async function renamePlaylist(playlistId, name) {
  const r = await callWrite('/api/playlist/update/name', { id: playlistId, name: name }, 'pl-rename')
  if (r.ok) invalidateUserPlaylists()
  return r
}

// 新建歌单。POST /api/playlist/create {name} → {code:200, id, playlist:{id,name,trackCount:0,…}}（PC 端实测）
//   - 新歌单 id 从顶层 `id` 取（playlist.id 同值，两者都给，写 j.id || pl.id 就稳）
//   - 回包的 playlist.creator 是 null，别指望从它拿创建者
//   - 建完立刻就能在 /api/user/playlist 里查到，也能立刻 manipulate/tracks 加歌
//     （这是「添加到歌单」里「新建并加入」能一步完成的前提）
//   失败口径：{code:400,'标题字数异常，请修改'} 空名/纯空格/超长；
//            {code:405,'操作过于频繁，请稍后再试'} 连续新建会被限频（间隔 15s 才不限）；{code:301} 未登录
// 成功后作废歌单缓存；返回 {ok, id, name, code, needLogin, message}
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

// 歌单名的长度校验/截断 —— 服务端按显示宽度卡 40（CJK 记 2、ASCII 记 1），不是按字符数也不是按字节数。
// PC 端实测：20 汉字(40) ✅ / 21 汉字(42) ❌ / 40 ASCII(40) ✅ / 41 ASCII(41) ❌ /
//            18 汉字+4 字母(40) ✅ / 19 汉字+3 字母(41) ❌
// 超过 → {code:400,'标题字数异常，请修改'}，客户端先截到合法宽度再发，别让用户白点一次。
// 返回 {name, cut}（cut=true 表示被截过）。
const PLAYLIST_NAME_WIDTH = 40

export function fitPlaylistName(s) {
  const str = String(s || '')
  let w = 0
  let end = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    const step = c > 0x2e80 ? 2 : 1 
    if (w + step > PLAYLIST_NAME_WIDTH) break
    w += step
    end = i + 1
  }
  return { name: str.slice(0, end), cut: end < str.length }
}

// 删除歌单：POST /api/playlist/remove {ids: '[id]'} → {code:200}（歌单随即从 /api/user/playlist 消失，PC 端实测）。
// ⚠ 直觉上的 playlist/delete 实测是 400 请求参数错误，正确路径是 playlist/remove。
export async function deletePlaylist(playlistId) {
  const r = await callWrite(
    '/api/playlist/remove',
    { ids: JSON.stringify([playlistId]) },
    'pl-del-playlist'
  )
  if (r.ok) invalidateUserPlaylists()
  return r
}

// 三个写接口共用的调用/解析壳（返回形状对齐 addToPlaylist / removeFromPlaylist）：{ok, code, needLogin, message}；
// 网络异常也包成 {ok:false, code:0}
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
