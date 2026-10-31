/**
 * 歌词：LRC / YRC 解析、翻译合并、当前行二分查找、按曲目取回并缓存
 *
 * 解析规则移植自社区应用 PenMusic（`player-81152a95.js` 的 parseLrc，实测可用）：
 *   - 时间标签 `[mm:ss]` / `[mm:ss.xx]` / `[mm:ss.xxx]` / `[mm:ss:xx]`，一行可多个
 *   - 元信息 `[ti:]/[ar:]/[al:]/[by:]/[offset:]/[length:]/[re:]/[ve:]`
 *   - `offset`（毫秒，正数 = 时间标签提前）
 *   - 两位小数按百分秒、三位按毫秒
 *
 * 翻译：本项目用网易云官方 `tlyric`（时间戳与原文逐行对齐），**不是** PenMusic 那种
 * 「同一时间戳第二行当翻译」的启发式；合并按时间戳精确匹配、允许 ±50ms 容差。
 */
import { fetchLyric } from '../ncm/api.js'
import { lyricOf, putLyric } from './localmeta.js'
import { dlPath } from './download.js'
import { isOffline } from '../net/status.js'
import { log } from '../log.js'

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const META_TAG = /^\[(ti|ar|al|by|offset|length|re|ve):(.*)\]$/i
const YRC_LINE = /^\[(\d+),(\d+)\]/
const YRC_WORD = /\((\d+),(\d+),0\)/g
const WORD_TRANS_TOL = 1500 // 逐字行与翻译行允许的最大时间差（ms；实测偏差可达 600+）

/**
 * 制作信息行过滤：网易云 LRC 开头会带一串「作词 : xxx / 作曲 : xxx / 录音助理 : xxx」，
 * 都挤在 0~15 秒，在 240px 高的屏上白白占掉好几行，直接丢掉。
 *
 * 两条判据取「或」：
 *   a) 形状像「短字段名 + 冒号 + 值」**且出现在前 15 秒**——网易云的制作信息一律塞在开头，
 *      用时间窗兜住「和声编写 / 录音工程 / 录音助理」这种关键字枚举不全的写法；
 *   b) 字段名命中常见制作角色词。
 * 歌词正文极少含冒号，即使含也不会同时落在前 15 秒，所以不会误伤。
 */
const CREDIT_SHAPE = /^\s*[^:：]{1,12}\s*[:：]\s*\S/
const CREDIT_WORD = /(作词|作曲|编曲|制作|和声|录音|混音|母带|吉他|贝斯|鼓|键盘|配唱|统筹|企划|封面|文案|导演|监制|出品|发行|词|曲|弦乐|演奏|OP|SP|Recorded|Mixed|Mastered|Producer|Composer|Lyricist|Arranger)/i
const CREDIT_WINDOW_MS = 15000

function isCredit(text, firstMs) {
  if (!CREDIT_SHAPE.test(text)) return false
  if (firstMs !== undefined && firstMs <= CREDIT_WINDOW_MS) return true
  const field = String(text).split(/[:：]/)[0]
  return CREDIT_WORD.test(field)
}

function toMs(min, sec, frac) {
  let ms = 0
  if (frac !== undefined && frac !== null && frac !== '') {
    const s = String(frac)
    ms = s.length === 1 ? Number(s) * 100 : s.length === 2 ? Number(s) * 10 : Number(s)
  }
  return (Number(min) * 60 + Number(sec)) * 1000 + ms
}

/** LRC 文本 → [{time(ms), text}]，按时间升序 */
export function parseLrc(raw) {
  const out = []
  if (!raw) return out
  let offset = 0
  const rows = String(raw).split(/\r?\n/)
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i].trim()
    if (!line) continue
    const meta = META_TAG.exec(line)
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') offset = parseInt(meta[2], 10) || 0
      continue
    }
    const re = new RegExp(TIME_TAG.source, 'g')
    const times = []
    let m
    while ((m = re.exec(line)) !== null) times.push(toMs(m[1], m[2], m[3]))
    if (!times.length) continue
    const text = line.replace(new RegExp(TIME_TAG.source, 'g'), '').trim()
    if (!text) continue
    if (isCredit(text, times[0])) continue
    for (let k = 0; k < times.length; k++) out.push({ time: times[k], text: text })
  }
  if (offset) {
    for (let i = 0; i < out.length; i++) out[i].time -= offset
  }
  out.sort(function (a, b) {
    return a.time - b.time
  })
  return out
}

