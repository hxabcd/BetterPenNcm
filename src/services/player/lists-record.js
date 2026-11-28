import { open as dbOpen, data as dbData, exec as dbExec, upsertSql, deleteSql, num } from '../../core/platform/db.js'
import { fetchPlaylistInfo } from '../ncm/playlist.js'
import { deleteCached } from './download.js'
import { listSongs } from './cache.js'
import { isOffline } from '../../core/infra/net/status.js'
import { log } from '../../core/infra/log.js'
import { isPlaylistOwned, loadOrigin } from './dlorigin.js'
import { runStmts, replaceRowsSql, appendTextColSql } from './meta/sqlkit.js'

const T_PL = 'playlist'
const T_PT = 'playlist_track'

// 语句分箱的体积预算：走原生 sqlite3 后已无 argv 上限（不拼 shell、不 fork），但整批语句仍是拼成一串交给
// db.exec()，所以保留分箱 —— 单批太大出错难定位，拆小也让写落在多个事务里、主线程不会长时间不返回
let mem = null
let loading = null

function parseIds(s) {
  if (!s) return []
  try {
    const a = JSON.parse(s)
    return Array.isArray(a) ? a : []
  } catch (e) {
    return []
  }
}

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

// DB 行 → 记录：没有列的字段按文档降级（addedAt 用 pulled_at 回填，meta 为空、等在线补齐）
function rowToRecord(row) {
  const pulled = Number(row.pulled_at) || 0
  return normalizeRecord({
    id: row.id,
    name: row.name,
    cover: row.cover,
    creator: row.creator,
    trackCount: row.track_cnt,
    baseIds: parseIds(row.base_ids),
    remoteIds: parseIds(row.remote_ids),
    lastPullAt: pulled,
    addedAt: pulled,
    updateTime: 0,
    lastSyncAt: 0,
    meta: {}
  })
}

async function load() {
  if (mem) return mem
  if (loading) return loading
  loading = (async function () {
    try {
      await dbOpen()
    } catch (e) {}
    const out = {}
    const d = dbData()
    const rows = (d && d.playlist) || {}
    const keys = Object.keys(rows)
    for (let i = 0; i < keys.length; i++) {
      const rec = rowToRecord(rows[keys[i]])
      if (rec.id) out[String(rec.id)] = rec
    }
    mem = out
    loading = null
    return out
  })()
  return loading
}

// 落一条歌单记录：playlist 行 + playlist_track 关系行。先改内存（读的真相）、再拼 SQL —— 与 localmeta 同一套「内存 + 写穿」模式
async function persist(rec) {
  if (!rec || !rec.id) return
  const k = String(rec.id)
  if (!mem) mem = {}
  mem[k] = rec
  const d = dbData()
  const base = rec.baseIds || []
  const remote = rec.remoteIds || []

  // 1) playlist 行：小字段一次 upsert；两个 JSON 数组列随后分片追加（可能很长）
  const stmts = [
    upsertSql(T_PL, [
      { name: 'id', v: rec.id, raw: true },
      { name: 'name', v: rec.name || '' },
      { name: 'cover', v: rec.cover || '' },
      { name: 'creator', v: rec.creator || '' },
      { name: 'track_cnt', v: Number(rec.trackCount) || 0, raw: true },
      { name: 'base_ids', v: '' },
      { name: 'remote_ids', v: '' },
      { name: 'pulled_at', v: Number(rec.lastPullAt) || 0, raw: true }
    ], 'id'),
    deleteSql(T_PT, 'playlist_id = ' + num(rec.id))
  ]
  const baseText = JSON.stringify(base)
  const remoteText = JSON.stringify(remote)
  const baseChunks = appendTextColSql(T_PL, 'id', rec.id, 'base_ids', baseText)
  const remoteChunks = appendTextColSql(T_PL, 'id', rec.id, 'remote_ids', remoteText)

  // 2) 关系表 = base ∪ remote（引用集合），ord = 并集里的位置
  const union = []
  const seen = {}
  for (let i = 0; i < base.length; i++) {
    const id = Number(base[i]) || 0
    if (id && !seen[id]) {
      seen[id] = 1
      union.push(id)
    }
  }
  for (let i = 0; i < remote.length; i++) {
    const id = Number(remote[i]) || 0
    if (id && !seen[id]) {
      seen[id] = 1
      union.push(id)
    }
  }
  const rows = []
  for (let i = 0; i < union.length; i++) rows.push([rec.id, union[i], i])
  const rowStmts = replaceRowsSql(T_PT, ['playlist_id', 'track_id', 'ord'], rows)

  if (d) {
    d.playlist[k] = {
      id: rec.id,
      name: rec.name || '',
      cover: rec.cover || '',
      creator: rec.creator || '',
      track_cnt: Number(rec.trackCount) || 0,
      base_ids: baseText,
      remote_ids: remoteText,
      pulled_at: Number(rec.lastPullAt) || 0
    }
    const keep = []
    const all = d.playlist_track || []
    for (let i = 0; i < all.length; i++) {
      if (Number(all[i].playlist_id) !== Number(rec.id)) keep.push(all[i])
    }
    for (let i = 0; i < union.length; i++) {
      keep.push({ playlist_id: rec.id, track_id: union[i], ord: i })
    }
    d.playlist_track = keep
  }

  // 顺序：行 → 两个大列 → 关系行（每步都可能跨多批，runStmts 按字节装箱）
  await runStmts(stmts)
  await runStmts(baseChunks.concat(remoteChunks))
  await runStmts(rowStmts)
}

