/**
 * 本地音乐库：已下载歌曲的**完整元数据索引**与**歌词库**
 *
 * 为什么有它：下载元数据表（cache.js 的 cache_meta）只记「歌名/歌手字符串」，
 * 没有歌手/专辑 id，撑不起离线时的「歌曲详情 → 歌手详情 → 专辑详情」跳转链；
 * 歌词更是完全没落盘（断网即无词）。本模块在用户下载完成时把 v3 详情与歌词落盘：
 *
 *   - 索引：文件 `$dataDir/store/local_index.json`，songId →
 *     { n, alia:[], ars:[{i,n}], al:{i,n,c}, d, pub, no, cd, pop, fee }
 *     （整表读写：每条约 300B；326 首 = 62KB）
 *   - 歌词：**每首一个文件** `$dataDir/lrc/<id>.json` → {l, t, pm}
 *     （均值 4.8KB/首；storage 是单文件 KV、写一次重写整库，所以歌词不进它 —— 见 utils/filestore.js）
 *
 * 覆盖时机：
 *   - 用户下载完成（download.js 的 downloadOne 挂点，只挂 download 通道）
 *   - 本功能之前的老下载：downloads 页 enrich 在线时逐首 backfill
 *   - 播放在线下载曲、网络歌词到手而库里还没有时（lyric.js 的自愈落盘）
 * 清理随文件走：deleteCached → dropLocalSong；clearSongs → clearLocalLibrary。
 * 播放缓存（cache/）的歌**不进**这里 —— 它们会被 LRU 滚掉，留下就是孤儿数据。
 */
import { loadTable, saveTable, dropTable, writeJsonAt, lrcPath } from '../filestore.js'
import { readTextFile, removePath, removeTree } from '../fsutil.js'
import { lrcDir } from '../paths.js'
import { fetchSongInfo, fetchLyric } from '../ncm/api.js'
import { enqueueCovers } from '../cover.js'
import { enqueueArtistPortraits } from '../artistavatar.js'
import { log } from '../log.js'
import { raceTimeout } from '../util.js'

const INDEX_FILE = 'local_index'

/* ---------------- 索引（整表） ---------------- */

let mem = null
let loading = null

export async function loadIndex() {
  if (mem) return mem
  if (loading) return loading
  loading = (async function () {
    let obj = {}
    try {
      obj = (await loadTable(INDEX_FILE)) || {}
    } catch (e) {
      obj = {}
    }
    mem = obj
    loading = null
    return obj
  })()
  return loading
}

async function saveIndex() {
  if (!mem) return
  try {
    await saveTable(INDEX_FILE, mem)
  } catch (e) {}
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
 */
export async function putIndex(id, info) {
  if (!id || !info) return
  await loadIndex()
  const k = String(id)
  const prev = mem[k] || {}
  const song = info.song || {}
  const al = info.album || {}
  const ars = mapArtists(info.artists)
  mem[k] = {
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
  await saveIndex()
}

export async function dropIndex(id) {
  await loadIndex()
  if (mem[String(id)]) {
    delete mem[String(id)]
    await saveIndex()
  }
}

async function clearIndex() {
  mem = {}
  try {
    await dropTable(INDEX_FILE)
  } catch (e) {}
}

/* ---------------- 歌词（每首一个文件 `lrc/<id>.json`） ---------------- */

/** 取本地歌词；返回 {l, t, pm} 或 null（没有/坏了都算 null） */
export async function lyricOf(id) {
  if (!id) return null
  const raw = await readTextFile(lrcPath(id))
  if (!raw) return null
  try {
    const j = JSON.parse(raw)
    if (!j || (!j.l && !j.pm)) return null
    return { l: j.l || '', t: j.t || '', pm: j.pm ? 1 : 0 }
  } catch (e) {
    return null
  }
}

export async function putLyric(id, l, t, pm) {
  if (!id) return
  if (!l && !pm) return // 没词又不是纯音乐：没有可存的
  try {
    await writeJsonAt(lrcPath(id), { l: l || '', t: t || '', pm: pm ? 1 : 0 })
  } catch (e) {}
}

export async function dropLyric(id) {
  try {
    await removePath(lrcPath(id))
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

/** 清空：歌词目录一条 rm -rf，索引表删文件（cache.js 的 clearSongs 挂点） */
export async function clearLocalLibrary() {
  await loadIndex()
  const n = Object.keys(mem || {}).length
  await removeTree(lrcDir())
  await clearIndex()
  log('local', '本地库已清空（歌词 ' + n + ' 首，索引表已删）')
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
    // 封面预热四把键（各页面各用各的键，少一把离线就有一块没图）：
    //   songId@60  列表行（SongRow）；songId@200 播放页封面 + 首页「当前播放」卡
    //   al<ID>@60  歌手页专辑卡（PlaylistCard）；al<ID>@200 歌曲/专辑详情页大封面
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
      await raceTimeout(putLyric(id, lyr.lrc || '', lyr.tlyric || '', lyr.pureMusic ? 1 : 0), 8000, null)
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