/**
 * YRC 文本 → [{time, end, text, words:[{time, end, text}]}]。
 * 行首是 [开始,时长]，随后每个 (开始,时长,0) 标记管到下一个标记前的文本；
 * 文本里允许出现普通括号，所以不能用「非贪婪匹配到 )」的方式切字。
 * 时间戳是媒体时间（毫秒），倍速只影响面板墙钟推算，不改这里的数据。
 */
export function parseYrc(raw) {
  const out = []
  if (!raw) return out
  let offset = 0
  const rows = String(raw).split(/\r?\n/)
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i].trim()
    if (!line) continue
    const meta = META_TAG.exec(line)
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') offset = parseInt(meta[2], 10) || 0
      continue
    }
    const head = YRC_LINE.exec(line)
    if (!head) continue
    const body = line.slice(head[0].length)
    const marks = []
    const re = new RegExp(YRC_WORD.source, 'g')
    let m
    while ((m = re.exec(body)) !== null) {
      marks.push({ at: m.index, end: re.lastIndex, time: Number(m[1]), dur: Number(m[2]) })
    }
    if (!marks.length) continue
    const words = []
    let text = ''
    for (let k = 0; k < marks.length; k++) {
      const a = marks[k]
      const b = marks[k + 1]
      const value = body.slice(a.end, b ? b.at : body.length)
      if (!value) continue
      const start = a.time
      const end = Math.max(start, start + a.dur)
      words.push({ time: start, end: end, text: value })
      text += value
    }
    if (!text.trim() || !words.length) continue
    if (isCredit(text, Number(head[1]))) continue
    out.push({
      time: Number(head[1]),
      end: Number(head[1]) + Number(head[2]),
      text: text,
      words: words
    })
  }
  if (offset) {
    for (let i = 0; i < out.length; i++) {
      out[i].time -= offset
      out[i].end -= offset
      for (let k = 0; k < out[i].words.length; k++) {
        out[i].words[k].time -= offset
        out[i].words[k].end -= offset
      }
    }
  }
  out.sort(function (a, b) { return a.time - b.time })
  return out
}

/**
 * 把翻译合并进原文行（就地改 lines[i].trans）。
 * 两条都是时间升序，用双指针走一遍，容差 ±50ms。
 * 译文与原文完全相同（中文歌的 tlyric 常这样）则视为没有翻译。
 */
/**
 * tr 里与 t 最接近的一条（时间差绝对值最小），超出 tol 视为没有。返回下标或 -1。
 * 为什么需要它：逐字行（YRC）的时间是**第一个字的开始**，而 LRC / 翻译行是行起始时间，
 * 两者可能差几百毫秒（实测「きゅうくらりん」首句差 664ms），严格等时间戳会整首丢翻译。
 */
function nearestTrans(tr, t, tol) {
  let lo = 0
  let hi = tr.length - 1
  let p = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tr[mid].time <= t) {
      p = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  let best = -1
  let diff = tol + 1
  if (p >= 0 && t - tr[p].time <= tol) {
    best = p
    diff = t - tr[p].time
  }
  const q = p + 1
  if (q < tr.length && tr[q].time - t < diff) best = q
  return best
}

/**
 * 把翻译合并进原文行（就地改 lines[i].trans）。
 *
 * 纯 LRC 行：时间戳本来就对齐（±50ms 内单调推进，O(n)）。
 * 逐字行：改走最近匹配 + 每条翻译只用一次 —— 时间偏差见 nearestTrans 的说明。
 */
export function mergeTranslation(lines, transRaw) {
  const tr = parseLrc(transRaw)
  if (!tr.length || !lines.length) return lines
  let worded = false
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].words && lines[i].words.length) {
      worded = true
      break
    }
  }
  if (worded) {
    const used = {}
    for (let i = 0; i < lines.length; i++) {
      const idx = nearestTrans(tr, lines[i].time, WORD_TRANS_TOL)
      if (idx < 0 || used[idx]) continue
      used[idx] = 1
      const v = tr[idx].text
      if (v && v !== lines[i].text) lines[i].trans = v
    }
    return lines
  }
  let j = 0
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].time
    while (j < tr.length && tr[j].time < t - 50) j++
    if (j < tr.length && Math.abs(tr[j].time - t) <= 50) {
      const v = tr[j].text
      if (v && v !== lines[i].text) lines[i].trans = v
    }
  }
  return lines
}

