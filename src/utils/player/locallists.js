/**
 * 本地歌单索引 —— 把「已添加到本地索引」的歌单及其远端/本地快照落盘。
 *
 * 数据模型（文件 `$dataDir/store/local_playlists.json`，整表 63KB；storage 是单文件 KV、
 * 写一次重写整库，所以大表落文件 —— 见 utils/filestore.js）：
 *   {
 *     "<playlistId>": {
 *       id, name, cover, creator, trackCount, updateTime,
 *       baseIds:   [曲目 id],   // 曾见过的远端曲目集合（含旧快照；D 判定用）
 *       remoteIds: [曲目 id],   // 最近一次拉取的远端快照
 *       lastPullAt, addedAt, lastSyncAt,
 *       meta: { "<id>": {n,a,al,c,d} }  // 仅给「远端有、本地还没下」的 A 条目做显示/下载用
 *     }
 *   }
 *
 * 拉取 / 同步（对齐 git fetch / pull）：
 *   - **A / D 一律相对本地文件计算，不相对 baseIds**：
 *       A（新增）= remoteIds − 本地已下载；D（移除）= baseIds − remoteIds，且本地有文件。
 *     所以「加入索引前歌单里就已有、但一直没下载」的曲目，打开本地歌单列表立刻就是 A，
 *     不需要等远端再次变动。
 *   - 拉取（pullList）：只更新 remoteIds + 歌单元信息 + lastPullAt，并为 A 补元数据；
 *       不下载、不删文件。旧的 remoteIds 并入 baseIds，保证「曾进过歌单、本地有文件」的曲目
 *       在远端移除后还能判成 D。
 *   - 同步（syncList）：先拉取，再下载**所有 A**（远端有、本地没有），把 D 从 baseIds 移除
 *       （**不删文件**，策略 A）。成功后 baseIds = 当前远端快照；失败的 A 保持 A，下次重试。
 *   - 「下载全部」（downloadAll）：拉取后把整张远端曲目下载下来；已索引时 baseIds = 当前远端快照；
 *       **未索引**时按用户单曲下载（origin=manual），不会制造「没有索引却有遗留」。
 *
 * 分类不在这里维护孤儿表：由 dlorigin.js 的归属标记 + 本模块的「是否被任一索引歌单引用」
 * 动态派生（见 classify / splitDownloads）：
 *   - referenced → 歌单内
 *   - !referenced && playlistOwned → 遗留歌曲
 *   - !referenced && (userOwned/无标记) → 单曲下载
 * 因此移出索引只删记录，不碰文件；重新加回索引/被其它歌单引用时自动回到歌单视图。
 *
 * 接口边界：
 *   - A/D 需要「本地已下载」这份事实。页面已经把 `listSongs()` 结果传进来时直接复用
 *     （playlistView / listSummary / syncList 的 localIds 参数）；没传时本模块才自己扫一次。
 *     `pullAll` 会把本地集合扫一次后复用给所有歌单，避免 N 次 exec。这是刻意例外：
 *     否则「从未下载过的远端曲目」永远无法成为 A。
 *   - 下载动作统一走 download.js 的 downloadSongs，归属标记由它写 dlorigin。
 */
import { loadTable, saveTable } from '../filestore.js'
import { fetchPlaylistInfo, fetchPlaylistAllSongs, fetchTracksMore } from '../ncm/playlist.js'
import { downloadSongs, deleteCached } from './download.js'
import { listSongs } from './cache.js'
import { isOffline } from '../net/status.js'
import { log } from '../log.js'
import { isPlaylistOwned, isUser, loadOrigin } from './dlorigin.js'

const FILE = 'local_playlists' // $dataDir/store/local_playlists.json

let mem = null
let loading = null

function normalizeRecord(rec) {
  const r = rec || {}
  const base = Array.isArray(r.baseIds) ? r.baseIds : []
  const remote = Array.isArray(r.remoteIds) ? r.remoteIds : []
  return {
    id: Number(r.id) || 0,
    name: r.name || '',
    cover: r.cover || '',
    creator: r.creator || '',
    trackCount: Number(r.trackCount) || remote.length || base.length,
    updateTime: Number(r.updateTime) || 0,
    baseIds: base,
    remoteIds: remote,
    lastPullAt: Number(r.lastPullAt) || 0,
    addedAt: Number(r.addedAt) || 0,
    lastSyncAt: Number(r.lastSyncAt) || 0,
    meta: r.meta && typeof r.meta === 'object' ? r.meta : {}
  }
}

