/**
 * 网易云 API 封装：搜索/直链/歌曲详情走明文 /api/；歌单详情、曲目批量详情、登录与写操作走 weapi（weapiPost 把 /api/ 换成 /weapi/）。
 */
import { request } from '../net/request.js'

const BASE = 'https://music.163.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  Accept: 'application/json, text/plain, */*'
}

function pickArtist(song) {
  const arr = song.artists || song.ar || []
  const names = []
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] && arr[i].name) names.push(arr[i].name)
  }
  return names.join(' / ') || '未知歌手'
}

/** 图片 URL 统一 https（头像轻量接口会回 http://，封面缓存按 URL 直接下载） */
function picUrl(u) {
  const s = String(u || '')
  if (!s) return ''
  if (s.indexOf('//') === 0) return 'https:' + s
  if (s.indexOf('http://') === 0) return 'https://' + s.slice(7)
  return s
}

/**
 * 别名提取（结构对齐用户 MusicVault 项目的 Track.from_ncm_payload）：
 *   aliases = tns(翻译名) + alia(新接口别名) [+ alias(老接口别名)]
 *   每项再按分隔符拆开、去重
 * 分隔符仅取「/ ; ；」——**逗号和顿号都不行**
 * （别名本身可能含逗号/顿号，会被误拆）
 * 返回字符串数组（保持顺序）
 */
export function pickAliases(raw) {
  const out = []
  const all = (raw.tns || []).concat(raw.alia || []).concat(raw.alias || [])
  for (let i = 0; i < all.length; i++) {
    const s = String(all[i] === undefined || all[i] === null ? '' : all[i]).trim()
    if (!s) continue
    const parts = s.split(/[\/;；]+/)
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j].trim()
      if (p && out.indexOf(p) < 0) out.push(p)
    }
  }
  return out
}

/** 统一曲目结构；兼容搜索（artists/album/duration）与歌单详情（ar/al/dt）两种字段名 */
export function normalizeSong(raw) {
  const album = raw.album || raw.al || {}
  return {
    id: raw.id,
    name: raw.name || '',
    artist: pickArtist(raw),
    album: album.name || '',
    albumId: album.id || 0,
    cover: album.picUrl || '',
    durationMs: raw.duration || raw.dt || 0,
    fee: raw.fee === undefined ? 0 : raw.fee,
    aliases: pickAliases(raw)
  }
}

/**
 * 搜索歌曲；返回 {songs: Song[], total}
 * 就是分类搜索的「单曲」特例 —— 真正的实现在下面的 searchByType，别在这里另拼一遍 URL。
 */
export async function searchSongs(keyword, offset, limit) {
  const r = await searchByType(keyword, 1, offset, limit)
  return { songs: r.items, total: r.total }
}

/* 搜索分类（加）：四个分类都走同一个端点 /api/search/get/web（PC 端 curl 实测），
   只是 result 里的数组名不同。type 值与网易云一致：1 单曲 / 10 专辑 / 100 歌手 / 1000 歌单。
   ⚠ 老端点没有 type=1002（用户）之类的新类型，别照搬新接口文档。 */
export const SEARCH_TYPES = [
  { key: 1, label: '单曲', unit: '首', field: 'songs', count: 'songCount' },
  { key: 100, label: '歌手', unit: '位', field: 'artists', count: 'artistCount' },
  { key: 1000, label: '歌单', unit: '个', field: 'playlists', count: 'playlistCount' },
  { key: 10, label: '专辑', unit: '张', field: 'albums', count: 'albumCount' }
]

function searchMeta(type) {
  for (let i = 0; i < SEARCH_TYPES.length; i++) {
    if (SEARCH_TYPES[i].key === Number(type)) return SEARCH_TYPES[i]
  }
  return SEARCH_TYPES[0]
}

/** 歌手名拼接（专辑/歌单条目里的 artists / creator 字段） */
function joinArtists(arr) {
  const names = []
  const a = arr || []
  for (let i = 0; i < a.length; i++) {
    if (a[i] && a[i].name) names.push(a[i].name)
  }
  return names.join(' / ')
}

function yearOf(ms) {
  if (!ms) return 0
  try {
    return new Date(Number(ms)).getFullYear() || 0
  } catch (e) {
    return 0
  }
}

