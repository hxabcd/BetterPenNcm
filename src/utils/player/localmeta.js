/**
 * 本地音乐库：已下载歌曲的**完整元数据索引**（SQLite 索引库）与**歌词**（每 track 一个 lyrics.json）
 *
 * 索引落 `local_index.db` 的四张表（结构见 docs/存储重构.md §1.3）：track / track_artist /
 * album / artist。读写模型见 utils/db.js：boot 时整库灌内存，此后查询都在内存里（不分叉），
 * 写走单条 upsert（代价与库规模无关 —— 旧实现把整张表塞进 `store/local_index.json`，
 * 一条改动就重写 62KB）。
 *
 * 歌词落 `downloads/<id>/lyrics.json`（`{v, lrc, tlyric, yrc, pureMusic}`，读写走 utils/media.js），
 * 对外仍按旧形状 `{l, t, pm, y}` 给调用方（player/lyric.js 依赖这个形状）。
 * cache 通道的歌**不存歌词**：它们会被 LRU 滚掉，留下就是孤儿数据。
 *
 * 覆盖时机：
 *   - 用户下载完成（download.js 的 downloadOne 挂点，只挂 download 通道）
 *   - 本功能之前的老下载：downloads 页 enrich 在线时逐首 backfill
 *   - 播放在线下载曲、网络歌词到手而库里还没有时（lyric.js 的自愈落盘）
 * 清理随文件走：deleteCached → dropLocalSong；clearSongs → clearLocalLibrary。
 *
 * **「已索引」判据**：track 表里 name 非空的行才算本地库的曲目。
 * 下载归属（dlorigin.js）会给「没有索引记录的老文件」单独补写 track.dl_origin，
 * 那种行的 name 是空的 —— 不能把它们当成「有详情可用的曲目」。
 */
import { open as dbOpen, data as dbData, exec as dbExec, upsertSql, deleteSql, num } from '../db.js'
import { readLyrics, writeLyrics, dropFile } from '../media.js'
import { trackLyrics } from '../paths.js'
import { fetchSongInfo, fetchLyric } from '../ncm/api.js'
import { enqueueCovers } from '../cover.js'
import { enqueueArtistPortraits } from '../artistavatar.js'
import { log } from '../log.js'
import { raceTimeout } from '../util.js'

const T_TRACK = 'track'
const T_TA = 'track_artist'
const T_ALBUM = 'album'
const T_ARTIST = 'artist'

/**
 * 一条 sqlite3 命令的体积预算（**转义后的字节数**）。
 *
 * db.js 把整批 SQL 拼成**一个** `/bin/sh -c <整串>` 参数，而单参数上限环境相关：
 * 设备（Linux）128KB，开发机 Git Bash 实测 ~6KB 就报 `unexpected EOF`。
 * 所以按**字节**装箱：大库只是多 fork 几次，而「整批超限 → 整批静默失败」会凭空丢索引。
 */
const SQL_BATCH_BYTES = 6000

/** 一条语句在 shell 单引号里占的字节（对齐 db.js 的 shq：外层一对 '，内部每个 ' 变 4 字符） */
function escapedLen(sql) {
  let n = sql.length + 2
  for (let i = 0; i < sql.length; i++) if (sql.charAt(i) === "'") n += 3
  return n
}

/** 顺序提交一批 SQL，按字节装箱（每箱一次 fork）。单条超限时自己成批，不连带整批。 */
async function runStmts(stmts) {
  let batch = []
  let bytes = 0
  for (let i = 0; i < stmts.length; i++) {
    const b = escapedLen(stmts[i])
    if (batch.length && bytes + b > SQL_BATCH_BYTES) {
      await dbExec(batch)
      batch = []
      bytes = 0
    }
    batch.push(stmts[i])
    bytes += b
  }
  if (batch.length) await dbExec(batch)
}

/**
 * 多行 `INSERT OR REPLACE`：一行元组只要 ~20B。
 * 逐条写 upsert 要 ~90B/行（每条都重复列名与 ON CONFLICT 子句），
 * 几百首的库在 6KB 预算下会多 fork 好几倍。
 */
