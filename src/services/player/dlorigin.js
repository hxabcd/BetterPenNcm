/**
 * 下载归属标记 —— 区分「用户自己的单曲」与「为本地索引歌单批量下载的文件」。
 *
 * 为什么需要它：本地下载页把已下载文件分成三类——
 *   单曲下载 / 歌单内歌曲 / 遗留歌曲（原歌单已移出索引，但按策略 A 保留文件）。
 * 只靠文件系统无法知道一首歌是怎么来的；于是给每首已下载歌曲记一个**归属标记**：
 *
 *   user     —— 用户主动下载（播放器下载键、专辑/歌手/搜索、列表多选），
 *               以及本功能上线前就存在的遗留文件（没有标记 = 按 user 处理）。
 *   playlist —— 只在「歌单详情 → 下载全部」、同步、自动同步时写入；
 *               这类文件在失去所有已索引歌单引用后，才归入「遗留歌曲」。
 *
 * 分类不需要记「来自哪个歌单」：只要知道它是不是歌单批量下载的，
 * 再结合当前所有已索引歌单的 baseIds ∪ remoteIds 动态派生即可
 * （见 locallists.js 的 classifyWithRefs）。这样移出索引 / 同步 D 都不必维护
 * 一张容易过期的孤儿表，重启、重复同步、崩溃都不会留下陈旧状态。
 *
 * 规则（与 download.js 的调用点一一对应）：
 *   - user 一旦写入就是终态：后续歌单批量下载只跳过，不改写。
 *   - playlist 写入前先看已有标记：已有 user 则保持 user。
 *   - 批量下载**跳过已存在的文件**时：没有标记 → 补 user（遗留文件按用户资产处理，
 *     绝不把用户已有的文件「认领」成歌单归属）；已有标记 → 保持。
 *   - 删除文件（任何入口）→ 清标记；清空已下载 → 清全表。
 *
 * 存储：索引库 `local_index.db` 的 `track.dl_origin` 列（0=无 1=user 2=playlist）。
 * 与曲目索引共用 track 行，但**只写这一列**：
 *   - 曲目没进过索引（本功能上线前的老文件）也会有一行：name 为空、只有 dl_origin。
 *     localmeta 的「已索引」判据是 name 非空，所以这类行不会被当成有详情的曲目。
 *   - 反过来，清标记只把列置 0，不删行（行里的索引数据仍有效）。
 * 读写模型见 utils/db.js：内存态是读的真相，写走批量 upsert（一批一个事务）。
 */
import { open as dbOpen, data as dbData, exec as dbExec, upsertSql, num } from '../../core/platform/db.js'
import { log } from '../../core/infra/log.js'

const T_TRACK = 'track'
export const ORIGIN_USER = 1
export const ORIGIN_PLAYLIST = 2

let mem = null // { "<songId>": 1|2 }（非零才有条目）
let loading = null

/** DB 内存态 → 归属表（只收非零的行） */
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

/**
 * 落一批标记（内存已改完；这里只拼 SQL）。
 * 新 id 用 upsert（行可能不存在 —— 老文件没有索引记录），name 交给默认值。
 */
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

/** 把一批 id 的标记置 0（不删行，行里的索引数据仍有效） */
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

/** 确保已载入（各导出函数内部都会等它） */
export function loadOrigin() {
  return load()
}

/** 归属标记（须先 await loadOrigin；未载入时返回 0） */
export function originOf(id) {
  if (!mem) return 0
  return mem[String(id)] || 0
}

/** 是不是用户自己的单曲；**没有标记也按 user 处理**（遗留文件） */
export function isUserOrLegacy(id) {
  return originOf(id) !== ORIGIN_PLAYLIST
}

export function isUser(id) {
  return originOf(id) === ORIGIN_USER
}

export function isPlaylistOwned(id) {
  return originOf(id) === ORIGIN_PLAYLIST
}

/**
 * 标记用户自己的单曲（手动下载）。数组批量，写一次库。
 * 已有 playlist 标记会被 user 覆盖（用户明确要了这首，归属归用户）。
 */
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

/**
 * 标记歌单批量下载。数组批量，写一次库。
 * 已有 user 的保持 user；已有 playlist 的保持；没有标记的写成 playlist。
 * 返回新标记数量。
 */
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

/**
 * 歌单批量下载**跳过已存在文件**时的归属处理：
 *   - 没有任何标记 → 补 user（遗留文件 / 用户以前自己下的，按用户资产处理）
 *   - 已有标记 → 原样保留
 * 这样「下载全部」不会把用户已有的文件认领成歌单归属，移出索引时也不会误进遗留。
 */
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

/** 删单首/多首 → 清标记（文件删掉后归属也失效） */
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

/** 清空全部标记（存储管理「清空已下载」时调）：只把列置 0，不动曲目索引行 */
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

/** 当前标记表快照（诊断/日志用；返回 ids 数组） */
export async function originSnapshot() {
  await load()
  const user = []
  const playlist = []
  const keys = Object.keys(mem || {})
  for (let i = 0; i < keys.length; i++) {
    if (mem[keys[i]] === ORIGIN_USER) user.push(keys[i])
    else if (mem[keys[i]] === ORIGIN_PLAYLIST) playlist.push(keys[i])
  }
  return { user: user, playlist: playlist }
}
