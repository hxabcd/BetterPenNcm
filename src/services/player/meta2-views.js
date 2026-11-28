import { cmpText } from '../../core/infra/format.js'
import { loadIndex, indexOf, songIdOf } from './meta2-index.js'

// 索引记录 → 播放器/列表行用的 Song（对齐 ncm/api.js 的 normalizeSong，多带 trackNo/disc 供排序）
function toSong(id, rec) {
  const names = []
  const ars = rec.ars || []
  for (let i = 0; i < ars.length; i++) {
    if (ars[i] && ars[i].n) names.push(ars[i].n)
  }
  return {
    id: songIdOf(id),
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

// 网易云时间戳秒/毫秒混用（同 format.js 的 fmtDate）：统一成毫秒
function pubMs(v) {
  let n = Number(v) || 0
  if (n && n < 100000000000) n *= 1000
  return n
}

// 碟号 → 音轨号 排序（专辑内曲目序）
function byTrack(a, b) {
  if (discNum(a) !== discNum(b)) return discNum(a) - discNum(b)
  return (a.trackNo || 0) - (b.trackNo || 0)
}

// songinfo 页兜底：对齐 fetchSongInfo 的返回形状；索引里没有返回 null。
// ⚠ `song.id` 必须给：页面用它判「曲目已就绪」（`song()` computed → 左栏三颗上下文键的 disabled）。
// 少了它，离线/网络失败兜底进本地视图时整排键被置灰点不动，而云端路径的 id 来自 normalizeSong
// —— 这是本函数唯一容易漏、又只在本地方向暴露的字段。归一方式与 toSong() 一致：数字优先，非数字原样保留。
export async function localSongInfo(id) {
  await loadIndex()
  const rec = indexOf(id)
  if (!rec) return null
  const artists = []
  const ars = rec.ars || []
  for (let i = 0; i < ars.length; i++) {
    artists.push({ id: ars[i].i, name: ars[i].n || '' })
  }
  const nid = Number(id)
  return {
    song: {
      id: isNaN(nid) ? id : nid,
      name: rec.n || '',
      durationMs: rec.d || 0,
      fee: rec.fee || 0,
      aliases: rec.alia || []
    },
    artists: artists,
    album: { id: (rec.al && rec.al.i) || 0, name: (rec.al && rec.al.n) || '', cover: (rec.al && rec.al.c) || '' },
    publishTime: rec.pub || 0,
    trackNo: rec.no || 0,
    disc: rec.cd || '',
    popularity: rec.pop || 0
  }
}

// artist 页兜底（离线视图）：**只**给本地索引里该歌手的曲目与专辑。
// 返回 {name, songs, albums, cover, coverAlbumId}；该歌手一首歌都没有时 songs 为空
// （调用方据此判「没有本地视图」）。cover = 与 localArtistList 相同的代表专辑封面
export async function localArtistView(artistId) {
  const mem = await loadIndex()
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

  // 代表专辑：列表页与详情页共用同一张兜底封面（发行时间最新且有封面）
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

// album 页兜底（离线视图）：**只**给本地索引里该专辑的曲目（按 碟/音轨号 排序）。
// 一首都没有返回 null
export async function localAlbumView(albumId) {
  const mem = await loadIndex()
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

// 本地索引里的全部歌手（本地下载-歌手页）。返回 [{id, name, count, cover, albumId}]：
//   - count = 该歌手在本地索引里出现的曲目数（一首多歌手时各计一次）
//   - cover / albumId = 该歌手**发行时间最新的、有封面的本地专辑**（离线兜底图的唯一来源；
//     列表与歌手详情本地视图都用它，避免两处各挑一张封面）
// 按名称升序
export async function localArtistList() {
  const mem = await loadIndex()
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
    return cmpText(a.name, b.name)
  })
  return out
}

// 本地索引里的全部专辑（本地下载-专辑页）。返回 [{id, name, artist, count, cover, publishTime, year}]：
//   - artist = 专辑内曲目的歌手串（对齐曲目行）
//   - year = publishTime 的年份（无发行时间给 0）
// 默认按发行时间新→旧、再按名称；页面可再排序
export async function localAlbumList() {
  const mem = await loadIndex()
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
    return cmpText(a.name, b.name)
  })
  return out
}

// 本地索引规模：{songs, artists, albums}（本地下载总览卡用）
export async function localStats() {
  const mem = await loadIndex()
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
