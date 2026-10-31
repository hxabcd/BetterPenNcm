/**
 * 每日推荐（需登录）
 *
 * 接口（PC 端 用本项目 cookie 实测，`test_daily_rec.py`（本地留存））：
 *   POST /weapi/v3/discovery/recommend/songs  {}  →  code=200
 *     data.dailySongs[]  ——  32 首左右，**一次给全**（没有分页参数，别去找 offset）
 *     data.orderSongs / recommendReasons / dailyRecommendInfo 暂不用
 *   每条是 **v3 新字段**（ar / al / dt），正是 normalizeSong 兼容的两种格式之一，
 *   所以直接吃 normalizeSong；额外的 `reason` / `recommendReason`（「十万红心」
 *   「昨日上万播放」这类推荐语）本模块顺手挂在曲目上。
 *   ⚠ 候选里 /api/discovery/recommend/songs（旧）与 /api/v1|v2/.../songs 也都返回 200，
 *     但只有 v3 带 `al.picUrl`（封面）与 privilege，取 v3。
 *   ⚠ 未登录时 code=301 —— 调用方（首页/列表页）必须先判 loggedIn()，别拿 301 当空列表。
 *
 * 缓存：**按本地日期**（YYYY-MM-DD）在内存里存一份。每日推荐一天一变，
 * 当天内首页卡片与列表页共用一次请求；跨自然日（或手动 force）才重取。
 * 退出登录必须 invalidateDaily()（缓存不区分账号）。
 */
import { weapiPost } from './weapi.js'
import { normalizeSong } from './api.js'
import { log } from '../log.js'

const PATH = '/api/v3/discovery/recommend/songs'

let cache = null // {day, songs}
let inflight = null

/** 本地日期键（YYYY-MM-DD）。每日推荐按服务端「天」换，本地日期够用（跨天差一两个小时无所谓） */
function today() {
  const d = new Date()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
}

/**
 * 「月/日」短标签（如 `10/7`）—— 首页「每日推荐」卡副行用。
 * 为什么卡片上写日期而不是首数：这张卡的内容**每天换**，日期是「这批推荐是哪天的」
 * 这个信息的正解；首数恒为 30 余首、没有信息量（列表页顶栏才需要写全「10月7日 · 32 首」）。
 */
export function todayMD() {
  const d = new Date()
  return d.getMonth() + 1 + '/' + d.getDate()
}

/** 网络请求：不做缓存，失败抛异常（调用方自己决定显示什么） */
export async function fetchDailyRecommend() {
  const r = await weapiPost(PATH, {}, { tag: 'daily-rec' })
  const j = r.json || {}
  // 301 = 未登录（接口要 cookie）。说人话，别把裸 code 顶到列表页的「加载失败」上
  if (j.code === 301) throw new Error('需要登录')
  if (j.code && j.code !== 200) throw new Error('code=' + j.code)
  const data = j.data || {}
  const raw = data.dailySongs || []
  const songs = []
  for (let i = 0; i < raw.length; i++) {
    const s = normalizeSong(raw[i] || {})
    // 推荐语：v3 里两个字段都可能存在，优先 reason（客户端展示的就是它）
    s.reason = (raw[i] && (raw[i].reason || raw[i].recommendReason)) || ''
    songs.push(s)
  }
  log('ncm', '每日推荐 ' + songs.length + ' 首')
  return songs
}

/**
 * 带当日缓存的每日推荐；force=true 强制重取。
 * **并发的相同请求合并成一个 Promise**（首页 + 列表页可能同时要）。
 */
export async function loadDailyRecommend(force) {
  const day = today()
  if (cache && cache.day === day && !force) return cache.songs
  if (inflight) return inflight
  inflight = fetchDailyRecommend().then(
    function (songs) {
      cache = { day: day, songs: songs }
      inflight = null
      return songs
    },
    function (e) {
      inflight = null
      throw e
    }
  )
  return inflight
}

/** 当日已缓存的推荐（没有 → null）；首页卡片只想知道有几首时用 */
export function cachedDaily() {
  if (cache && cache.day === today()) return cache.songs
  return null
}

/** 作废缓存 —— 退出登录时必须调（缓存不区分账号） */
export function invalidateDaily() {
  cache = null
}