// 删一条歌单记录（playlist 行 + 关系行；不碰任何文件）
async function forget(id) {
  const k = String(id)
  const pid = Number(id) || 0
  if (mem) delete mem[k]
  const d = dbData()
  if (d) {
    delete d.playlist[k]
    const keep = []
    const all = d.playlist_track || []
    for (let i = 0; i < all.length; i++) {
      if (Number(all[i].playlist_id) !== pid) keep.push(all[i])
    }
    d.playlist_track = keep
  }
  if (!pid) return
  await dbExec([
    deleteSql(T_PT, 'playlist_id = ' + num(pid)),
    deleteSql(T_PL, 'id = ' + num(pid))
  ])
}

// 确保载入（各导出函数内部会等它；页面要同步读缓存时可先 await loadLists()）
export async function loadLists() {
  await load()
  return mem
}

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

export async function isIndexed(pid) {
  await load()
  return !!(mem && mem[String(pid)])
}

export async function indexedCount() {
  await load()
  return Object.keys(mem || {}).length
}

// 添加到本地索引：抓歌单元信息 + 全量 trackIds（n:0 时 trackIds 仍全量），baseIds = remoteIds = 当前远端快照。
// 只落索引、不下载文件；A/D 是相对本地文件实时算的，所以歌单里本来就有但没下载的曲目立刻显示为 A
export async function addList(pid) {
  const id = Number(pid) || 0
  if (!id) return { ok: false, error: '缺少歌单 id' }
  await load()
  if (await isOffline()) return { ok: false, offline: true, error: '离线' }
  try {
    const info = await fetchPlaylistInfo(id)
    const ids = info.trackIds || []
    const now = Date.now()
    const rec = normalizeRecord({
      id: id,
      name: info.name,
      cover: info.cover,
      creator: info.creator,
      trackCount: info.trackCount || ids.length,
      updateTime: info.updateTime || 0,
      baseIds: ids,
      remoteIds: ids,
      lastPullAt: now,
      addedAt: now,
      lastSyncAt: now,
      meta: {}
    })
    await persist(rec)
    log('locallists', '添加本地索引 ' + id + ' ' + info.name + ' 曲目=' + ids.length)
    return { ok: true, list: rec, count: ids.length }
  } catch (e) {
    log('locallists', '添加本地索引失败 ' + id + '：' + ((e && e.message) || e))
    return { ok: false, error: (e && e.message) || '添加失败' }
  }
}

// 移出本地索引：只删记录，**不碰文件**（策略 A）。失去最后一个引用的歌单批量下载文件
// 会由分类自动落到「遗留歌曲」；用户单曲/遗留文件不受影响
export async function removeList(pid) {
  const id = Number(pid) || 0
  await load()
  if (!id || !mem[String(id)]) return { ok: false }
  const rec = mem[String(id)]
  await forget(id)
  log('locallists', '移出本地索引 ' + id + ' ' + rec.name + '（文件保留）')
  return { ok: true, list: rec }
}

// 本地删除：移除索引，并把「移出后会变成遗留歌曲」的文件直接删掉（不留孤儿）。
// 删除范围 = 本歌单引用（baseIds ∪ remoteIds）∩ 本地已下载 ∩ 移出后不被其它已索引歌单引用 ∩ 归属为 playlist；
// 仍被其它索引歌单引用的、以及用户单曲/无标记文件**不动**。
// 须在索引记录还在时调用（内部先算引用、再移除）
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
    if (others[k]) continue 
    if (!listHasSong(rec, s.id)) continue 
    if (!isPlaylistOwned(s.id)) continue 
    doomed.push(s)
  }

  // 先移除索引：之后即使删文件失败，这些歌也已是「无引用」状态，不会指回已移出的歌单
  await forget(id)
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

function toSet(arr) {
  const out = {}
  const list = arr || []
  for (let i = 0; i < list.length; i++) out[String(list[i])] = 1
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

export function listHasSong(rec, songId) {
  if (!rec) return false
  const k = String(songId)
  const base = rec.baseIds || []
  const remote = rec.remoteIds || []
  for (let i = 0; i < base.length; i++) if (String(base[i]) === k) return true
  for (let i = 0; i < remote.length; i++) if (String(remote[i]) === k) return true
  return false
}

// 跨文件接线：内存表与写入入口只有这一份，同步与视图文件都从这里取
export { load, persist, toSet, metaToSong, songToMeta }