/**
 * 分类搜索：返回 {type, items, total}
 *   type=1    → items 是 normalizeSong（可直接喂播放器）
 *   其余      → items 是行显示用的轻量结构 {id, kid, name, sub, cover}
 *               （kid = 带前缀的缓存键，避免歌手/专辑/歌单的 id 与歌曲 id 在封面缓存里撞车）
 */
export async function searchByType(keyword, type, offset, limit) {
  const meta = searchMeta(type)
  const url =
    BASE +
    '/api/search/get/web?s=' +
    encodeURIComponent(keyword) +
    '&type=' + meta.key +
    '&offset=' + (offset || 0) +
    '&limit=' + (limit || 30)
  const j = await getJson(url)
  const res = j.result || {}
  const raw = arr(res[meta.field])
  const items = []
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] || {}
    if (meta.key === 1) {
      items.push(normalizeSong(it))
      continue
    }
    if (meta.key === 100) {
      items.push({
        id: it.id,
        /* 头像缓存键与本地下载-歌手/歌手详情共用 arp<id>：同一歌手同一张图，
           避免各页面各存一份、来源不一致 */
        kid: 'arp' + it.id,
        name: it.name || '',
        cover: picUrl(it.picUrl || it.img1v1Url || ''),
        sub: '单曲 ' + (it.musicSize || 0) + ' · 专辑 ' + (it.albumSize || 0)
      })
      continue
    }
    if (meta.key === 10) {
      const y = yearOf(it.publishTime)
      const who = joinArtists(it.artists) || (it.artist && it.artist.name) || ''
      const size = it.size || 0
      items.push({
        id: it.id,
        kid: 'al' + it.id,
        name: it.name || '',
        cover: it.picUrl || it.blurPicUrl || '',
        sub: who + (y ? ' · ' + y : '') + (size ? ' · ' + size + ' 首' : '')
      })
      continue
    }
    // 1000 歌单
    const creator = it.creator || {}
    items.push({
      id: it.id,
      kid: 'pl' + it.id,
      name: it.name || '',
      cover: it.coverImgUrl || '',
      sub: (it.trackCount || 0) + ' 首 · by ' + (creator.nickname || '未知')
    })
  }
  return { type: meta.key, items: items, total: res[meta.count] || items.length, meta: meta }
}

/**
 * 取歌曲直链（v1 接口，按档位 level 请求）
 *
 * `GET /api/song/enhance/player/url/v1?ids=[<id>]&level=<level>&encodeType=flac`
 *
 * 实测契约（PC 端 2026-10-22：匿名免费歌 + 带黑胶 cookie 的 Hi-Res 曲目；替代老接口 `/player/url?br=`）：
 *   - **`level` 和 `encodeType` 都是必需参数**，缺任一个就回 `{"code":400,"msg":"参数错误"}`
 *   - `ids` 必须带方括号，写成 `ids=123` 同样参数错误
 *   - 账号无该档权益时静默降级：匿名请求 lossless/hires 回 `type='mp3'`、`br=320000`
 *   - ⚠ **`data[0].level` 只是档位标签，不可靠**（带 cookie 实测）：请求 `level=hires` 回 `level='lossless'`，
 *     且 24bit（51.8MB / br≈1.8M）与 16bit（32.5MB / br≈0.8M）两种 flac 都标 `lossless`。
 *     判「到底拿到什么」只能看 `type` + `br`（要真判 24bit 得解 flac STREAMINFO，本应用不做）
 *   - **`level=hires`、`level=lossless`、老接口 `br=999000` 三者返回的是同一个文件**（同 size、同 CDN path，
 *     两首样本均验证）—— 换 v1 不额外解锁 Hi-Res，旧接口本来就能拿到
 *   - 受限/VIP 歌匿名请求回 `code=-110`（要登录），url 为空
 * 返回 {url, br, size, code, expi, type, level} 或 null
 * type = 'mp3' | 'flac' —— 缓存/下载扩展名以此为准（别假设请求无损就一定是 flac）
 */
