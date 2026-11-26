/**
 * 下载归属标记 —— 区分「用户自己的单曲」与「为本地索引歌单批量下载的文件」
 *
 *   user（1）     —— 用户主动下载（播放器下载键、专辑/歌手/搜索、列表多选）；没有标记的文件按 user 处理，且 user 一旦写入就是终态
 *   playlist（2） —— 只在「下载全部」、同步、自动同步时写入；失去所有已索引歌单引用后才归入「遗留歌曲」
 *
 * 存储：索引库 local_index.db 的 track.dl_origin 列（0=无 1=user 2=playlist）。与曲目索引共用 track 行但只写这一列：
 * 没进过索引的老文件也会有一行（name 为空、只有 dl_origin；localmeta 的「已索引」判据是 name 非空）；清标记只把列置 0，不删行。
 */


import { open as dbOpen, data as dbData, exec as dbExec, upsertSql, num } from '../../core/platform/db.js'
import { log } from '../../core/infra/log.js'

const T_TRACK = 'track'
export const ORIGIN_USER = 1
export const ORIGIN_PLAYLIST = 2

// { "<songId>": 1|2 }（非零才有条目）
let mem = null 
let loading = null

// DB 内存态 → 归属表（只收非零的行）
function buildMem() {
  const d = dbData()
  const out = {}
  if (!d) return out
  const rows = d.track || {}
  const keys = Object.keys(rows)
  for (let i = 0; i < keys.length; i++) {
    const v = Number(rows[keys[i]] && rows[keys[i]].dl_origin) || 0
    if (v) out[keys[i]] = v
  }
  return out
}

async function load() {
  if (mem) return mem
  if (loading) return loading
  loading = (async function () {
    try {
      await dbOpen()
    } catch (e) {}
    mem = buildMem()
    loading = null
    return mem
  })()
  return loading
}

// 落一批标记（内存已改完；这里只拼 SQL）。新 id 用 upsert（行可能不存在 —— 老文件没有索引记录），name 交给默认值
function persist(ids, value) {
  if (!ids.length) return Promise.resolve(false)
  const d = dbData()
  const stmts = []
  for (let i = 0; i < ids.length; i++) {
    const id = Number(ids[i]) || 0
    if (!id) continue
    if (d) {
      const row = d.track[String(id)] || { id: id, name: '', alias: '', album_id: 0, duration: 0, pub: 0, track_no: 0, disc: '', pop: 0, fee: 0, cover: '', added_at: 0 }
      row.id = id
      row.dl_origin = value
      if (row.added_at === undefined) row.added_at = 0
      d.track[String(id)] = row
    }
    stmts.push(upsertSql(T_TRACK, [
      { name: 'id', v: id, raw: true },
      { name: 'dl_origin', v: Number(value) || 0, raw: true }
    ], 'id'))
  }
  if (!stmts.length) return Promise.resolve(false)
  return dbExec(stmts)
}

// 把一批 id 的标记置 0（不删行，行里的索引数据仍有效）
function persistClear(ids) {
  if (!ids.length) return Promise.resolve(false)
  const d = dbData()
  const nums = []
  for (let i = 0; i < ids.length; i++) {
    const id = Number(ids[i]) || 0
    if (!id) continue
    if (d && d.track[String(id)]) d.track[String(id)].dl_origin = 0
    nums.push(num(id))
  }
  if (!nums.length) return Promise.resolve(false)
  return dbExec(['UPDATE ' + T_TRACK + ' SET dl_origin = 0 WHERE id IN (' + nums.join(',') + ');'])
}

// 确保已载入（各导出函数内部都会等它）
export function loadOrigin() {
  return load()
}

// 归属标记（须先 await loadOrigin；未载入时返回 0）
export function originOf(id) {
  if (!mem) return 0
  return mem[String(id)] || 0
}

export function isUser(id) {
  return originOf(id) === ORIGIN_USER
}

export function isPlaylistOwned(id) {
  return originOf(id) === ORIGIN_PLAYLIST
}

// 标记用户自己的单曲（手动下载）：数组批量，写一次库；已有 playlist 标记会被 user 覆盖（用户明确要了这首，归属归用户）
export async function markUser(ids) {
  try {
    await load()
    const arr = ids || []
    const changed = []
    for (let i = 0; i < arr.length; i++) {
      const id = String(arr[i] || '')
      if (!id) continue
      if (mem[id] !== ORIGIN_USER) {
        mem[id] = ORIGIN_USER
        changed.push(id)
      }
    }
    if (changed.length) {
      await persist(changed, ORIGIN_USER)
      log('origin', '标记用户单曲 ' + changed.length + ' 首')
    }
    return changed.length
  } catch (e) {
    log('origin', '标记用户单曲失败：' + ((e && e.message) || e))
    return 0
  }
}

// 标记歌单批量下载：数组批量，写一次库；已有 user 的保持 user，已有 playlist 的保持，没有标记的写成 playlist
export async function markPlaylist(ids) {
  try {
    await load()
    const arr = ids || []
    const changed = []
    for (let i = 0; i < arr.length; i++) {
      const id = String(arr[i] || '')
      if (!id) continue
      if (mem[id]) continue
      mem[id] = ORIGIN_PLAYLIST
      changed.push(id)
    }
    if (changed.length) {
      await persist(changed, ORIGIN_PLAYLIST)
      log('origin', '标记歌单归属 ' + changed.length + ' 首')
    }
    return changed.length
  } catch (e) {
    log('origin', '标记歌单归属失败：' + ((e && e.message) || e))
    return 0
  }
}

// 歌单批量下载跳过已存在文件时的归属处理：没有任何标记 → 补 user（遗留文件 / 用户以前自己下的，按用户资产处理）；已有标记 → 原样保留
// 这样「下载全部」不会把用户已有的文件认领成歌单归属，移出索引时也不会误进遗留
export async function markSkippedExisting(ids) {
  try {
    await load()
    const arr = ids || []
    const changed = []
    for (let i = 0; i < arr.length; i++) {
      const id = String(arr[i] || '')
      if (!id) continue
      if (mem[id]) continue
      mem[id] = ORIGIN_USER
      changed.push(id)
    }
    if (changed.length) {
      await persist(changed, ORIGIN_USER)
      log('origin', '跳过已存在文件，补记用户归属 ' + changed.length + ' 首')
    }
    return changed.length
  } catch (e) {
    log('origin', '补记用户归属失败：' + ((e && e.message) || e))
    return 0
  }
}

// 删单首/多首 → 清标记（文件删掉后归属也失效）
export async function clearOrigin(ids) {
  try {
    await load()
    const arr = ids || []
    const changed = []
    for (let i = 0; i < arr.length; i++) {
      const id = String(arr[i] || '')
      if (id && mem[id]) {
        delete mem[id]
        changed.push(id)
      }
    }
    if (changed.length) await persistClear(changed)
    return changed.length
  } catch (e) {
    log('origin', '清归属标记失败：' + ((e && e.message) || e))
    return 0
  }
}

// 清空全部标记（存储管理「清空已下载」时调）：只把列置 0，不动曲目索引行
export async function clearAllOrigins() {
  mem = {}
  try {
    const d = dbData()
    if (d) {
      const rows = d.track || {}
      const keys = Object.keys(rows)
      for (let i = 0; i < keys.length; i++) rows[keys[i]].dl_origin = 0
    }
    await dbExec(['UPDATE ' + T_TRACK + ' SET dl_origin = 0 WHERE dl_origin <> 0;'])
  } catch (e) {
    log('origin', '清空归属标记失败：' + ((e && e.message) || e))
  }
  log('origin', '已清空下载归属标记')
}
