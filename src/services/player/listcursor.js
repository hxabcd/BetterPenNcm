

import { KINDS, PAGE, appendUnique } from './listkinds.js'
import { fetchArtistSongs } from '../ncm/api.js'
import { fetchTracksMore, TRACKS_CHUNK } from '../ncm/playlist.js'
import { ARTIST_QUEUE_MAX, PLAYLIST_QUEUE_HEAD, playlistQueue } from './playqueue.js'
import { markUnliked } from '../ncm/like.js'
import { log } from '../../core/infra/log.js'
import { cmpText } from '../../core/infra/format.js'
import { remove as histRemove } from './history.js'

// 'artistsongs' 是服务端排序、原样透出；'默认'（key=''）也带方向：降序 = 接口/收藏原顺序，升序 = 整段反转
export function sorted(vm, arr) {
  const k = vm.sortKey
  if (vm.kind === 'artistsongs') return arr
  if (!k) return vm.sortAsc ? arr.slice().reverse() : arr
  const out = arr.slice()
  const dir = vm.sortAsc ? 1 : -1
  out.sort(function (a, b) {
    if (k === 'name') return dir * cmpText(a.name, b.name)
    if (k === 'artist') return dir * cmpText(a.artist, b.artist)
    if (k === 'at') return dir * ((a.at || 0) - (b.at || 0))
    return 0
  })
  return out
}

// 取回整份列表的全量曲目（默认序）并返回，**不写页面状态**（要写状态走 ensureAllSongs）；
// 起播只需要首段，别为此调它
export async function loadAllSongs(vm, token) {
  const want = token != null ? token : vm._loadToken
  if (vm.allLoaded) return vm.songs.slice()
  // 历史是本地全量，无需请求
  if (vm.kind === 'history') return vm.fullSongs.slice() 
  if (vm.kind === 'artistsongs') {

    // 服务端分页：从 0 按 PAGE 拉到底（off = 已消费的 offset，与 loadMore 同一约定）
    vm.showToast('正在载入全部曲目...', 60000)
    let out = []
    let off = 0
    let guard = 0
    while (off < vm.total && guard++ < 500) {
      const r = await fetchArtistSongs(vm.artistId, vm.order, off, PAGE)
      if (vm._dead || want !== vm._loadToken) return out
      const got = r.songs || []
      if (!got.length) break
      out = appendUnique(out, got)
      off += got.length
      vm.showToast('载入中 ' + out.length + '/' + vm.total + ' 首', 60000)
    }
    return out
  }

  // liked / playlist：按 trackIds 从 0 整批重拉（fetchTracksMore 内部 300/批）。
  // 不复用已加载的 songs 续拉：歌单里的下架歌曲会让「songs 是 trackIds 前缀」错位；
  // 从 0 重拉保证顺序与 trackIds 一致、不重不漏（appendUnique 再兜一次重复）

  const ids = vm.trackIds
  vm.showToast('正在载入全部曲目...', 60000)
  let out = []
  let off = 0
  while (off < ids.length) {
    const batch = ids.slice(off, off + TRACKS_CHUNK)
    off += batch.length
    const more = await fetchTracksMore(batch)
    if (vm._dead || want !== vm._loadToken) return out
    out = appendUnique(out, vm.attachTimes(more || []))
    vm.showToast('载入中 ' + out.length + '/' + ids.length + ' 首', 60000)
  }
  return out
}

// 确保**全量在页面状态里**（本地排序、整单全选的前置条件）。只换 songs、**不改 shown**：
// 渲染量不变，不会突然铺出几百行；之后 loadMore 只是把 shown 往前推
export async function ensureAllSongs(vm) {
  if (vm.allLoaded) return true
  if (vm._loadingFull) return false
  const loadToken = vm._loadToken
  vm._loadingFull = true
  try {
    const all = await loadAllSongs(vm, loadToken)

    // 载入期间切了列表（openList/pickCat 改了 token）→ 这份全量不属于当前列表，丢弃
    if (vm._dead || loadToken !== vm._loadToken) return false
    vm.songs = vm.dedupe(vm.attachTimes(all || []))
    vm.cursor = vm.idsTotal
    vm.allLoaded = true
    vm.noMore = false
    if (vm.shown > vm.songs.length) vm.shown = vm.songs.length
    if (!vm.shown) vm.shown = Math.min(PAGE, vm.songs.length)
    log('list', '全量就绪 ' + vm.songs.length + ' 首（kind=' + vm.kind + '）')
    return true
  } catch (e) {
    if (!vm._dead) vm.showToast('载入全部曲目失败：' + ((e && e.message) || e))
    log('list', '载入全部失败 ' + ((e && e.message) || e))
    return false
  } finally {
    vm._loadingFull = false
  }
}

