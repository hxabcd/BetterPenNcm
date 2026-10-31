/**
 * 歌手资料缓存：只存头像 URL（以及名字、抓取时间），供本地页面离线判断。
 *
 * 为什么单独一张表：本地歌曲索引（store/local_index.json）每条只带歌手 id/名字，
 * 不存歌手头像；而 /api/artist/head/info/get 每次都要发请求。把头像 URL 落盘后，
 * 封面缓存键 arp<id>@<size> 才能在清过封面缓存/重启后按同一来源重新下载，
 * 列表页也不必为已知歌手反复打接口。
 *
 * 结构：{ "<artistId>": { n: 名字, p: 头像 URL, t: 抓取时间 } }
 * - p 非空 = 真头像来源；
 * - p 为空且 t 在负缓存期内 = 查过没有头像，别反复请求（负缓存期见 artistavatar.js）。
 * 落点：文件 `$dataDir/store/artist_meta.json`（整表 ≈19KB；storage 是单文件 KV、写一次重写整库，
 * 所以大表落文件 —— 见 utils/filestore.js）。
 * 写入按批防抖，避免批量预热时逐条写盘。
 */
import { loadTable, saveTable } from './filestore.js'
import { log } from './log.js'

const FILE = 'artist_meta'
const SAVE_DELAY = 500

let mem = null
let loading = null
let saveTimer = 0
let dirty = false

/** 图片 URL 统一 https（网易云部分接口回 http:// 或 //） */
export function normalizePic(u) {
  const s = String(u || '')
  if (!s) return ''
  if (s.indexOf('//') === 0) return 'https:' + s
  if (s.indexOf('http://') === 0) return 'https://' + s.slice(7)
  return s
}

export async function loadArtistMeta() {
  if (mem) return mem
  if (loading) return loading
  loading = (async function () {
    let obj = {}
    try {
      obj = (await loadTable(FILE)) || {}
    } catch (e) {
      obj = {}
    }
    mem = obj
    loading = null
    return obj
  })()
  return loading
}

/** 同步取（须先 await loadArtistMeta）；没有记录返回 null */
export function artistMetaSync(id) {
  return (mem && mem[String(id)]) || null
}

/** 异步取（内部保证已载入） */
export async function artistMeta(id) {
  await loadArtistMeta()
  return artistMetaSync(id)
}

/** 写入/更新一位歌手的资料（cover 为空 = 负缓存）。返回记录。 */
export async function rememberArtist(id, name, cover) {
  const k = String(id)
  if (!k || k === 'undefined' || k === '0') return null
  await loadArtistMeta()
  const prev = mem[k] || {}
  mem[k] = {
    n: name || prev.n || '',
    p: normalizePic(cover),
    t: Date.now()
  }
  scheduleSave()
  return mem[k]
}

function scheduleSave() {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(function () {
    saveTimer = 0
    if (!dirty || !mem) return
    dirty = false
    saveTable(FILE, mem).then(function (ok) {
      if (!ok) log('artistmeta', '歌手资料写入失败')
    }).catch(function () {})
  }, SAVE_DELAY)
}