function replaceRowsSql(table, cols, rows) {
  if (!rows.length) return []
  const head = 'INSERT OR REPLACE INTO ' + table + ' (' + cols.join(',') + ') VALUES '
  const out = []
  let tuples = []
  let bytes = escapedLen(head) + 8
  for (let i = 0; i < rows.length; i++) {
    const vals = []
    for (let k = 0; k < rows[i].length; k++) {
      const v = rows[i][k]
      vals.push(typeof v === 'number' ? num(v) : qv(v))
    }
    const t = '(' + vals.join(',') + ')'
    const cost = t.length + 1
    if (tuples.length && bytes + cost > SQL_BATCH_BYTES) {
      out.push(head + tuples.join(',') + ';')
      tuples = []
      bytes = escapedLen(head) + 8
    }
    tuples.push(t)
    bytes += cost
  }
  if (tuples.length) out.push(head + tuples.join(',') + ';')
  return out
}

/** SQL 字符串字面量（与 utils/db.js 的 q 同语义：单引号包裹、内部 ' 翻倍） */
function qv(v) {
  if (v === undefined || v === null) return 'NULL'
  return "'" + String(v).replace(/'/g, "''") + "'"
}

/* ---------------- 类型归一 ---------------- */

/** 数字列：非有限数一律 0（避免把 NaN 写进 SQL 造成语法错误） */
function int(v) {
  const n = Number(v)
  return isFinite(n) ? Math.round(n) : 0
}

/** alias 列存的是 JSON 数组文本；坏了按空数组处理 */
function parseArr(s) {
  if (!s) return []
  try {
    const a = JSON.parse(s)
    return Array.isArray(a) ? a : []
  } catch (e) {
    return []
  }
}

/* ---------------- 索引（内存投影，形状与旧 store/local_index.json 一致） ---------------- */

let mem = null
let loading = null

/**
 * 从 DB 内存态投影出「songId → 记录」表（只读快照，写入后重建）。
 * 记录形状沿用旧 JSON 表：{n, alia, ars:[{i,n}], al:{i,n,c}, d, pub, no, cd, pop, fee}
 * —— 上层视图函数（toSong / localArtistView / localAlbumList ...）一行都不用改。
 */
function buildMem() {
  const d = dbData()
  const out = {}
  if (!d) return out
  // track_artist 按 track_id 分组，组内按 ord（展示顺序）
  const byTrack = {}
  const ta = d.track_artist || []
  for (let i = 0; i < ta.length; i++) {
    const k = String(int(ta[i].track_id))
    if (!byTrack[k]) byTrack[k] = []
    byTrack[k].push(ta[i])
  }
  const tids = Object.keys(byTrack)
  for (let i = 0; i < tids.length; i++) {
    byTrack[tids[i]].sort(function (a, b) {
      return int(a.ord) - int(b.ord)
    })
  }
  const tracks = d.track || {}
  const albums = d.album || {}
  const artists = d.artist || {}
  const keys = Object.keys(tracks)
  for (let i = 0; i < keys.length; i++) {
    const row = tracks[keys[i]]
    if (!row || !row.name) continue // 见文件头「已索引判据」
    const alId = int(row.album_id)
    const al = albums[String(alId)] || null
    const rows = byTrack[keys[i]] || []
    const ars = []
    for (let k = 0; k < rows.length; k++) {
      const aid = int(rows[k].artist_id)
      const ar = artists[String(aid)] || null
      ars.push({ i: aid, n: (ar && ar.name) || '' })
    }
    out[keys[i]] = {
      n: row.name || '',
      alia: parseArr(row.alias),
      ars: ars,
      al: {
        i: alId,
        n: (al && al.name) || '',
        c: (al && al.cover) || row.cover || ''
      },
      d: int(row.duration),
      pub: int(row.pub),
      no: int(row.track_no),
      cd: row.disc || '',
      pop: int(row.pop),
      fee: int(row.fee)
    }
  }
  return out
}

export async function loadIndex() {
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

/** 同步取一条（须先 await loadIndex()；各导出视图函数内部已保证） */
export function indexOf(id) {
  return (mem && mem[String(id)]) || null
}

function mapArtists(list) {
  const out = []
  const ar = list || []
  for (let i = 0; i < ar.length; i++) {
    if (!ar[i] || !ar[i].id) continue
    out.push({ i: ar[i].id, n: ar[i].name || '' })
  }
  return out
}

/**
 * 写入一首歌的索引（与已有条目**合并写**：新快照缺的字段保留旧值）。
 * info = fetchSongInfo 的返回（{song, artists, album, publishTime, trackNo, disc, popularity}）。
 *
 * 两条路径一起更新：先改内存投影（读的真相），再拼一批 SQL 落库（一批只 fork 一次）。
 * 写库失败只记日志 —— 文件系统才是真相，索引丢了能重建，不能让下载链路跟着炸。
 */
export async function putIndex(id, info) {
  if (!id || !info) return
  try {
    await loadIndex()
    const k = String(id)
    const prev = mem[k] || {}
    const song = info.song || {}
    const al = info.album || {}
    const ars = mapArtists(info.artists)
    const rec = {
      n: song.name || prev.n || '',
      alia: (song.aliases && song.aliases.length ? song.aliases : prev.alia) || [],
      ars: ars.length ? ars : prev.ars || [],
      al: al.id
        ? { i: al.id, n: al.name || '', c: al.cover || '' }
        : prev.al || { i: 0, n: '', c: '' },
      d: song.durationMs || prev.d || 0,
      pub: info.publishTime || prev.pub || 0,
      no: info.trackNo || prev.no || 0,
      cd: info.disc || prev.cd || '',
      pop: info.popularity || prev.pop || 0,
      fee: song.fee || prev.fee || 0
    }
    mem[k] = rec
    await persistTrack(k, rec)
  } catch (e) {
    log('local', '写索引失败 ' + id + '：' + ((e && e.message) || e))
  }
}

/** 把一条索引记录写进 DB（内存行 + 一批 SQL）。不抛。 */
async function persistTrack(k, rec) {
  const tid = int(k)
  if (!tid) return
  const d = dbData()
  const stmts = []
  let taStmts = []
  const alId = int(rec.al && rec.al.i)
  if (d) {
    if (alId) {
      const row = d.album[String(alId)] || { id: alId, name: '', cover: '', pub: 0 }
      row.id = alId
      row.name = (rec.al && rec.al.n) || row.name || ''
      row.cover = (rec.al && rec.al.c) || row.cover || ''
      row.pub = int(rec.pub) || int(row.pub)
      d.album[String(alId)] = row
      stmts.push(upsertSql(T_ALBUM, [
        { name: 'id', v: alId, raw: true },
        { name: 'name', v: row.name },
        { name: 'cover', v: row.cover },
        { name: 'pub', v: int(row.pub), raw: true }
      ], 'id'))
    }
    const ars = rec.ars || []
    for (let i = 0; i < ars.length; i++) {
      const aid = int(ars[i] && ars[i].i)
      if (!aid) continue
      const row = d.artist[String(aid)] || { id: aid, name: '', avatar: '', av_at: 0 }
      row.id = aid
      row.name = (ars[i] && ars[i].n) || row.name || ''
      d.artist[String(aid)] = row
      // 只写 name 列：头像/头像时间由 artistmeta.js 管，别互相擦掉
      stmts.push(upsertSql(T_ARTIST, [
        { name: 'id', v: aid, raw: true },
        { name: 'name', v: row.name }
      ], 'id'))
    }
    const trow = d.track[k] || { id: tid, dl_origin: 0, added_at: 0 }
    trow.id = tid
    trow.name = rec.n || ''
    trow.alias = JSON.stringify(rec.alia || [])
    trow.album_id = alId
    trow.duration = int(rec.d)
    trow.pub = int(rec.pub)
    trow.track_no = int(rec.no)
    trow.disc = rec.cd || ''
    trow.pop = int(rec.pop)
    trow.fee = int(rec.fee)
    trow.cover = (rec.al && rec.al.c) || ''
    if (!trow.added_at) trow.added_at = Date.now()
    if (trow.dl_origin === undefined) trow.dl_origin = 0
    d.track[k] = trow
    // 注意：dl_origin 不在这一批里 —— 归属由 dlorigin.js 独立写，这里不能覆盖它
    stmts.push(upsertSql(T_TRACK, [
      { name: 'id', v: tid, raw: true },
      { name: 'name', v: trow.name },
      { name: 'alias', v: trow.alias },
      { name: 'album_id', v: int(trow.album_id), raw: true },
      { name: 'duration', v: int(trow.duration), raw: true },
      { name: 'pub', v: int(trow.pub), raw: true },
      { name: 'track_no', v: int(trow.track_no), raw: true },
      { name: 'disc', v: trow.disc },
      { name: 'pop', v: int(trow.pop), raw: true },
      { name: 'fee', v: int(trow.fee), raw: true },
      { name: 'cover', v: trow.cover },
      { name: 'added_at', v: int(trow.added_at), raw: true }
    ], 'id'))
    // 多对多：先删该曲目的旧行再插新行（顺序即 ord）
    const keep = []
    const all = d.track_artist || []
    for (let i = 0; i < all.length; i++) {
      if (int(all[i].track_id) !== tid) keep.push(all[i])
    }
    const rows = []
    for (let i = 0; i < ars.length; i++) {
      const aid = int(ars[i] && ars[i].i)
      if (!aid) continue
      rows.push({ track_id: tid, artist_id: aid, ord: rows.length })
    }
    d.track_artist = keep.concat(rows)
    stmts.push(deleteSql(T_TA, 'track_id = ' + num(tid)))
    // 关系行用多行 INSERT（一行 ~20B，逐条 upsert 要 ~90B）
    const tuples = []
    for (let i = 0; i < rows.length; i++) tuples.push([rows[i].track_id, rows[i].artist_id, rows[i].ord])
    taStmts = replaceRowsSql(T_TA, ['track_id', 'artist_id', 'ord'], tuples)
  } else {
    return // 通道没起来（db.open 失败）：内存投影已是真相，重启后靠文件与网络重建
  }
  await runStmts(stmts)
  await runStmts(taStmts)
}

/** 该专辑是否还有别的曲目引用（删曲目时决定要不要顺手清掉专辑行） */
function albumInUse(d, alId, skipTrackId) {
  const tracks = d.track || {}
  const keys = Object.keys(tracks)
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === skipTrackId) continue
    if (!tracks[keys[i]] || !tracks[keys[i]].name) continue
    if (int(tracks[keys[i]].album_id) === alId) return true
  }
  return false
}