async function load() {
  if (mem) return mem
  if (loading) return loading
  loading = (async function () {
    let obj = {}
    try {
      obj = (await loadTable(FILE)) || {}
    } catch (e) {
      obj = {}
    }
    const out = {}
    const keys = Object.keys(obj || {})
    for (let i = 0; i < keys.length; i++) {
      const rec = normalizeRecord(obj[keys[i]])
      if (rec.id) out[String(rec.id)] = rec
    }
    mem = out
    loading = null
    return out
  })()
  return loading
}

async function save() {
  if (!mem) return
  try {
    await saveTable(FILE, mem)
  } catch (e) {}
}

/** 确保载入（导出函数内部会等它；页面要同步读缓存时可先 await loadLists()） */
export async function loadLists() {
  await load()
  return mem
}

/** 已索引歌单数组（按加入时间新→旧；页面可再排序） */
export async function allLists() {
  await load()
  const out = []
  const keys = Object.keys(mem || {})
  for (let i = 0; i < keys.length; i++) out.push(mem[keys[i]])
  out.sort(function (a, b) {
    return (b.addedAt || 0) - (a.addedAt || 0)
  })
  return out
}

/** 同步取一条（须先 await loadLists()） */
export function listOf(pid) {
  return (mem && mem[String(pid)]) || null
}

export async function isIndexed(pid) {
  await load()
  return !!(mem && mem[String(pid)])
}

/** 索引歌单数量（本地下载总览卡） */
export async function indexedCount() {
  await load()
  return Object.keys(mem || {}).length
}

/* ---------------- 添加 / 移除 ---------------- */

/**
 * 添加到本地索引：抓歌单元信息 + 全量 trackIds（n:0，trackIds 仍全量），
 * baseIds = remoteIds = 当前远端快照。只落索引，不下载文件。
 * 注意：A/D 是相对本地文件实时算的，所以「歌单里本来就有、但没下载」的曲目
 * 在第一次打开本地歌单列表时就会显示为 A，不需要等远端再变。
 * 返回 {ok, list, offline?, error?}
 */
export async function addList(pid) {
  const id = Number(pid) || 0
  if (!id) return { ok: false, error: '缺少歌单 id' }
  await load()
  if (await isOffline()) return { ok: false, offline: true, error: '离线' }
  try {
    const info = await fetchPlaylistInfo(id)
    const ids = info.trackIds || []
    const rec = normalizeRecord({
      id: id,
      name: info.name,
      cover: info.cover,
      creator: info.creator,
      trackCount: info.trackCount || ids.length,
      updateTime: info.updateTime || 0,
      baseIds: ids,
      remoteIds: ids,
      lastPullAt: Date.now(),
      addedAt: Date.now(),
      lastSyncAt: Date.now(),
      meta: {}
    })
    mem[String(id)] = rec
    await save()
    log('locallists', '添加本地索引 ' + id + ' ' + info.name + ' 曲目=' + ids.length)
    return { ok: true, list: rec, count: ids.length }
  } catch (e) {
    log('locallists', '添加本地索引失败 ' + id + '：' + ((e && e.message) || e))
    return { ok: false, error: (e && e.message) || '添加失败' }
  }
}

/**
 * 移出本地索引：只删记录，**不碰文件**（策略 A）。
 * 失去最后一个引用的歌单批量下载文件会由分类自动落到「遗留歌曲」；
 * 用户单曲/遗留文件不受影响。
 */
export async function removeList(pid) {
  const id = Number(pid) || 0
  await load()
  if (!id || !mem[String(id)]) return { ok: false }
  const rec = mem[String(id)]
  delete mem[String(id)]
  await save()
  log('locallists', '移出本地索引 ' + id + ' ' + rec.name + '（文件保留）')
  return { ok: true, list: rec }
}

