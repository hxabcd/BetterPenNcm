import { open as dbOpen, data as dbData, exec as dbExec, upsertSql, deleteSql, num } from '../../core/platform/db.js'
import { fetchSongInfo, fetchLyric } from '../ncm/api.js'
import { enqueueCovers, coverKey } from '../../services/cover/cover.js'
import { enqueueArtistPortraits } from '../../services/cover/artistavatar.js'
import { runStmts, replaceRowsSql } from './meta/sqlkit.js'
import { log } from '../../core/infra/log.js'
import { raceTimeout } from '../../core/infra/util.js'
import { readLyrics, writeLyrics, dropLyrics } from '../player/media.js'

const T_TRACK = 'track'
const T_TA = 'track_artist'
const T_ALBUM = 'album'
const T_ARTIST = 'artist'

// 数字列：非有限数一律 0（避免把 NaN 写进 SQL 造成语法错误）
function int(v) {
  const n = Number(v)
  return isFinite(n) ? Math.round(n) : 0
}

// alias 列存的是 JSON 数组文本；坏了按空数组处理
function parseArr(s) {
  if (!s) return []
  try {
    const a = JSON.parse(s)
    return Array.isArray(a) ? a : []
  } catch (e) {
    return []
  }
}

// 曲目 id 归一：数字优先，非数字 id 原样保留（索引键是字符串，行对象要数字 id）。
// 索引记录 → 视图对象只走这一处
export function songIdOf(id) {
  const n = Number(id)
  return isNaN(n) ? id : n
}

let mem = null
let loading = null

// 从 DB 内存态投影出「songId → 记录」表（只读快照，写入后重建）。
// 记录形状沿用旧 JSON 表：{n, alia, ars:[{i,n}], al:{i,n,c}, d, pub, no, cd, pop, fee}
// —— 上层视图函数（toSong / localArtistView / localAlbumList ...）一行都不用改
function buildMem() {
  const d = dbData()
  const out = {}
  if (!d) return out

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
    // name 为空的行是 dlorigin 给老文件补写的，不是「有详情可用」的曲目（见文件头判据）
    if (!row || !row.name) continue 
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

// 同步取一条（须先 await loadIndex()；各导出视图函数内部已保证）
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

// 写入一首歌的索引（与已有条目**合并写**：新快照缺的字段保留旧值）。
// info = fetchSongInfo 的返回（{song, artists, album, publishTime, trackNo, disc, popularity}）。
// 先改内存投影（读的真相），再拼一批 SQL 落库；写库失败只记日志 —— 文件系统才是真相，
// 索引丢了能重建，不能让下载链路跟着炸
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
    // 通道没起来（db.open 失败）：内存投影已是真相，重启后靠文件与网络重建
    return 
  }
  await runStmts(stmts)
  await runStmts(taStmts)
}

// 该专辑是否还有别的曲目引用（删曲目时决定要不要顺手清掉专辑行）
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

// 取本地歌词；返回 {l, t, pm, y} 或 null（没有/坏了都算 null；y 是可选 YRC 原文）。
// 只对 downloads 通道的曲目有歌词 —— cache 通道的歌不存歌词
export async function lyricOf(id) {
  if (!id) return null
  try {
    const j = await readLyrics(id)
    if (!j) return null
    return { l: j.lrc || '', t: j.tlyric || '', pm: j.pureMusic ? 1 : 0, y: j.yrc || '' }
  } catch (e) {
    return null
  }
}

export async function putLyric(id, l, t, pm, y) {
  if (!id) return
  // 没词又不是纯音乐：没有可存的
  if (!l && !pm) return 
  try {
    await writeLyrics(id, { lrc: l || '', tlyric: t || '', yrc: y || '', pureMusic: pm ? 1 : 0 })
  } catch (e) {
    log('local', '写歌词失败 ' + id + '：' + ((e && e.message) || e))
  }
}

export async function dropLyric(id) {
  try {
    await dropLyrics(id)
  } catch (e) {}
}

// 删单首：索引 + 歌词（download.js 的 deleteCached 挂点）
export async function dropLocalSong(id) {
  try {
    await dropIndex(id)
  } catch (e) {}
  await dropLyric(id)
}

// 清空索引（cache.js 的 clearSongs 挂点）。
// 歌词不必在这里删 —— 它就在 downloads/<id>/ 里面，删下载目录时一起走
export async function clearLocalLibrary() {
  await loadIndex()
  const n = Object.keys(mem || {}).length
  await clearIndex()
  log('local', '本地库已清空（索引 ' + n + ' 首；歌词随下载目录一起删除）')
}

// 下载完成后把详情 + 歌词落盘（离线详情页/歌词的数据源）。
// 返回 {info: fetchSongInfo 的结果或 null, lyric: bool} —— 调用方（downloads 页 enrich）要拿 info
// 补行显示，别只给布尔。任何一步失败只记日志，绝不抛给下载链路
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
    // al<ID>@60 歌手页专辑卡；al<ID>@200 歌曲/专辑详情页大封面
    if (info.album && info.album.cover) {
      try {
        const noop = function () {}
        const u = info.album.cover
        enqueueCovers([{ id: id, cover: u }], noop, 60)
        enqueueCovers([{ id: id, cover: u }], noop, 200)
        if (info.album.id) {
          const ak = coverKey('album', info.album.id)
          enqueueCovers([{ id: ak, cover: u }], noop, 60)
          enqueueCovers([{ id: ak, cover: u }], noop, 200)
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
  // 走轻量歌手接口，只取列表尺寸 60（详情 200 由歌手页在线时按需下载）
  try {
    enqueueArtistPortraits((out.info && out.info.artists) || [])
  } catch (e) {}
  log('local', '落盘 ' + id + ' 详情=' + (out.info ? '有' : '无') + ' 歌词=' + (out.lyric ? '有' : '无'))
  return out
}