export async function dropIndex(id) {
  try {
    await loadIndex()
    const k = String(id)
    const tid = int(k)
    delete mem[k]
    const d = dbData()
    if (!d || !tid) return
    const row = d.track[k]
    delete d.track[k]
    const keep = []
    const all = d.track_artist || []
    for (let i = 0; i < all.length; i++) {
      if (int(all[i].track_id) !== tid) keep.push(all[i])
    }
    d.track_artist = keep
    const stmts = [
      deleteSql(T_TA, 'track_id = ' + num(tid)),
      deleteSql(T_TRACK, 'id = ' + num(tid))
    ]
    // 旧实现里专辑信息随曲目记录一起消失；这里保留同样的可观察行为
    const alId = row ? int(row.album_id) : 0
    if (alId && !albumInUse(d, alId, k)) {
      delete d.album[String(alId)]
      stmts.push(deleteSql(T_ALBUM, 'id = ' + num(alId)))
    }
    await runStmts(stmts)
  } catch (e) {
    log('local', '删索引失败 ' + id + '：' + ((e && e.message) || e))
  }
}

async function clearIndex() {
  mem = {}
  const d = dbData()
  if (!d) return
  d.track = {}
  d.album = {}
  d.track_artist = []
  // artist 表**不清**：它同时是歌手头像缓存（artistmeta.js），与「清空已下载」无关
  await dbExec(['DELETE FROM ' + T_TA + ';', 'DELETE FROM ' + T_TRACK + ';', 'DELETE FROM ' + T_ALBUM + ';'])
}