/**
 * 本地删除：移除索引，并把「移出后会变成遗留歌曲」的文件直接删掉（不留孤儿）。
 *
 * 与 removeList 的区别：
 *   - removeList 保留全部文件，失去引用的歌单归属文件落到「遗留歌曲」；
 *   - 本函数在移除索引的同时删掉这批文件，让它们不进入遗留分类。
 *
 * 删除范围 = 本歌单引用（baseIds ∪ remoteIds）∩ 本地已下载 ∩
 * 移出后不被其它已索引歌单引用 ∩ 归属为 playlist（dlorigin）。
 * 另外两类**不动**：
 *   - 仍被其它索引歌单引用的文件（不是孤儿，留着还能播）；
 *   - 用户单曲 / 无标记文件（它们本来就不会进遗留，而是归「单曲下载」）。
 *
 * 须在索引记录还在时调用（内部先算引用再移除）。返回 {ok, list, deleted:[id], files, bytes}
 */
export async function removeListLocal(pid) {
  const id = Number(pid) || 0
  await load()
  const rec = mem[String(id)]
  if (!id || !rec) return { ok: false, error: '未添加到本地索引' }
  await loadOrigin()
  const songs = await listSongs()
  // 其它索引歌单的引用集合：这些文件不算孤儿，保留
  const others = {}
  const keys = Object.keys(mem || {})
  for (let i = 0; i < keys.length; i++) {
    if (Number(keys[i]) === id) continue
    const o = mem[keys[i]]
    const base = o.baseIds || []
    const remote = o.remoteIds || []
    for (let k = 0; k < base.length; k++) others[String(base[k])] = 1
    for (let k = 0; k < remote.length; k++) others[String(remote[k])] = 1
  }
  const doomed = []
  for (let i = 0; i < songs.length; i++) {
    const s = songs[i]
    const k = String(s.id)
    if (others[k]) continue // 仍被别的索引歌单引用
    if (!listHasSong(rec, s.id)) continue // 不在这张歌单里
    if (!isPlaylistOwned(s.id)) continue // 用户单曲/无标记：会进「单曲下载」，不是孤儿
    doomed.push(s)
  }
  // 先移除索引：之后即使删除文件失败，这些歌也已经是「无引用」状态，不会指回已移出的歌单
  delete mem[String(id)]
  await save()
  let files = 0
  let bytes = 0
  const deleted = []
  for (let i = 0; i < doomed.length; i++) {
    const r = await deleteCached(doomed[i].id)
    if (r) {
      files += r.files || 0
      bytes += r.bytes || 0
    }
    deleted.push(doomed[i].id)
  }
  log('locallists', '本地删除 ' + id + ' ' + rec.name + '：移出索引，删除孤儿文件 ' +
    deleted.length + ' 首 / ' + files + ' 个文件（' + Math.round(bytes / 1024) + 'KB）')
  return { ok: true, list: rec, deleted: deleted, files: files, bytes: bytes }
}

/* ---------------- 拉取 ---------------- */

function toSet(arr) {
  const out = {}
  const list = arr || []
  for (let i = 0; i < list.length; i++) out[String(list[i])] = 1
  return out
}

/**
 * 本地已下载 id 集合。调用方已经扫过目录时传 localIds（数组）复用；
 * 没传才自己扫一次（单次 pull / sync 可以接受，pullAll 会先扫一次再传进来）。
 */
async function localSetOf(localIds) {
  if (Array.isArray(localIds)) return toSet(localIds)
  const songs = await listSongs()
  const ids = []
  for (let i = 0; i < songs.length; i++) ids.push(songs[i].id)
  return toSet(ids)
}

/** A = remote − local（远端有、本地没有）；顺序跟远端一致 */
function addedIdsOf(remote, localSet) {
  const out = []
  for (let i = 0; i < remote.length; i++) {
    if (!localSet[String(remote[i])]) out.push(remote[i])
  }
  return out
}

/** D = base − remote，且本地有文件（本地有、远端已移除）；顺序跟 base 一致 */
function removedIdsOf(base, remote, localSet) {
  const rset = toSet(remote)
  const out = []
  for (let i = 0; i < base.length; i++) {
    const k = String(base[i])
    if (!rset[k] && localSet[k]) out.push(base[i])
  }
  return out
}

function metaToSong(id, m) {
  const meta = m || {}
  return {
    id: Number(id) || id,
    name: meta.n || ('歌曲 ' + id),
    artist: meta.a || '',
    album: meta.al || '',
    albumId: 0,
    cover: meta.c || '',
    durationMs: meta.d || 0,
    fee: meta.fee || 0
  }
}

