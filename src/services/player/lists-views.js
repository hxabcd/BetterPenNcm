import { isOffline } from '../../core/infra/net/status.js'
import { isPlaylistOwned, isUser, loadOrigin } from './dlorigin.js'
import { load, persist, toSet, metaToSong } from './lists-record.js'
import { fetchMeta } from './lists-sync.js'

// 所有已索引歌单引用的曲目 id（baseIds ∪ remoteIds）
export async function referencedIds() {
  const mem = await load()
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

// 单首分类：'playlist'（被任一索引歌单引用）| 'orphan'（歌单批量下载但已无引用）|
// 'single'（用户单曲/无引用且非歌单归属）。
// 须先 await loadLists() + referencedIds()；批量场景用 splitDownloads 只算一次引用表
export function classifyWithRefs(songId, refs) {
  if (refs && refs[String(songId)]) return 'playlist'
  if (isPlaylistOwned(songId) && !isUser(songId)) return 'orphan'
  return 'single'
}

// 把已下载歌曲拆成三类（本地下载页用，只扫一次引用表）：返回 {single, orphan, playlist, refs}
//   - playlist 只表示「被任一索引歌单引用」，不区分哪个歌单（歌单内视图由 playlistView 给）
//   - 单曲 = 无引用且不是歌单批量下载；遗留 = 无引用且是歌单批量下载
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

// 某歌单的本地视图：A = 远端有、本地没下载；D = base 有、远端已移除、本地有文件；其余本地文件为普通行。
// A/D 与 baseIds 的「上次快照」无关，只取决于本地文件是否存在
export async function playlistView(pid, downloadedSongs) {
  const mem = await load()
  const rec = mem[String(pid)]
  if (!rec) return null
  const down = {}
  const list = downloadedSongs || []
  for (let i = 0; i < list.length; i++) down[String(list[i].id)] = list[i]
  const remote = rec.remoteIds || []
  const remoteSet = toSet(remote)
  const base = rec.baseIds || []
  const baseSet = toSet(base)

  // A 条目：远端有、本地没有。先把元数据补齐（离线/失败时显示占位名，下次再补）
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

  // 本地有、远端也有、但 base 里没有（例如远端刚加就手动下载）：并入 base，
  // 这样之后远端把它移除时，D 仍能认出来
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
  if (baseChanged || metaChanged || metaFetched) await persist(rec)

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
  // 这样 A/D 一定在第一屏，不会因为分页（50 行/批）被埋到几百行之后
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