/* ---------------- 歌词（每首 downloads/<id>/lyrics.json） ---------------- */

/**
 * 取本地歌词；返回 {l, t, pm, y} 或 null（没有/坏了都算 null；y 是可选 YRC 原文）。
 * 只读 downloads 通道 —— cache 通道的歌不存歌词。
 */
export async function lyricOf(id) {
  if (!id) return null
  try {
    const j = await readLyrics(id, 'download')
    if (!j) return null
    return { l: j.lrc || '', t: j.tlyric || '', pm: j.pureMusic ? 1 : 0, y: j.yrc || '' }
  } catch (e) {
    return null
  }
}

export async function putLyric(id, l, t, pm, y) {
  if (!id) return
  if (!l && !pm) return // 没词又不是纯音乐：没有可存的
  try {
    await writeLyrics(id, 'download', { lrc: l || '', tlyric: t || '', yrc: y || '', pureMusic: pm ? 1 : 0 })
  } catch (e) {
    log('local', '写歌词失败 ' + id + '：' + ((e && e.message) || e))
  }
}

export async function dropLyric(id) {
  try {
    await dropFile(trackLyrics(id, 'download'))
  } catch (e) {}
}

/* ---------------- 清理挂点（随音频文件走） ---------------- */

/** 删单首：索引 + 歌词（download.js 的 deleteCached 挂点） */
export async function dropLocalSong(id) {
  try {
    await dropIndex(id)
  } catch (e) {}
  await dropLyric(id)
}

