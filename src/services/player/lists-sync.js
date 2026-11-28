import { fetchPlaylistInfo, fetchPlaylistAllSongs, fetchTracksMore, TRACKS_CHUNK } from '../ncm/playlist.js'
import { downloadSongs } from './download.js'
import { listSongs } from './cache.js'
import { isOffline } from '../../core/infra/net/status.js'
import { log } from '../../core/infra/log.js'
import { load, persist, toSet, metaToSong, songToMeta, allLists } from './lists-record.js'

// 本地已下载 id 集合。调用方已经扫过目录时传 localIds（数组）复用；没传才自己扫一次
// （单次 pull 可接受；pullAll 会先扫一次再整轮传进来，避免 N 个歌单各扫一次）
async function localSetOf(localIds) {
  if (Array.isArray(localIds)) return toSet(localIds)
  const songs = await listSongs()
  const ids = []
  for (let i = 0; i < songs.length; i++) ids.push(songs[i].id)
  return toSet(ids)
}

function addedIdsOf(remote, localSet) {
  const out = []
  for (let i = 0; i < remote.length; i++) {
    if (!localSet[String(remote[i])]) out.push(remote[i])
  }
  return out
}

function removedIdsOf(base, remote, localSet) {
  const rset = toSet(remote)
  const out = []
  for (let i = 0; i < base.length; i++) {
    const k = String(base[i])
    if (!rset[k] && localSet[k]) out.push(base[i])
  }
  return out
}

// 补一批 A 条目的元数据（显示/下载用），返回 {id: meta}；失败只记日志、不阻断拉取。
// 不直接改 rec：调用方拿到结果后自己合并、落盘
export async function fetchMeta(ids) {
  const list = ids || []
  const out = {}
  if (!list.length) return out
  try {
    let got = 0
    for (let off = 0; off < list.length; off += TRACKS_CHUNK) {
      const batch = list.slice(off, off + TRACKS_CHUNK)
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

// 拉取：只更新远端快照/歌单信息/上次拉取时间，不下载、不移动文件。
// baseIds 会吸收上一版 remoteIds：曾进过歌单、本地有文件的曲目，远端移除后仍能判成 D
// 返回 {ok, list, added:[id], removed:[id], offline?, error?}
export async function pullList(pid, localIds) {
  const id = Number(pid) || 0
  const mem = await load()
  const rec = mem[String(id)]
  if (!id || !rec) return { ok: false, error: '未添加到本地索引' }
  if (await isOffline()) return { ok: false, offline: true, error: '离线' }
  try {
    const local = await localSetOf(localIds)
    const info = await fetchPlaylistInfo(id)
    const remote = info.trackIds || []
    const oldRemote = rec.remoteIds || []

    // baseIds = 曾见过的远端曲目并集：旧快照里新增过的曲目也并进来，
    // 这样「拉取过但没同步、随后被远端移除」的本地文件也能显示成 D
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
    await persist(rec)
    log('locallists', '拉取 ' + id + ' ' + rec.name + ' 远端=' + remote.length +
      ' 本地=' + Object.keys(local).length + ' 新增=' + added.length + ' 移除=' + removed.length)
    return { ok: true, list: rec, added: added, removed: removed }
  } catch (e) {
    log('locallists', '拉取失败 ' + id + '：' + ((e && e.message) || e))
    return { ok: false, error: (e && e.message) || '拉取失败' }
  }
}

// 自动拉取（启动时）：逐个拉取已索引歌单，只更新远端快照，绝不下载/删文件。
// 离线时直接返回，不做 N 次超时；localIds 传入则复用，否则整轮只扫一次本地目录
// 返回汇总
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

// 同步：先拉取 → 下载**所有 A**（远端有、本地没有）→ 把 D 从 baseIds 移除
// （文件保留，策略 A）。成功后 baseIds = 当前远端快照；失败的 A 保持 A，下次重试
// 返回 {ok, added, downloaded, skipped, failed, removed, failedIds, offline?, error?}
export async function syncList(pid, localIds) {
  const id = Number(pid) || 0
  const mem = await load()
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
  // A 不依赖 base，而是实时按本地文件算；失败/取消的 A 仍会在列表里保持 A
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
  await persist(rec)
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

// 「下载全部」：已索引歌单先拉取，再下载整张远端曲目（origin=playlist），完成后 baseIds = 当前远端快照
// （D 被移除、文件保留），失败的 A 保留元数据 —— 等于「同步 + 补齐所有未下载项」；
// 未索引歌单按用户单曲下载（origin=manual），不创建索引、不产生遗留分类。
// onProgress(done,total) 可选（拉取曲目对象阶段）
export async function downloadAll(pid, onProgress) {
  const id = Number(pid) || 0
  if (!id) return { ok: false, error: '缺少歌单 id' }
  const mem = await load()
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
      await persist(rec)
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