// list.vue 等列表页共用的 loadMore 主体：本地分片展开 → 全量已在内存 → 交给 kind 自带的 handler。
// 返回 true 表示有推进（供 infinite mixin 判断）
export async function loadMore(vm) {
  if (vm.loadingMore || vm._loadingFull || !vm.hasMore) return false

  // ① 已取回的还有没渲染的：纯本地展开（历史 / 全量排序后的分片），不发请求
  //    步长用页面给的 autoBatch（= ui/paging.js 的 AUTO_BATCH；UI 常量不进 services）
  const batch = vm.autoBatch || 20
  if (vm.shown < vm.viewAll.length) {
    vm.shown = Math.min(vm.shown + batch, vm.viewAll.length)
    return true
  }

  // ② 全量已在内存：没有更多
  if (vm.allLoaded) return false
  const def = KINDS[vm.kind]
  // 搜索/历史/推荐这类端点不翻页：KINDS 里没有 loadMore handler
  if (!def || !def.loadMore) return false 
  const loadToken = vm._loadToken
  vm.loadingMore = true
  try {
    await def.loadMore(vm)
    return true
  } catch (e) {
    if (vm.showToast) vm.showToast('加载更多失败：' + ((e && e.message) || e))
    log('list', '加载更多失败 ' + ((e && e.message) || e))
    return false
  } finally {
    vm.loadingMore = false
  }
}

// 歌手曲目队列：最多 ARTIST_QUEUE_MAX 首。点中第 100 首以后的行时从**那一首**起取，
// 不为「听第 150 首」把前 149 首也拉回来（歌手动辄 500+ 首）
async function artistQueue(vm, i) {
  const total = Number(vm.total) || vm.songs.length
  const from = i < ARTIST_QUEUE_MAX ? 0 : i
  const want = Math.max(0, Math.min(ARTIST_QUEUE_MAX, total - from))
  let songs = want ? vm.songs.slice(from, from + want) : []

  
  // 已加载的前缀不够（首屏只有 50 行）就按同一 offset/order 往后补；
  // 服务端单页可能给不满 want，所以是循环而不是一次请求
  let off = from + songs.length
  let guard = 0
  while (songs.length < want && off < from + want && guard++ < 4) {
    const r = await fetchArtistSongs(vm.artistId, vm.order, off, want - songs.length)
    const got = r.songs || []
    if (!got.length) break
    const before = songs.length
    songs = appendUnique(songs, got)
    off += got.length
    if (songs.length === before) break 
  }
  return { songs: songs.slice(0, want), at: Math.max(0, i - from), fill: null }
}

// liked/playlist 未全量时的队列：首段 PLAYLIST_QUEUE_HEAD 首立即起播，其余由 fill 后台补。
// pickId = 点中的那首：落在首段里就定位到它；落在更后面就从它那首起取首段，免得为点第 400 首把前 399 首先拉下来
async function playlistHeadQueue(vm, pickId) {
  const ids = vm.trackIds || []
  const attach = function (list) {
    return vm.attachTimes(list)
  }
  let base = 0
  if (pickId != null) {
    const k = ids.indexOf(pickId)
    if (k >= PLAYLIST_QUEUE_HEAD) base = k
  }
  const q = await playlistQueue(ids.slice(base), PLAYLIST_QUEUE_HEAD, attach)
  let at = 0
  if (pickId != null) {
    at = -1
    for (let j = 0; j < q.songs.length; j++) {
      if (q.songs[j].id === pickId) {
        at = j
        break
      }
    }
    if (at < 0) {

      // 首段里没有它（下架曲目取不回对象）：本地已渲染的这份有就放队首起播，别让「点了行没反应」
      for (let j = 0; j < vm.songs.length; j++) {
        if (vm.songs[j] && vm.songs[j].id === pickId) {
          q.songs = [vm.songs[j]].concat(q.songs)
          at = 0
          break
        }
      }
    }
  }
  return { songs: q.songs, at: at < 0 ? 0 : at, fill: q.fill }
}

// 「播放全部」的队列：{ songs, at, fill }。liked/playlist 只取前 PLAYLIST_QUEUE_HEAD 首，
// fill 要在 playList 之后调用（不 await）
export async function queuePlayAll(vm) {
  if (vm.allLoaded) return { songs: vm.viewAll, at: 0, fill: null }
  if (vm.kind === 'artistsongs') return artistQueue(vm, 0)
  if (vm.kind === 'liked' || vm.kind === 'playlist') return playlistHeadQueue(vm, null)
  const all = await loadAllSongs(vm)
  return { songs: sorted(vm, all), at: 0, fill: null }
}