function songToMeta(s) {
  return {
    n: s.name || '',
    a: s.artist || '',
    al: s.album || '',
    c: s.cover || '',
    d: s.durationMs || 0,
    fee: s.fee || 0
  }
}

/**
 * 给一批 A 条目补元数据（显示/下载用），返回 {id: meta}；失败只记日志，不影响拉取。
 * 不直接改 rec：调用方拿到结果后自己合并、落盘。
 */
async function fetchMeta(ids) {
  const list = ids || []
  const out = {}
  if (!list.length) return out
  try {
    let got = 0
    for (let off = 0; off < list.length; off += 300) {
      const batch = list.slice(off, off + 300)
      const songs = await fetchTracksMore(batch)
      for (let i = 0; i < songs.length; i++) {
        const s = songs[i]
        if (s && s.id) {
          out[String(s.id)] = songToMeta(s)
          got++
        }
      }
    }
    log('locallists', '补 A 条目元数据 ' + got + '/' + list.length)
    return out
  } catch (e) {
    log('locallists', '补 A 条目元数据失败：' + ((e && e.message) || e))
    return out
  }
}

/**
 * 拉取（git fetch）：只更新远端快照/歌单信息/上次拉取时间，不下载、不移动文件。
 * A = remoteIds − 本地已下载；D = baseIds − remoteIds 且本地有文件。
 * baseIds 会吸收上一版 remoteIds：曾进过歌单、本地有文件的曲目，远端移除后仍能判成 D。
 * 返回 {ok, list, added:[id], removed:[id], offline?, error?}
 */
export async function pullList(pid, localIds) {
  const id = Number(pid) || 0
  await load()
  const rec = mem[String(id)]
  if (!id || !rec) return { ok: false, error: '未添加到本地索引' }
  if (await isOffline()) return { ok: false, offline: true, error: '离线' }
  try {
    const local = await localSetOf(localIds)
    const info = await fetchPlaylistInfo(id)
    const remote = info.trackIds || []
    const oldRemote = rec.remoteIds || []
    // baseIds = 曾见过的远端曲目并集：旧快照里新增过的曲目也并进来，
    // 这样「拉取过但没同步、随后被远端移除」的本地文件也能显示成 D。
    const base = (rec.baseIds || []).slice()
    const baseSet = toSet(base)
    for (let i = 0; i < oldRemote.length; i++) {
      const k = String(oldRemote[i])
      if (!baseSet[k]) {
        base.push(oldRemote[i])
        baseSet[k] = 1
      }
    }
    const added = addedIdsOf(remote, local)
    const removed = removedIdsOf(base, remote, local)
    // meta 只保留当前 A；缺元数据的补一次（只影响显示/下载，失败不阻断拉取）
    const oldMeta = rec.meta || {}
    const meta = {}
    const need = []
    for (let i = 0; i < added.length; i++) {
      const k = String(added[i])
      if (oldMeta[k]) meta[k] = oldMeta[k]
      else need.push(added[i])
    }
    if (need.length) {
      const got = await fetchMeta(need)
      for (let i = 0; i < need.length; i++) {
        const k = String(need[i])
        if (got[k]) meta[k] = got[k]
      }
    }
    rec.meta = meta
    rec.baseIds = base
    rec.remoteIds = remote
    rec.name = info.name || rec.name
    rec.cover = info.cover || rec.cover
    rec.creator = info.creator || rec.creator
    rec.trackCount = info.trackCount || remote.length
    rec.updateTime = info.updateTime || rec.updateTime
    rec.lastPullAt = Date.now()
    await save()
    log('locallists', '拉取 ' + id + ' ' + rec.name + ' 远端=' + remote.length +
      ' 本地=' + Object.keys(local).length + ' 新增=' + added.length + ' 移除=' + removed.length)
    return { ok: true, list: rec, added: added, removed: removed }
  } catch (e) {
    log('locallists', '拉取失败 ' + id + '：' + ((e && e.message) || e))
    return { ok: false, error: (e && e.message) || '拉取失败' }
  }
}

/**
 * 自动拉取（启动时）：逐个拉取已索引歌单，只更新远端快照，绝不下载/删文件。
 * 离线时直接返回，不做 N 次超时。
 * localIds 由调用方传入时复用；否则整轮只扫一次本地目录，避免 N 个歌单各扫一次。
 * 返回汇总。
 */