/** 清空索引（cache.js 的 clearSongs 挂点）。
 *  歌词不必在这里删 —— 它就在 downloads/<id>/ 里面，删下载目录时一起走。 */
export async function clearLocalLibrary() {
  await loadIndex()
  const n = Object.keys(mem || {}).length
  await clearIndex()
  log('local', '本地库已清空（索引 ' + n + ' 首；歌词随下载目录一起删除）')
}

/* ---------------- 下载完成落盘 ---------------- */

/**
 * 下载完成后把详情 + 歌词落盘（离线详情页/歌词的数据源）。
 * 返回 {info: fetchSongInfo 的结果或 null, lyric: bool}
 * —— 调用方（downloads 页 enrich）要拿 info 补行显示，别只给布尔。
 * 任何一步失败只记日志，绝不抛给下载链路。
 */
export async function saveSongExtras(songId) {
  const id = String(songId)
  const out = { info: null, lyric: false }
  let info = null
  try {
    info = await raceTimeout(fetchSongInfo(id), 12000, null)
  } catch (e) {
    info = null
  }
  if (info && info.song && info.song.name) {
    out.info = info
    try {
      await raceTimeout(putIndex(id, info), 8000, null)
    } catch (e) {}
    // 浏览缩略图预热（封面缓存键的形态不变：<id>@<size> → cache/thumbs/<id>_<size>.jpg）。
    // 四把键各有用处：songId@60 列表行；songId@200 播放页与首页当前播放卡；
    // al<ID>@60 歌手页专辑卡；al<ID>@200 歌曲/专辑详情页大封面。
    if (info.album && info.album.cover) {
      try {
        const noop = function () {}
        const u = info.album.cover
        enqueueCovers([{ id: id, cover: u }], noop, 60)
        enqueueCovers([{ id: id, cover: u }], noop, 200)
        if (info.album.id) {
          enqueueCovers([{ id: 'al' + info.album.id, cover: u }], noop, 60)
          enqueueCovers([{ id: 'al' + info.album.id, cover: u }], noop, 200)
        }
      } catch (e) {}
    }
  }
  let lyr = null
  try {
    lyr = await raceTimeout(fetchLyric(id), 12000, null)
  } catch (e) {
    lyr = null
  }
  if (lyr && (lyr.lrc || lyr.pureMusic)) {
    try {
      await raceTimeout(putLyric(id, lyr.lrc || '', lyr.tlyric || '', lyr.pureMusic ? 1 : 0, lyr.yrc || ''), 8000, null)
      out.lyric = true
    } catch (e) {}
  }
  // 歌手头像旁路预热：只入队、不 await，不拖慢下载完成/不影响下载结果。
  // 走轻量歌手接口，只取列表尺寸 60（详情 200 由歌手页在线时按需下载）。
  try {
    enqueueArtistPortraits((out.info && out.info.artists) || [])
  } catch (e) {}
  log('local', '落盘 ' + id + ' 详情=' + (out.info ? '有' : '无') + ' 歌词=' + (out.lyric ? '有' : '无'))
  return out
}

