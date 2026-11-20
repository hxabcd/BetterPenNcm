/**
 * 网易云「歌曲评论」接口（播放页评论子面板的唯一数据来源）
 *
 * 读取（明文 /api/，**匿名可用**；PC 端 2026-10-29 实测）：
 *   GET https://music.163.com/api/v1/resource/comments/R_SO_4_<songId>?limit=20&offset=0
 *   → { hotComments:[], comments:[], total, more, moreHot, code:200 }
 *   单条评论字段：commentId / content / timeStr("2021-04-10") / likedCount / liked /
 *                user:{ nickname, avatarUrl }
 * 实测细节（决定面板行为，别删）：
 *   - 只有 offset=0 才回热门评论；offset>0 时 hotComments 为空（服务端行为，不是错误）
 *   - hotComments 与 comments **会重复**（热门评论同时出现在最新里，实测 15 条热门中有 1 条重复）
 *     → 面板按 commentId 去重，否则热门区与正片区会出现同一张卡
 *   - 歌曲不存在 / 没有评论时仍是 code:200：total=0、两个数组都为空
 *   - 评论内容可能为空串（删评后残留），字段时间戳有 time(ms) 与 timeStr 两份
 *
 * 点赞（weapi，需登录；未登录回 code=301）：
 *   POST /weapi/v1/comment/like  { threadId:'R_SO_4_<songId>', commentId }
 *   ⚠ 这个端点是**切换**语义（再调一次即取消），没有独立的 unlike 接口 ——
 *     所以调用方必须先按本地 liked 状态算好方向再调（likeComment 的 like 参数只表达意图）。
 * 发评论（weapi，需登录；未登录回 code=301）：
 *   POST /weapi/resource/comments/add  { threadId:'R_SO_4_<songId>', content }
 * 两条写接口 PC 端只验证到「路径存在、匿名回 301」（2026-10-29 用便携 Node18 + crypto.js 探测），
 * 登录态下的成功回包字段未验证（设备未连接），失败一律按 code 归类。
 */
import { request } from '../net/request.js'
import { weapiPost } from './weapi.js'
import { NET_HEADERS } from './api.js'

const BASE = 'https://music.163.com'

/** 每批条数（与 CONTRACT §4.4 / 实测接口的 limit=20 一致） */
export const PAGE_LIMIT = 20

/** 未登录时写接口的返回码（点赞 / 发评论共用） */
const NEED_LOGIN = 301

/** 评论线程 id：歌曲评论固定 R_SO_4_ 前缀 */
function threadId(songId) {
  return 'R_SO_4_' + (songId || 0)
}

/**
 * 头像 URL 统一 https：接口回的头像常是 http://（歌曲封面接口也一样）。
 * 平台 <image> 的 http 直链虽然能显示，但统一 https 后与其它图片的写法一致。
 */
function httpsUrl(u) {
  const s = String(u || '')
  if (s.indexOf('//') === 0) return 'https:' + s
  if (s.indexOf('http://') === 0) return 'https://' + s.slice(7)
  return s
}

/** 缺 timeStr 的异常数据用 time(ms) 兜底成 YYYY-MM-DD（本地时区，只用于显示） */
function fmtTime(ms) {
  const n = Number(ms) || 0
  if (!n) return ''
  const d = new Date(n)
  const m = d.getMonth() + 1
  const day = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
}

/** 接口原始评论 → 面板用的扁平结构（字段名见 CONTRACT §4.4） */
function normalizeComment(raw) {
  const c = raw || {}
  const u = c.user || {}
  const count = Number(c.likedCount)
  return {
    id: Number(c.commentId) || 0,
    user: u.nickname || '匿名用户',
    avatar: httpsUrl(u.avatarUrl),
    content: c.content === undefined || c.content === null ? '' : String(c.content),
    timeStr: c.timeStr || fmtTime(c.time),
    likedCount: count > 0 ? count : 0,
    liked: c.liked === true
  }
}

function normalizeList(arr) {
  const out = []
  const a = arr || []
  for (let i = 0; i < a.length; i++) out.push(normalizeComment(a[i]))
  return out
}

/**
 * 读一页评论（匿名可用）
 * @param {Number|String} songId 歌曲 id
 * @param {Number} offset 起始偏移（0 = 第一页，只有它会带热门评论）
 * @param {Number} limit  每批条数（缺省 PAGE_LIMIT）
 * @returns {Promise<{hot:Array, list:Array, total:Number, more:Boolean, moreHot:Boolean}>}
 *   失败（HTTP 非 200 / 响应非 JSON / code 非 200）抛异常，调用方按「加载失败」处理
 */
export async function fetchComments(songId, offset, limit) {
  const url =
    BASE + '/api/v1/resource/comments/' + threadId(songId) +
    '?limit=' + (limit || PAGE_LIMIT) +
    '&offset=' + (offset || 0)
  const r = await request({ url: url, headers: NET_HEADERS, timeout: 12000 })
  if (r.status !== 200) throw new Error('HTTP ' + r.status)
  let j = null
  try {
    j = JSON.parse(r.body)
  } catch (e) {
    throw new Error('评论响应不是 JSON')
  }
  if (!j || j.code !== 200) throw new Error('评论接口 code=' + ((j && j.code) || 0))
  return {
    hot: normalizeList(j.hotComments),
    list: normalizeList(j.comments),
    total: Number(j.total) || 0,
    more: j.more === true,
    moreHot: j.moreHot === true
  }
}

/** 写接口失败统一成调用方需要的形状（网络异常也包进来，调用方只管提示 + 回滚） */
function writeResult(j, e) {
  const code = (j && j.code) || 0
  return {
    ok: false,
    code: code,
    needLogin: code === NEED_LOGIN,
    message: (j && (j.message || j.msg)) || (e && e.message) || ''
  }
}

/**
 * 点赞 / 取消点赞（服务端是切换语义，见文件头）
 * @param {Number|String} songId
 * @param {Number|String} commentId
 * @param {Boolean} like 调用方意图：true=点赞、false=取消（只用于表达方向，不参与请求参数）
 * @returns {Promise<{ok:Boolean, needLogin:Boolean, code:Number, message:String}>}
 */
export async function likeComment(songId, commentId, like) {
  try {
    // 切换接口不带方向参数：调用方必须保证「本地 liked 与服务端一致」再点（面板是乐观更新）
    const r = await weapiPost(
      '/api/v1/comment/like',
      { threadId: threadId(songId), commentId: commentId },
      { tag: 'comment-like' }
    )
    const j = r.json || {}
    if (j.code === 200) return { ok: true, needLogin: false, code: 200, message: '' }
    return writeResult(j)
  } catch (e) {
    return writeResult(null, e)
  }
}

/**
 * 发表评论（内容由调用方从系统输入法拿到；空内容不要调）
 * @returns {Promise<{ok:Boolean, needLogin:Boolean, code:Number, message:String}>}
 */
export async function postComment(songId, content) {
  try {
    const r = await weapiPost(
      '/api/resource/comments/add',
      { threadId: threadId(songId), content: content },
      { tag: 'comment-add' }
    )
    const j = r.json || {}
    if (j.code === 200) return { ok: true, needLogin: false, code: 200, message: '' }
    return writeResult(j)
  } catch (e) {
    return writeResult(null, e)
  }
}