export async function pullAll(localIds) {
  const lists = await allLists()
  const out = { total: lists.length, ok: 0, failed: 0, added: 0, removed: 0 }
  if (!lists.length) return out
  if (await isOffline()) {
    out.offline = true
    log('locallists', '自动拉取跳过：离线（' + lists.length + ' 个歌单）')
    return out
  }
  let ids = localIds
  if (!Array.isArray(ids)) {
    const songs = await listSongs()
    ids = []
    for (let i = 0; i < songs.length; i++) ids.push(songs[i].id)
  }
  for (let i = 0; i < lists.length; i++) {
    const r = await pullList(lists[i].id, ids)
    if (r.ok) {
      out.ok++
      out.added += (r.added || []).length
      out.removed += (r.removed || []).length
    } else {
      out.failed++
    }
  }
  log('locallists', '自动拉取完成：' + out.ok + '/' + out.total + ' 成功，新增 ' +
    out.added + ' 移除 ' + out.removed + '（失败 ' + out.failed + '）')
  return out
}

/* ---------------- 同步 ---------------- */

/**
 * 同步（git pull）：先拉取 → 下载**所有 A**（远端有、本地没有）→ 把 D 从 baseIds 移除
 * （文件保留，策略 A）。成功后 baseIds = 当前远端快照；失败的 A 保持 A，下次重试。
 * 返回 {ok, added, downloaded, skipped, failed, removed, failedIds, offline?, error?}
 */
export async function syncList(pid, localIds) {
  const id = Number(pid) || 0
  await load()
  const rec = mem[String(id)]
  if (!id || !rec) return { ok: false, error: '未添加到本地索引' }
  const pr = await pullList(id, localIds)
  if (!pr.ok) return pr
  const remote = rec.remoteIds || []
  const aIds = pr.added || []
  const dIds = pr.removed || []
  let dl = { ok: 0, skipped: 0, failed: 0 }
  const okSet = {}
  if (aIds.length) {
    const songs = []
    for (let i = 0; i < aIds.length; i++) {
      const k = String(aIds[i])
      songs.push(rec.meta[k] ? metaToSong(aIds[i], rec.meta[k]) : metaToSong(aIds[i], null))
    }
    dl = await downloadSongs(songs, { origin: 'playlist' })
    const results = dl.results || []
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'ok' || results[i].status === 'skipped') okSet[String(results[i].id)] = 1
    }
  }
  // 同步完成即接受当前远端状态：base = remote（D 被移除，文件不删）。
  // A 不依赖 base，而是实时按本地文件算；失败/取消的 A 仍会在列表里保持 A。
  rec.baseIds = remote.slice()
  rec.lastSyncAt = Date.now()
  const failedIds = []
  const keepMeta = {}
  for (let i = 0; i < aIds.length; i++) {
    const k = String(aIds[i])
    if (okSet[k]) continue
    failedIds.push(aIds[i])
    if (rec.meta[k]) keepMeta[k] = rec.meta[k]
  }
  rec.meta = keepMeta
  await save()
  log('locallists', '同步 ' + id + ' ' + rec.name + ' 新增=' + aIds.length +
    ' 下载成功=' + dl.ok + ' 跳过=' + dl.skipped + ' 失败=' + dl.failed +
    ' 移除=' + dIds.length + '（文件保留）')
  return {
    ok: true,
    added: aIds.length,
    downloaded: dl.ok || 0,
    skipped: dl.skipped || 0,
    failed: dl.failed || 0,
    removed: dIds.length,
    failedIds: failedIds,
    list: rec
  }
}

/**
 * 「下载全部」（歌单详情 → 下载全部 或 索引歌单页的批量下载）：
 *   - 已索引：先拉取，再下载整张远端曲目（origin=playlist）。完成后 baseIds = 当前远端快照
 *     （D 被移除、文件保留），失败的 A 保留元数据。等价于「同步 + 补齐所有未下载项」。
 *   - 未索引：下载整张远端曲目（origin=manual），不创建索引、不产生遗留分类。
 * onProgress(done,total) 可选（拉取曲目对象阶段）。
 */
