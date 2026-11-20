/**
 * 游标加载引擎（列表页「加载更多」三路形态 + 全量装配的收口）。
 *
 * loadMore 的分派顺序（list.vue 等列表页共用）：
 *   1. 渲染分片还有余量（shown < 全量视图长度）→ 纯本地展开，不发请求；
 *   2. 全量已在内存（allLoaded）→ 无事可做；
 *   3. kind 有自己的 loadMore handler → 交给 listkinds 取数（offset / trackIds 两路）。
 *
 * ensureAllSongs / loadAllSongs 是「全量装配」：本地排序与整单全选要求完整列表在
 * 页面状态里；「播放全部」/「点行起播」只把全量交给播放器、不写页面状态（loadAllSongs）。
 *
 * 并发与生命周期守卫在这里统一做：
 *   - loadingMore / _loadingFull 双闸（全量加载与追页不能并发写 songs/shown）；
 *   - loadToken 对不上 = 期间切了列表，回调丢弃；
 *   - _dead = 页面已销毁，一律停。
 */
import { KINDS, PAGE, appendUnique } from './listkinds.js'
import { fetchArtistSongs } from '../ncm/api.js'
import { fetchTracksMore } from '../ncm/playlist.js'
import { markUnliked } from '../ncm/like.js'
import { remove as histRemove } from './history.js'

/** 名称比较：优先 localeCompare（快速 JS 引擎里退化为码位序，中文不是拼音序，够用），异常时退回手写比较 */
function cmpName(a, b) {
  const x = String(a || '')
  const y = String(b || '')
  try {
    return x.localeCompare(y)
  } catch (e) {
    return x < y ? -1 : x > y ? 1 : 0
  }
}

/**
 * 本地排序（artistsongs 是服务端排序、原样透出）。
 * '默认'（key=''）与其它键一样带方向：降序 = 接口/收藏原顺序，升序 = 整段反转。
 */
export function sorted(vm, arr) {
  const k = vm.sortKey
  if (vm.kind === 'artistsongs') return arr
  if (!k) return vm.sortAsc ? arr.slice().reverse() : arr
  const out = arr.slice()
  const dir = vm.sortAsc ? 1 : -1
  out.sort(function (a, b) {
    if (k === 'name') return dir * cmpName(a.name, b.name)
    if (k === 'artist') return dir * cmpName(a.artist, b.artist)
    if (k === 'at') return dir * ((a.at || 0) - (b.at || 0))
    return 0
  })
  return out
}

/**
 * 取回整份列表的**全量曲目**（默认序）并返回，**不写页面状态** ——
 * 「播放全部」/「点行起播」只把它交给播放器，页面仍只渲染前 shown 行（坑 5：一次渲染 ≤50 行）。
 * 需要把全量装进页面（本地排序 / 整单全选）走 ensureAllSongs(vm)。
 */
export async function loadAllSongs(vm, token) {
  const want = token != null ? token : vm._loadToken
  if (vm.allLoaded) return vm.songs.slice()
  if (vm.kind === 'history') return vm.fullSongs.slice() // 本地全量，无需请求
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
  // 不复用已加载的 songs 续拉：歌单里的下架歌曲会让「songs 是 trackIds 前缀」错位，
  // 从 0 重拉保证队列顺序与 trackIds 一致、且不重不漏（再用 appendUnique 兜一次重复）。
  const ids = vm.trackIds
  vm.showToast('正在载入全部曲目...', 60000)
  let out = []
  let off = 0
  while (off < ids.length) {
    const batch = ids.slice(off, off + 300)
    off += batch.length
    const more = await fetchTracksMore(batch)
    if (vm._dead || want !== vm._loadToken) return out
    out = appendUnique(out, vm.attachTimes(more || []))
    vm.showToast('载入中 ' + out.length + '/' + ids.length + ' 首', 60000)
  }
  return out
}

/**
 * 确保**全量在页面状态里**（本地排序、整单全选的前置条件）。
 * 只把 songs 换成全量、**不改 shown**：渲染量不变，不会突然铺出几百行；
 * 之后 viewAll 的排序作用在完整列表上，loadMore 只是把 shown 往前推。
 */
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
    vm.log('list', '全量就绪 ' + vm.songs.length + ' 首（kind=' + vm.kind + '）')
    return true
  } catch (e) {
    if (!vm._dead) vm.showToast('载入全部曲目失败：' + ((e && e.message) || e))
    vm.log('list', '载入全部失败 ' + ((e && e.message) || e))
    return false
  } finally {
    vm._loadingFull = false
  }
}

/**
 * list.vue 的 loadMore 主体。返回 true 表示有推进（供 infinite mixin 判断）。
 *
 * @param {*} vm 页面实例（须有 kind/shown/viewAll/allLoaded/loadingMore/_loadToken/_dead）
 */
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
  if (!def || !def.loadMore) return false // 搜索/历史/推荐不翻页
  const loadToken = vm._loadToken
  vm.loadingMore = true
  try {
    await def.loadMore(vm)
    return true
  } catch (e) {
    if (vm.showToast) vm.showToast('加载更多失败：' + ((e && e.message) || e))
    if (vm.log) vm.log('list', '加载更多失败 ' + ((e && e.message) || e))
    return false
  } finally {
    vm.loadingMore = false
  }
}

/**
 * 删歌成功后的本地收敛（liked/playlist）。
 * songs / trackIds / cursor **必须一起收敛**：游标记的是「已消费的 trackIds 前缀」，
 * 删掉前缀里的歌后要同步回退，否则下一次 loadMore 会从偏大的下标开始（漏歌）。
 * 整体替换（filter 出新数组）而不是就地 splice：player.playList 拿过 this.songs 的引用当队列，
 * 就地删除会让正在播放的队列索引漂移。
 */
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
    for (let k in drop) delete vm.addTimes[k] // addTimes 只供排序查表，不参与渲染
  }
  if (vm.kind === 'liked') markUnliked(ids) // 播放页的心形读的是 like 缓存
  vm.sub = vm.trackIds.length + ' 首'
  vm.hint = vm.hasMore ? '本页已清空，点下方「加载更多」继续' : '歌单已空'
  vm.showToast((vm.kind === 'liked' ? '已取消喜欢 ' : '已从歌单移除 ') + removed + ' 首')
  vm.log('list', '移除 ' + removed + ' 首（选 ' + ids.length + '）pid=' + vm.pid + '，剩 ' + vm.trackIds.length)
  vm.exitMulti()
}

/**
 * 播放历史的「删除选中」本地收敛：history.remove 后把三份数据按同一批 id 过滤 ——
 * songs 恒为 fullSongs/trackIds 前缀的不变量必须保持（否则 loadMore 的下标错位、
 * 会把删掉的条目又 concat 回来）。
 */
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
  vm.trackIds = keepIds(vm.trackIds) // trackIds 是**裸 id 数组**（不是对象），单独过滤
  vm.songs = keepSongs(vm.songs)
  // 历史是本地全量：游标跟着新总数走，渲染量不因删除而变多
  vm.cursor = vm.trackIds.length
  vm.allLoaded = true
  if (vm.shown > vm.songs.length) vm.shown = vm.songs.length
  vm.sub = vm.fullSongs.length + ' 首'
  vm.hint = '还没有播放记录'
  vm.showToast('已从播放历史移除 ' + n + ' 首')
  vm.log('list', '历史移除 ' + n + ' 首（剩 ' + vm.fullSongs.length + '）')
  vm.exitMulti()
}