/** 当前行下标：最大的 time <= ms 的那一行；在首行之前返回 -1。二分查找 */
export function findLyricIndex(lines, ms) {
  const n = lines.length
  if (!n) return -1
  if (ms < lines[0].time) return -1
  let lo = 0
  let hi = n - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= ms) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/* ---- 按曲目取回并缓存 ---- */

const cache = {} // songId -> {lines, pureMusic, empty}

/** 原文 + 翻译 → 结果对象（本地词与网络词共用这一条解析链；有效 YRC 优先，LRC 兜底） */
function buildRes(lrc, tlyric, pureMusic, yrc) {
  let lines = parseYrc(yrc)
  if (!lines.length) lines = parseLrc(lrc)
  mergeTranslation(lines, tlyric)
  let worded = false
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].words && lines[i].words.length) {
      worded = true
      break
    }
  }
  return {
    lines: lines,
    worded: worded,
    pureMusic: !!pureMusic,
    empty: lines.length === 0
  }
}

/**
 * 网络词到手后的自愈落盘：这首歌**已下载**（music/ 目录有文件）而歌词库里还没有
 * （本功能上线前的老下载），顺手存一份 —— downloads 页 enrich 之外的补齐路径。
 */
async function maybePersist(songId, r) {
  try {
    if (await lyricOf(songId)) return
    const hit = await dlPath(songId)
    if (!hit) return
    await putLyric(songId, r.lrc || '', r.tlyric || '', r.pureMusic ? 1 : 0, r.yrc || '')
    log('lyric', 'id=' + songId + ' 已下载，歌词自愈落盘')
  } catch (e) {}
}

/** 读本地歌词库并解析；没有记录返回 null */
async function useLocal(songId) {
  let local = null
  try {
    local = await lyricOf(songId)
  } catch (e) {}
  if (!local) return null
  const res = buildRes(local.l, local.t, local.pm, local.y)
  cache[songId] = res
  log('lyric', 'id=' + songId + ' 本地词 行数=' + res.lines.length)
  return res
}

/**
 * 取某首歌的歌词（带会话内缓存）。
 * 返回 {lines, pureMusic, empty}
 *   pureMusic：接口标记的纯音乐（lrc 只有制作信息行，会被上面过滤光）
 *   empty：既没解析出歌词、也不是纯音乐（接口无数据）
 *
 * 数据源二选一（与详情页同一套语义）：
 *   - 离线（系统 API global.isOnline()，net/status.js）→ 直接读本地歌词库，不等网络超时
 *   - 在线 → 纯网络；请求失败 → 落本地歌词库兜底
 */
export async function loadLyrics(songId) {
  if (!songId) return { lines: [], pureMusic: false, empty: true }
  if (cache[songId]) return cache[songId]

  if (await isOffline()) {
    const res = await useLocal(songId)
    return res || { lines: [], pureMusic: false, empty: true }
  }

  let r = null
  try {
    r = await fetchLyric(songId)
  } catch (e) {
    log('lyric', '取歌词失败 id=' + songId + ': ' + ((e && e.message) || e))
  }
  if (!r) {
    const res = await useLocal(songId)
    return res || { lines: [], pureMusic: false, empty: true }
  }

  const res = buildRes(r.lrc, r.tlyric, r.pureMusic, r.yrc)
  // 只缓存成功结果，失败下次重试
  if (!res.empty || res.pureMusic) {
    cache[songId] = res
    maybePersist(songId, r) // 已下载的老歌顺手落盘（不 await，别拖慢出词）
  }
  log('lyric', 'id=' + songId + ' 行数=' + res.lines.length +
    ' 纯音乐=' + res.pureMusic + ' 译文=' + countTrans(res.lines) + ' 逐字=' + res.worded)
  return res
}

function countTrans(lines) {
  let n = 0
  for (let i = 0; i < lines.length; i++) if (lines[i].trans) n++
  return n
}

/** 清空缓存（换账号/调试用） */
export function clearLyricCache() {
  for (const k in cache) delete cache[k]
}