/* ---------------- 离线视图派生 ---------------- */

/** 索引记录 → 播放器/列表行用的 Song（对齐 ncm/api.js 的 normalizeSong，多带 trackNo/disc 供排序） */
function toSong(id, rec) {
  const names = []
  const ars = rec.ars || []
  for (let i = 0; i < ars.length; i++) {
    if (ars[i] && ars[i].n) names.push(ars[i].n)
  }
  const nid = Number(id)
  return {
    id: isNaN(nid) ? id : nid,
    name: rec.n || '',
    artist: names.join(' / ') || '未知歌手',
    album: (rec.al && rec.al.n) || '',
    albumId: (rec.al && rec.al.i) || 0,
    cover: (rec.al && rec.al.c) || '',
    durationMs: rec.d || 0,
    fee: rec.fee || 0,
    aliases: rec.alia || [],
    trackNo: rec.no || 0,
    disc: rec.cd || ''
  }
}

function discNum(s) {
  const n = parseInt(s && s.disc, 10)
  return isNaN(n) ? 1 : n
}

/** 网易云时间戳秒/毫秒混用（同 format.js 的 fmtDate）：统一成毫秒 */
function pubMs(v) {
  let n = Number(v) || 0
  if (n && n < 100000000000) n *= 1000
  return n
}

/** 碟号 → 音轨号 排序（专辑内曲目序） */
function byTrack(a, b) {
  if (discNum(a) !== discNum(b)) return discNum(a) - discNum(b)
  return (a.trackNo || 0) - (b.trackNo || 0)
}

/** songinfo 页兜底：对齐 fetchSongInfo 的返回形状；索引里没有返回 null */
export async function localSongInfo(id) {
  await loadIndex()
  const rec = indexOf(id)
  if (!rec) return null
  const artists = []
  const ars = rec.ars || []
  for (let i = 0; i < ars.length; i++) {
    artists.push({ id: ars[i].i, name: ars[i].n || '' })
  }
  return {
    song: { name: rec.n || '', durationMs: rec.d || 0, fee: rec.fee || 0, aliases: rec.alia || [] },
    artists: artists,
    album: { id: (rec.al && rec.al.i) || 0, name: (rec.al && rec.al.n) || '', cover: (rec.al && rec.al.c) || '' },
    publishTime: rec.pub || 0,
    trackNo: rec.no || 0,
    disc: rec.cd || '',
    popularity: rec.pop || 0
  }
}

/**
 * artist 页兜底（离线视图）：**只**给本地索引里该歌手的曲目与专辑。
 * 返回 {name, songs, albums, cover, coverAlbumId}；该歌手一首歌都没有时 songs 为空
 * （调用方据此判「没有本地视图」）。
 * cover = 与 localArtistList 相同的代表专辑封面（发行时间最新且有封面）。
 */