export async function getSongUrl(songId, level) {
  const url =
    BASE +
    '/api/song/enhance/player/url/v1?ids=%5B' +
    songId +
    '%5D&level=' +
    (level || 'exhigh') +
    '&encodeType=flac'
  const r = await request({ url: url, headers: HEADERS })
  if (r.status !== 200) return null
  // 参数不合法时服务端回的是**两段拼接的 JSON**（`{"code":400,…}{"code":400,…}`），
  // JSON.parse 必抛 —— 不能让它冒到调用方（resolveUrl 的降级循环会整轮中断），这里吃掉
  let j = null
  try {
    j = JSON.parse(r.body)
  } catch (e) {
    return null
  }
  const d = j && j.data && j.data[0]
  if (!d || !d.url) return null
  return {
    url: d.url,
    br: d.br,
    size: d.size,
    code: d.code,
    expi: d.expi,
    type: d.type || '',
    level: d.level || '' // 服务端档位**标签**，实测不可靠（见函数头），只进日志
  }
}

/** 歌曲详情（封面等）；返回 Song 或 null */
export async function getSongDetail(songId) {
  const url = BASE + '/api/song/detail?ids=%5B' + songId + '%5D'
  const r = await request({ url: url, headers: HEADERS })
  if (r.status !== 200) return null
  const j = JSON.parse(r.body)
  const s = j.songs && j.songs[0]
  return s ? normalizeSong(s) : null
}

/* ==================== 以下为 新增（均 PC 端 curl 实测通过，免加密） ==================== */

/** 统一 GET + JSON 解析；非 200 或解析失败抛错。timeout 缺省 12s（批量头像等小请求可传更短） */
async function getJson(url, timeout) {
  const r = await request({ url: url, headers: HEADERS, timeout: timeout || 12000 })
  if (r.status !== 200) throw new Error('HTTP ' + r.status)
  return JSON.parse(r.body)
}

function arr(v) {
  return v && v.length ? v : []
}

/**
 * 歌词：原文 + 翻译
 * 实测 GET /api/song/lyric?id=&lv=-1&kv=-1&tv=-1 直接可用（无需 weapi）。
 *   lrc.lyric   原文，标准 LRC
 *   tlyric.lyric 翻译，时间戳与原文逐行对齐
 *   pureMusic   true = 纯音乐（实测克罗地亚狂想曲返回此标记，lrc 只有元信息行）
 * 返回 {lrc, tlyric, pureMusic}
 */
export async function fetchLyric(songId) {
  const url = BASE + '/api/song/lyric?id=' + songId + '&lv=-1&kv=-1&tv=-1'
  const j = await getJson(url)
  return {
    lrc: (j.lrc && j.lrc.lyric) || '',
    tlyric: (j.tlyric && j.tlyric.lyric) || '',
    pureMusic: j.pureMusic === true
  }
}

/**
 * 歌曲详细信息（歌曲详情页用）：一次拿全 normalizeSong 吃不到的元数据。
 * 用 v3（新字段名 ar/al/dt）；老接口 /api/song/detail 没有 pop/publishTime 之外的音轨信息。
 * 实测 c 参数必须是 JSON 字符串（URL 编码后放 query 也能过）。
 */
export async function fetchSongInfo(songId) {
  const c = encodeURIComponent(JSON.stringify([{ id: songId }]))
  const j = await getJson(BASE + '/api/v3/song/detail?c=' + c)
  const s = arr(j.songs)[0]
  if (!s) throw new Error('歌曲不存在')
  const al = s.al || {}
  const artists = []
  const ar = arr(s.ar)
  for (let i = 0; i < ar.length; i++) {
    artists.push({ id: ar[i].id, name: ar[i].name || '' })
  }
  return {
    song: normalizeSong(s),
    artists: artists,
    album: { id: al.id || 0, name: al.name || '', cover: al.picUrl || '' },
    publishTime: s.publishTime || 0,
    trackNo: s.no || 0,
    disc: s.cd || '',
    popularity: s.pop || 0,
    mvId: s.mv || 0
  }
}

/** 歌手信息：artist{name,alias,picUrl,albumSize,musicSize}；followed = 是否已关注（未登录/未下发 → null） */
export async function fetchArtist(artistId) {
  const j = await getJson(BASE + '/api/artist/' + artistId)
  const a = j.artist
  if (!a) throw new Error('歌手不存在')
  return {
    id: a.id,
    name: a.name || '',
    aliases: arr(a.alias),
    cover: picUrl(a.picUrl || ''),
    albumSize: a.albumSize || 0,
    musicSize: a.musicSize || 0,
    briefDesc: a.briefDesc || '',
    // 关注状态：登录态下接口会带 followed；未登录时字段缺失 → null（页面按未关注显示）
    followed: a.followed === true ? true : a.followed === false ? false : null
  }
}