export async function downloadAll(pid, onProgress) {
  const id = Number(pid) || 0
  if (!id) return { ok: false, error: '缺少歌单 id' }
  await load()
  if (await isOffline()) return { ok: false, offline: true, error: '离线' }
  const rec = mem[String(id)] || null
  try {
    if (rec) {
      const pr = await pullList(id)
      if (!pr.ok) return pr
    }
    const songs = await fetchPlaylistAllSongs(id, onProgress)
    if (!songs.length) return { ok: true, total: 0, downloaded: 0, skipped: 0, failed: 0 }
    const dl = await downloadSongs(songs, { origin: rec ? 'playlist' : 'manual' })
    if (rec) {
      const remote = rec.remoteIds || []
      const results = dl.results || []
      const failedSet = {}
      for (let i = 0; i < results.length; i++) {
        const st = results[i].status
        if (st === 'failed' || st === 'cancelled') failedSet[String(results[i].id)] = 1
      }
      const meta = {}
      for (let i = 0; i < remote.length; i++) {
        const k = String(remote[i])
        if (failedSet[k] && rec.meta[k]) meta[k] = rec.meta[k]
      }
      rec.baseIds = remote.slice()
      rec.lastSyncAt = Date.now()
      rec.meta = meta
      await save()
    }
    return {
      ok: true,
      total: dl.total || songs.length,
      downloaded: dl.ok || 0,
      skipped: dl.skipped || 0,
      failed: dl.failed || 0,
      cancelled: dl.cancelled || 0,
      error: dl.error || ''
    }
  } catch (e) {
    log('locallists', '下载全部失败 ' + id + '：' + ((e && e.message) || e))
    return { ok: false, error: (e && e.message) || '下载失败' }
  }
}

/* ---------------- 分类 / 视图 ---------------- */

/** 所有已索引歌单引用的曲目 id（baseIds ∪ remoteIds） */
export async function referencedIds() {
  await load()
  const out = {}
  const keys = Object.keys(mem || {})
  for (let i = 0; i < keys.length; i++) {
    const rec = mem[keys[i]]
    const base = rec.baseIds || []
    const remote = rec.remoteIds || []
    for (let k = 0; k < base.length; k++) out[String(base[k])] = 1
    for (let k = 0; k < remote.length; k++) out[String(remote[k])] = 1
  }
  return out
}

/** 某歌单是否引用某曲目（base ∪ remote） */
export function listHasSong(rec, songId) {
  if (!rec) return false
  const k = String(songId)
  const base = rec.baseIds || []
  const remote = rec.remoteIds || []
  for (let i = 0; i < base.length; i++) if (String(base[i]) === k) return true
  for (let i = 0; i < remote.length; i++) if (String(remote[i]) === k) return true
  return false
}

/**
 * 单首分类：'playlist'（被任一索引歌单引用）| 'orphan'（歌单批量下载但已无引用）|
 * 'single'（用户单曲/遗留/无引用且非歌单归属）。
 * 须先 await loadLists() + referencedIds()；批量场景用 splitDownloads 只算一次引用表。
 */
export function classifyWithRefs(songId, refs) {
  if (refs && refs[String(songId)]) return 'playlist'
  if (isPlaylistOwned(songId) && !isUser(songId)) return 'orphan'
  return 'single'
}

/**
 * 把已下载歌曲拆成三类（本地下载页用，只扫一次引用表）：
 * 返回 {single:[song], orphan:[song], playlist:[song], refs:{id:1}}
 *   - playlist 只表示「被任一索引歌单引用」，不区分哪个歌单（歌单内视图由 playlistView 给）
 *   - 单曲 = 无引用且不是歌单批量下载；遗留 = 无引用且是歌单批量下载
 */
export async function splitDownloads(songs) {
  await loadOrigin()
  const refs = await referencedIds()
  const out = { single: [], orphan: [], playlist: [], refs: refs }
  const list = songs || []
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    const kind = classifyWithRefs(s.id, refs)
    if (kind === 'playlist') out.playlist.push(s)
    else if (kind === 'orphan') out.orphan.push(s)
    else out.single.push(s)
  }
  return out
}

/**
 * 某歌单的本地视图：A = 远端有、本地没下载；D = base 有、远端已移除、本地有文件；
 * 其余本地文件为普通行。A/D 与 baseIds 的「上次快照」无关，只取决于本地文件是否存在。
 */