// 「点行起播」的队列，口径与 queuePlayAll 相同（下标 i 是当前视图里的行号）
export async function queueFromRow(vm, i) {
  if (vm.allLoaded) return { songs: vm.viewAll, at: i, fill: null }
  if (vm.kind === 'artistsongs') return artistQueue(vm, i)
  if (vm.kind === 'liked' || vm.kind === 'playlist') {
    const song = vm.viewSongs[i] || {}
    return playlistHeadQueue(vm, song.id)
  }

  const all = await loadAllSongs(vm)
  const list = sorted(vm, all)
  const song = vm.viewSongs[i] || {}
  let at = 0
  for (let j = 0; j < list.length; j++) {
    if (list[j].id === song.id) {
      at = j
      break
    }
  }
  return { songs: list, at: at, fill: null }
}

// 删歌成功后的本地收敛（liked/playlist）。songs / trackIds / cursor **必须一起收敛**：
// 游标记的是「已消费的 trackIds 前缀」，删掉前缀里的歌后要同步回退，否则下一次 loadMore 会从偏大的下标开始（漏歌）。
// 整体替换（filter 出新数组）而不是就地 splice：player.playList 拿过 this.songs 的引用当队列，
// 就地删除会让正在播放的队列索引漂移
export function applyRemoved(vm, ids) {
  const drop = {}
  for (let i = 0; i < ids.length; i++) drop[ids[i]] = 1

  // 选中项里有多少落在已消费前缀内 → 游标要回退多少
  let consumed = 0
  const upto = Math.min(vm.cursor, vm.trackIds.length)
  for (let i = 0; i < upto; i++) {
    if (drop[vm.trackIds[i]]) consumed++
  }
  const ids2 = []
  for (let i = 0; i < vm.trackIds.length; i++) {
    if (!drop[vm.trackIds[i]]) ids2.push(vm.trackIds[i])
  }
  const songs2 = []
  for (let i = 0; i < vm.songs.length; i++) {
    const s = vm.songs[i]
    if (s && !drop[s.id]) songs2.push(s)
  }
  const removed = vm.trackIds.length - ids2.length
  vm.trackIds = ids2
  vm.songs = songs2
  vm.cursor = Math.max(0, vm.cursor - consumed)
  if (vm.shown > vm.songs.length) vm.shown = vm.songs.length
  if (vm.cursor >= vm.trackIds.length) vm.allLoaded = true
  if (vm.addTimes) {
    // addTimes 只供排序查表，不参与渲染
    for (let k in drop) delete vm.addTimes[k] 
  }
  // 播放页的心形读的是 like 缓存
  if (vm.kind === 'liked') markUnliked(ids) 
  vm.sub = vm.trackIds.length + ' 首'
  vm.hint = vm.hasMore ? '本页已清空，点下方「加载更多」继续' : '歌单已空'
  vm.showToast((vm.kind === 'liked' ? '已取消喜欢 ' : '已从歌单移除 ') + removed + ' 首')
  log('list', '移除 ' + removed + ' 首（选 ' + ids.length + '）pid=' + vm.pid + '，剩 ' + vm.trackIds.length)
  vm.exitMulti()
}

// 播放历史的「删除选中」本地收敛：history.remove 后按同一批 id 过滤三份数据 ——
// songs 恒为 fullSongs/trackIds 前缀这条不变量必须保持（否则 loadMore 下标错位、会把删掉的条目又 concat 回来）
export function applyHistoryRemoved(vm, ids) {
  const drop = {}
  for (let i = 0; i < ids.length; i++) drop[String(ids[i])] = 1
  const n = histRemove(ids)
  const keepSongs = function (arr) {
    const out = []
    for (let i = 0; i < arr.length; i++) {
      if (!drop[String(arr[i].id)]) out.push(arr[i])
    }
    return out
  }
  const keepIds = function (arr) {
    const out = []
    for (let i = 0; i < arr.length; i++) {
      if (!drop[String(arr[i])]) out.push(arr[i])
    }
    return out
  }
  vm.fullSongs = keepSongs(vm.fullSongs)
  // trackIds 是**裸 id 数组**（不是对象），单独过滤
  vm.trackIds = keepIds(vm.trackIds) 
  vm.songs = keepSongs(vm.songs)
  // 历史是本地全量：游标跟着新总数走，渲染量不因删除而变多
  vm.cursor = vm.trackIds.length
  vm.allLoaded = true
  if (vm.shown > vm.songs.length) vm.shown = vm.songs.length
  vm.sub = vm.fullSongs.length + ' 首'
  vm.hint = '还没有播放记录'
  vm.showToast('已从播放历史移除 ' + n + ' 首')
  log('list', '历史移除 ' + n + ' 首（剩 ' + vm.fullSongs.length + '）')
  vm.exitMulti()
}