export async function localArtistView(artistId) {
  await loadIndex()
  const aid = Number(artistId)
  const songs = []
  const albumMap = {}
  let name = ''
  const keys = Object.keys(mem || {})
  for (let i = 0; i < keys.length; i++) {
    const rec = mem[keys[i]]
    const ars = rec.ars || []
    let hit = false
    for (let k = 0; k < ars.length; k++) {
      if (Number(ars[k].i) === aid) {
        hit = true
        if (!name) name = ars[k].n || ''
        break
      }
    }
    if (!hit) continue
    songs.push(toSong(keys[i], rec))
    if (rec.al && rec.al.i) {
      const k = String(rec.al.i)
      if (!albumMap[k]) {
        albumMap[k] = { id: rec.al.i, name: rec.al.n || '', cover: rec.al.c || '', publishTime: 0, size: 0 }
      }
      // 同一专辑里第一首可能没有封面/名字：后续曲目补齐，别让代表专辑因此选错
      if (!albumMap[k].cover && rec.al.c) albumMap[k].cover = rec.al.c
      if (!albumMap[k].name && rec.al.n) albumMap[k].name = rec.al.n
      albumMap[k].size++
      if (pubMs(rec.pub) > albumMap[k].publishTime) albumMap[k].publishTime = pubMs(rec.pub)
    }
  }
  // 曲目按「专辑 → 碟 → 音轨号」排（同一专辑的歌挨在一起且有序）；专辑按发行时间新→旧
  songs.sort(function (a, b) {
    if (a.albumId !== b.albumId) return a.albumId - b.albumId
    return byTrack(a, b)
  })
  const albums = []
  const ak = Object.keys(albumMap)
  for (let i = 0; i < ak.length; i++) albums.push(albumMap[ak[i]])
  albums.sort(function (a, b) {
    return (b.publishTime || 0) - (a.publishTime || 0)
  })
  /* 代表专辑：列表页与详情页共用同一张兜底封面（发行时间最新且有封面） */
  let cover = ''
  let coverAlbumId = 0
  for (let i = 0; i < albums.length; i++) {
    if (albums[i].cover) {
      cover = albums[i].cover
      coverAlbumId = Number(albums[i].id) || 0
      break
    }
  }
  return { name: name, songs: songs, albums: albums, cover: cover, coverAlbumId: coverAlbumId }
}

/**
 * album 页兜底（离线视图）：**只**给本地索引里该专辑的曲目（按 碟/音轨号 排序）。
 * 返回 {album, artists, songs}；一首都没有返回 null。
 */
export async function localAlbumView(albumId) {
  await loadIndex()
  const aid = Number(albumId)
  const songs = []
  const artists = []
  const seen = {}
  let alRec = null
  let pub = 0
  const keys = Object.keys(mem || {})
  for (let i = 0; i < keys.length; i++) {
    const rec = mem[keys[i]]
    if (!rec.al || Number(rec.al.i) !== aid) continue
    songs.push(toSong(keys[i], rec))
    if (!alRec) alRec = rec
    if (pubMs(rec.pub) > pub) pub = pubMs(rec.pub)
    const ars = rec.ars || []
    for (let k = 0; k < ars.length; k++) {
      const key = String(ars[k].i)
      if (seen[key]) continue
      seen[key] = 1
      artists.push({ id: ars[k].i, name: ars[k].n || '' })
    }
  }
  if (!songs.length || !alRec) return null
  songs.sort(byTrack)
  return {
    album: {
      id: aid,
      name: alRec.al.n || '',
      cover: alRec.al.c || '',
      publishTime: pub,
      size: songs.length,
      company: '',
      description: ''
    },
    artists: artists,
    songs: songs
  }
}

/* ---------------- 本地下载的聚合视图（歌手 / 专辑） ---------------- */

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
 * 本地索引里的全部歌手（本地下载-歌手页）。
 * 返回 [{id, name, count, cover, albumId}]：
 *   - count = 该歌手在当前本地索引里出现的曲目数（一首多歌手时各计一次）
 *   - cover / albumId = 该歌手**发行时间最新的、有封面的本地专辑**（离线兜底图的唯一来源；
 *     列表与歌手详情本地视图都用它，避免两处各挑一张封面）
 * 按名称升序。
 */