export async function playlistView(pid, downloadedSongs) {
  await load()
  const rec = mem[String(pid)]
  if (!rec) return null
  const down = {}
  const list = downloadedSongs || []
  for (let i = 0; i < list.length; i++) down[String(list[i].id)] = list[i]
  const remote = rec.remoteIds || []
  const remoteSet = toSet(remote)
  const base = rec.baseIds || []
  const baseSet = toSet(base)

  // A 条目：远端有、本地没有。先把元数据补齐（离线/失败时显示占位名，下次再补）。
  const addedIds = []
  for (let i = 0; i < remote.length; i++) {
    if (!down[String(remote[i])]) addedIds.push(remote[i])
  }
  const oldMeta = rec.meta || {}
  const meta = {}
  const need = []
  for (let i = 0; i < addedIds.length; i++) {
    const k = String(addedIds[i])
    if (oldMeta[k]) meta[k] = oldMeta[k]
    else need.push(addedIds[i])
  }
  let metaFetched = false
  if (need.length && !(await isOffline())) {
    const got = await fetchMeta(need)
    metaFetched = true
    for (let i = 0; i < need.length; i++) {
      const k = String(need[i])
      if (got[k]) meta[k] = got[k]
    }
  }
  let metaChanged = false
  const oldKeys = Object.keys(oldMeta)
  if (oldKeys.length !== Object.keys(meta).length) metaChanged = true
  else {
    for (let i = 0; i < oldKeys.length; i++) {
      if (!meta[oldKeys[i]]) { metaChanged = true; break }
    }
  }
  rec.meta = meta

  // 本地有、远端也有、但 base 里没有（例如远端刚加就手动下载）：并入 base。
  // 这样之后远端把它移除时，D 仍能认出来。
  let baseChanged = false
  for (let i = 0; i < remote.length; i++) {
    const k = String(remote[i])
    if (down[k] && !baseSet[k]) {
      base.push(remote[i])
      baseSet[k] = 1
      baseChanged = true
    }
  }
  if (baseChanged) rec.baseIds = base
  if (baseChanged || metaChanged || metaFetched) await save()

  const addedRows = []
  for (let i = 0; i < addedIds.length; i++) {
    const id = addedIds[i]
    addedRows.push({ song: metaToSong(id, meta[String(id)]), flag: 'A', downloaded: false })
  }
  const normalRows = []
  for (let i = 0; i < remote.length; i++) {
    const id = remote[i]
    const s = down[String(id)]
    if (s) normalRows.push({ song: s, flag: '', downloaded: true })
  }
  const removedRows = []
  let removed = 0
  for (let i = 0; i < base.length; i++) {
    const id = base[i]
    if (remoteSet[String(id)]) continue
    const s = down[String(id)]
    if (s) {
      removed++
      removedRows.push({ song: s, flag: 'D', downloaded: true })
    }
  }
  // 变更优先：A（远端有、本地没有）→ D（本地有、远端已移除）→ 未变化的本地曲目。
  // 这样 A/D 一定在第一屏，不会因为分页（50 行/批）被埋到几百行之后。
  const rows = addedRows.concat(removedRows, normalRows)
  return {
    list: rec,
    rows: rows,
    added: addedIds.length,
    removed: removed,
    remoteCount: remote.length,
    downloadedCount: rows.length - addedIds.length,
    lastPullAt: rec.lastPullAt
  }
}

/** 歌单列表页的摘要：本地已下载数 / 远端总数 / 新增（远端−本地）/ 移除（本地−远端） */
export async function listSummary(rec, downloadedSongs) {
  const down = {}
  const list = downloadedSongs || []
  for (let i = 0; i < list.length; i++) down[String(list[i].id)] = 1
  const base = rec.baseIds || []
  const remote = rec.remoteIds || []
  const remoteSet = toSet(remote)
  let local = 0
  let added = 0
  for (let i = 0; i < remote.length; i++) {
    if (down[String(remote[i])]) local++
    else added++
  }
  let removed = 0
  for (let i = 0; i < base.length; i++) {
    const k = String(base[i])
    if (!remoteSet[k] && down[k]) removed++
  }
  return { local: local, total: remote.length, added: added, removed: removed }
}