/**
 * 歌手头像（轻量）：GET /api/artist/head/info/get?id=
 * 只取 data.artist.cover，返回结构与 fetchArtist 的 id/name/cover 对齐。
 * 为什么不用 /api/artist/{id}：那个接口会带 50 首 hotSongs，批量预热头像时
 * 为一张图白下几十 KB JSON；实测两者 cover 是同一张图。
 * cover 字段优先，缺了再用 avatar（img1v1 方图）。
 */
export async function fetchArtistHead(artistId) {
  const j = await getJson(BASE + '/api/artist/head/info/get?id=' + artistId, 6000)
  const a = j && j.data && j.data.artist
  if (!a) throw new Error('歌手不存在')
  return {
    id: a.id || Number(artistId) || 0,
    name: a.name || '',
    cover: picUrl(a.cover || a.avatar || '')
  }
}

/**
 * 歌手曲目（热门曲目完整列表用）
 *   GET /api/v1/artist/songs?id=&order=hot|time&limit=&offset=
 * 实测：order=hot 是接口默认（按热度），order=time 按发行时间；服务端排序，
 * 返回 total 是歌手曲目总数（周杰伦 566），分页有效。
 * 注意无 v1 的 /api/artist/songs 返回空数组，别用。
 */
export async function fetchArtistSongs(artistId, order, offset, limit) {
  const url =
    BASE +
    '/api/v1/artist/songs?id=' + artistId +
    '&order=' + (order === 'time' ? 'time' : 'hot') +
    '&limit=' + (limit || 50) +
    '&offset=' + (offset || 0)
  const j = await getJson(url)
  const raw = arr(j.songs)
  const songs = []
  for (let i = 0; i < raw.length; i++) songs.push(normalizeSong(raw[i]))
  return { songs: songs, total: j.total || songs.length, more: j.more === true }
}

/**
 * 歌手专辑（歌手页横向卡片 + 完整列表用）
 *   GET /api/artist/albums/{id}?limit=&offset=   ← id 在路径里
 * 实测分页有效（周杰伦 44 张，limit=30&offset=30 返回 14）。
 */
export async function fetchArtistAlbums(artistId, offset, limit) {
  const url =
    BASE + '/api/artist/albums/' + artistId +
    '?limit=' + (limit || 30) +
    '&offset=' + (offset || 0)
  const j = await getJson(url)
  const raw = arr(j.hotAlbums)
  const albums = []
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]
    let artist = ''
    const ar = arr(a.artists)
    for (let k = 0; k < ar.length; k++) {
      if (k) artist += ' / '
      artist += ar[k].name || ''
    }
    albums.push({
      id: a.id,
      name: a.name || '',
      cover: a.picUrl || '',
      publishTime: a.publishTime || 0,
      size: a.size || 0,
      company: a.company || '',
      artist: artist
    })
  }
  return { albums: albums, more: j.more === true }
}

/**
 * 专辑详情 + 全量曲目
 *   GET /api/v1/album/{id}   ← id 在路径里
 * 实测 album.size 与 songs.length 一致（12/12、25/25），曲目是 v3 新字段格式。
 * 注意无 v1 的 /api/album/{id} 会返回风控验证页，别用。
 */
export async function fetchAlbum(albumId) {
  const j = await getJson(BASE + '/api/v1/album/' + albumId)
  const a = j.album || {}
  const raw = arr(j.songs)
  const songs = []
  for (let i = 0; i < raw.length; i++) songs.push(normalizeSong(raw[i]))
  const creators = []
  const ar = arr(a.artists)
  for (let i = 0; i < ar.length; i++) {
    creators.push({ id: ar[i].id, name: ar[i].name || '' })
  }
  // album.artist 是老接口的单歌手字段，作兜底
  if (!creators.length && a.artist) creators.push({ id: a.artist.id, name: a.artist.name || '' })
  return {
    album: {
      id: a.id,
      name: a.name || '',
      cover: a.picUrl || '',
      publishTime: Number(a.publishTime) || 0,
      company: a.company || '',
      size: Number(a.size) || songs.length,
      description: a.description || ''
    },
    artists: creators,
    songs: songs
  }
}

export const NET_HEADERS = HEADERS