export async function localArtistList() {
  await loadIndex()
  const map = {}
  const order = []
  const keys = Object.keys(mem || {})
  for (let i = 0; i < keys.length; i++) {
    const rec = mem[keys[i]]
    const ars = rec.ars || []
    for (let k = 0; k < ars.length; k++) {
      const a = ars[k]
      if (!a || !a.i) continue
      const id = String(a.i)
      if (!map[id]) {
        map[id] = { id: Number(a.i) || a.i, name: a.n || '', count: 0, cover: '', albumId: 0, albumPub: 0 }
        order.push(id)
      }
      const item = map[id]
      item.count++
      if (rec.al && rec.al.c) {
        const pub = pubMs(rec.pub)
        if (!item.cover || pub > item.albumPub) {
          item.cover = rec.al.c
          item.albumId = Number(rec.al.i) || 0
          item.albumPub = pub
        }
      }
      if (!item.name && a.n) item.name = a.n
    }
  }
  const out = []
  for (let i = 0; i < order.length; i++) {
    const item = map[order[i]]
    out.push({
      id: item.id,
      name: item.name,
      count: item.count,
      cover: item.cover,
      albumId: item.albumId
    })
  }
  out.sort(function (a, b) {
    return cmpName(a.name, b.name)
  })
  return out
}

/**
 * 本地索引里的全部专辑（本地下载-专辑页）。
 * 返回 [{id, name, artist, count, cover, publishTime, year}]：
 *   - artist = 专辑内曲目的歌手串（对齐曲目行）
 *   - year = publishTime 的年份（无发行时间给 0）
 * 默认按发行时间新→旧、再按名称；页面可再排序。
 */
export async function localAlbumList() {
  await loadIndex()
  const map = {}
  const order = []
  const keys = Object.keys(mem || {})
  for (let i = 0; i < keys.length; i++) {
    const rec = mem[keys[i]]
    const al = rec.al || {}
    if (!al.i) continue
    const id = String(al.i)
    if (!map[id]) {
      map[id] = {
        id: Number(al.i) || al.i,
        name: al.n || '',
        artist: '',
        count: 0,
        cover: al.c || '',
        publishTime: 0
      }
      order.push(id)
    }
    const item = map[id]
    item.count++
    if (!item.cover && al.c) item.cover = al.c
    if (!item.name && al.n) item.name = al.n
    if (pubMs(rec.pub) > item.publishTime) item.publishTime = pubMs(rec.pub)
    if (!item.artist) {
      const names = []
      const ars = rec.ars || []
      for (let k = 0; k < ars.length; k++) {
        if (ars[k] && ars[k].n) names.push(ars[k].n)
      }
      item.artist = names.join(' / ') || '未知歌手'
    }
  }
  const out = []
  for (let i = 0; i < order.length; i++) {
    const it = map[order[i]]
    it.year = it.publishTime ? new Date(it.publishTime).getFullYear() : 0
    out.push(it)
  }
  out.sort(function (a, b) {
    if ((b.publishTime || 0) !== (a.publishTime || 0)) return (b.publishTime || 0) - (a.publishTime || 0)
    return cmpName(a.name, b.name)
  })
  return out
}

/** 本地索引规模：{songs, artists, albums}（本地下载总览卡用） */
export async function localStats() {
  await loadIndex()
  const songs = Object.keys(mem || {}).length
  const artists = {}
  const albums = {}
  const keys = Object.keys(mem || {})
  for (let i = 0; i < keys.length; i++) {
    const rec = mem[keys[i]]
    const ars = rec.ars || []
    for (let k = 0; k < ars.length; k++) {
      if (ars[k] && ars[k].i) artists[String(ars[k].i)] = 1
    }
    if (rec.al && rec.al.i) albums[String(rec.al.i)] = 1
  }
  return { songs: songs, artists: Object.keys(artists).length, albums: Object.keys(albums).length }
}
