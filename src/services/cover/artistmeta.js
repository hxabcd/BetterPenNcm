/**
 * 歌手资料缓存：只存头像 URL（以及名字、抓取时间），供本地页面离线判断。
 *
 * 为什么单独一张表：本地曲目索引（local_index.db 的 track 行）只带歌手 id/名字，
 * 不存歌手头像；而 /api/artist/head/info/get 每次都要发请求。把头像 URL 落盘后，
 * 封面缓存键 arp<id>@<size> 才能在清过封面缓存/重启后按同一来源重新下载，
 * 列表页也不必为已知歌手反复打接口。
 *
 * 落点：索引库 `local_index.db` 的 `artist` 表两列 avatar / av_at（结构见 docs/存储重构.md §1.3），
 * 与曲目索引共用同一张 artist 表 —— `name` 列由 localmeta 写曲目时顺带维护（只写 name），
 * 本模块只写 avatar / av_at，两边互不擦除对方写的列。
 *
 * 记录形状对外不变：{n 名字, p 头像 URL, t 抓取时间}
 * - p 非空 = 真头像来源；
 * - p 为空且 t 在负缓存期内 = 查过没有头像，别反复请求（负缓存期见 artistavatar.js）。
 * 写入按批防抖（SAVE_DELAY），避免批量预热时逐条 fork。
 */
import { open as dbOpen, data as dbData, exec as dbExec, upsertSql } from '../../core/platform/db.js'
import { log } from '../../core/infra/log.js'

const T_ARTIST = 'artist'
const SAVE_DELAY = 500

let mem = null
let loading = null
let saveTimer = 0
let dirty = false
const pending = {} // id → true（待写库的歌手 id）

/** 图片 URL 统一 https（网易云部分接口回 http:// 或 //） */
export function normalizePic(u) {
  const s = String(u || '')
  if (!s) return ''
  if (s.indexOf('//') === 0) return 'https:' + s
  if (s.indexOf('http://') === 0) return 'https://' + s.slice(7)
  return s
}

/**
 * DB 内存态（artist 表）→ 本模块的记录形状。
 * 只收有头像信息的行：name 由曲目索引维护，单独一个名字不构成「歌手资料」。
 */
function buildMem() {
  const d = dbData()
  const out = {}
  if (!d) return out
  const rows = d.artist || {}
  const keys = Object.keys(rows)
  for (let i = 0; i < keys.length; i++) {
    const row = rows[keys[i]]
    if (!row) continue
    const p = row.avatar || ''
    const t = Number(row.av_at) || 0
    if (!p && !t) continue // 只有名字的行：不是「资料」，别让它变成假记录
    out[keys[i]] = { n: row.name || '', p: p, t: t }
  }
  return out
}

export async function loadArtistMeta() {
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

/** 同步取（须先 await loadArtistMeta）；没有记录返回 null */
export function artistMetaSync(id) {
  return (mem && mem[String(id)]) || null
}

/** 写入/更新一位歌手的资料（cover 为空 = 负缓存）。返回记录。 */
export async function rememberArtist(id, name, cover) {
  const k = String(id)
  if (!k || k === 'undefined' || k === '0') return null
  try {
    await loadArtistMeta()
    const nid = Number(k)
    if (!nid) return null
    const prev = mem[k] || {}
    const rec = {
      n: name || prev.n || '',
      p: normalizePic(cover),
      t: Date.now()
    }
    mem[k] = rec
    // 内存行同时更新（artist 表是共享的：曲目索引也读它）
    const d = dbData()
    if (d) {
      const row = d.artist[k] || { id: nid, name: '', avatar: '', av_at: 0 }
      row.id = nid
      if (rec.n) row.name = rec.n
      row.avatar = rec.p
      row.av_at = rec.t
      d.artist[k] = row
    }
    pending[k] = 1
    scheduleSave()
    return rec
  } catch (e) {
    log('artistmeta', '写歌手资料失败 ' + k + '：' + ((e && e.message) || e))
    return null
  }
}

function scheduleSave() {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(function () {
    saveTimer = 0
    if (!dirty) return
    dirty = false
    flushPending()
  }, SAVE_DELAY)
}

/** 把待写的歌手资料拼成一批 upsert（一次 fork）。失败只记日志，内存态仍是真相。 */
function flushPending() {
  const keys = Object.keys(pending)
  if (!keys.length) return
  for (let i = 0; i < keys.length; i++) delete pending[keys[i]]
  if (!mem) return
  const d = dbData()
  const stmts = []
  for (let i = 0; i < keys.length; i++) {
    const rec = mem[keys[i]]
    if (!rec) continue
    const nid = Number(keys[i])
    if (!nid) continue
    // name 列取自共享内存行（可能是曲目索引写的）：写空会把歌手名擦掉，所以必须带上现值
    const row = (d && d.artist[keys[i]]) || null
    stmts.push(upsertSql(T_ARTIST, [
      { name: 'id', v: nid, raw: true },
      { name: 'name', v: (row && row.name) || rec.n || '' },
      { name: 'avatar', v: rec.p || '' },
      { name: 'av_at', v: Number(rec.t) || 0, raw: true }
    ], 'id'))
  }
  dbExec(stmts).catch(function () {
    log('artistmeta', '歌手资料写入失败')
  })
}
