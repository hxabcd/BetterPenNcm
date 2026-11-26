

/* 播放器单例 —— 多页面间 ES 模块是同一实例，各页直接 import。
 * 出声统一走 playFile：本地文件与在线直链同一条路（平台实测：fileName 给直链时同样认 position 与 rate）。
 * ⚠ 无 pause：暂停 = stop()，续播 = playFile(源, positionMs, rate)。 */
import { cachedPath, resolveUrl, ensureCached, setFileChangedHook, touchPlayCache } from './download.js'
import { setCacheProtectHook } from './cache.js'
import { currentQuality } from './quality.js'
import { save as saveSession, load as loadSession, clear as clearSession, slimSong, slimQueue, slimShuffle } from './session.js'
import { playFile, stop, bindEvents } from './sound.js'
import { record, enrich } from './history.js'
import { getSongDetail } from '../ncm/api.js'
import { fmtDur } from '../../core/infra/format.js'
import { log } from '../../core/infra/log.js'
import config from '../../core/infra/config.js'

export const MODES = [
  { key: 'list_loop', label: '列表循环' },
  { key: 'list_seq', label: '顺序播放' },
  { key: 'single', label: '单曲循环' },
  { key: 'shuffle', label: '随机播放' }
]

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

function modeInfo(key) {
  for (let i = 0; i < MODES.length; i++) {
    if (MODES[i].key === key) return MODES[i]
  }
  return MODES[0]
}

// 原始队列：随机模式也绝不重排它（打乱的是下面那份临时队列）
let queue = [] 
// 队列来源标记（playList 第三参）：'downloads' = 从「本地下载」页建的队列 —— 删下载曲目时只清理这种队列；
// 随会话快照持久化（session.js 的 src 字段），重启恢复后仍认得
let queueSrc = '' 

// 随机模式的临时队列（queue 的乱序副本，同一批歌曲对象）；非随机模式为 null
let shuf = null 
// 当前曲在**生效队列**里的下标（随机模式指 shuf，其它模式指 queue）
let index = -1 
// 队列代次：换队列就自增；后台补齐起播时记下代次，对不上 = 用户已换队列，这批歌直接丢
let qgen = 0 

let cur = {}
let isPlaying = false
let paused = false
let hint = ''
// 短状态（「缓冲中 42%」「歌曲受限」…）—— 会显示在播放页时间位置，只放短文案
let status = '' 
// '' | 'file' | 'stream'：当前出声的是本地文件还是在线流
let srcMode = '' 
// 当前曲目已确认完整的本地文件（流播途中缓存完成才补上）
let localPath = '' 
// 当前原生任务的 uuid（playFile 返回值）：媒体事件按它过滤，stop/结束即清
let uuid = '' 
// 当前曲直链的内存缓存（单条；TTL 见 URL_TTL_MS）
let streamUrl = null 
let streamUrlJob = null 
let cacheKick = { id: '', at: 0 } 
let endAt = 0 
// 播放代次：playAt 每次 +1，异步流程回到现场前对不上就作废
let gen = 0 
let startedAt = 0
let baseMs = 0
let positionMs = 0
let durationMs = 0
let loading = false
let timer = null
let rate = 1.0
let loopMode = MODES[0].key

// 本地文件被删除/升质替换时的自清：当前曲的 localPath 一旦指向已失效/已被顶替的文件，
// seek/续播/改倍速就会用错文件。钩子在下载 promise resolve **之前**触发，所以各调用方随后写
// localPath 的顺序不受影响；正在播的 fd 不受删文件影响，照常放到段尾
setFileChangedHook(function (id) {

  // 空 id = 整库失效（存储页清空缓存）→ 无论播的是哪首都清
  if (!id || (cur.id && String(cur.id) === String(id))) {
    localPath = ''
    log('player', '本地文件变更，清 localPath id=' + (id || '全部'))
  }
})

// 「缓存上限」LRU 的保护名单：正在播放的那首绝不能被回收掉
// （文件一旦没了，正在播的 fd 虽还在，但 seek/续播/改倍速会立刻失效）。
// 与 setFileChangedHook 同一套「注册钩子」风格，避免 cache.js 反过来 import 播放器
setCacheProtectHook(function () {
  return cur.id ? [String(cur.id)] : []
})

// 播放中位置快照的节流间隔（切歌/暂停/seek/退出这些动作即时存，不受它限制）；
// 队列很大时退回 15 秒：快照几十 KB，别每 5 秒重写一次整份 preferences.json。
// BIGQ=200 首 ≈50KB（history.js 经验值：60KB 级写入可能有可感卡顿）
const SAVE_MS = 5000 
const SAVE_MS_BIGQ = 15000 
const BIGQ = 200 
let lastSaveAt = 0

// URL_TTL_MS：直链内存缓存有效期（平台 expi≈1200s，留一半余量）
// URL_FRESH_MS：只有很新的直链才转交下载层复用（太老的首包会 403）
// KICK_MS：后台补缓存的去重窗口（反复 seek 别反复入队）
// NEAR_END_MS：结束事件判定「临近结尾」的容差（区分自然播完与外部 stop）
// END_DEDUP_MS：播完处理去重窗口（EndChanged 与墙钟判定可能双双触发）
const URL_TTL_MS = 600000 
const URL_FRESH_MS = 120000 
const KICK_MS = 60000 
const NEAR_END_MS = 3000 
const END_DEDUP_MS = 1500 

/* 媒体事件：SoundPlayer 是全系统单例 —— 事件全服务广播（别的应用/服务在播什么也会收到），
 * 必须按 playFile 返回的 uuid 过滤，再叠加「正在播 && 非暂停」守卫。
 * 回调形参已实证的是 position 的 (uuid, ms)；End/Duration 的形状未实证 →
 * pickUuid 容忍式解析 + 每种事件首次打一条带实参的形状日志。
 * ⚠ 事件 20~25 条/秒：回调里禁止打日志（log 每条一次 HTTP POST），也不要 emit
 *   （显示仍由 500ms tick 输出，这里只重锚墙钟）。 */
const shapeSeen = {} 

function pickUuid(args) {
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === 'string' && /^[0-9a-f]{8,}$/.test(args[i])) return args[i]
  }
  return ''
}

function lastNum(args) {
  for (let i = args.length - 1; i >= 0; i--) {
    const n = Number(args[i])
    if (isFinite(n)) return n
  }
  return NaN
}

function firstShape(name, args) {
  if (shapeSeen[name]) return
  shapeSeen[name] = 1
  let s = ''
  for (let i = 0; i < args.length; i++) {
    s += (i ? ', ' : '') + typeof args[i] + ':' + String(args[i]).slice(0, 40)
  }
  log('player', '事件形状 ' + name + ' [' + s + ']')
}

// 位置事件：只重锚墙钟（显示由 tick 输出）；首个事件顺带清「缓冲中...」（≈ 真的出声了）
function onPos() {
  const args = arguments
  firstShape('position', args)
  const u = pickUuid(args)
  const ms = lastNum(args)
  if (!u || String(u) !== String(uuid)) return
  if (!isPlaying || paused) return
  if (!isFinite(ms) || ms < 0) return
  positionMs = ms
  baseMs = ms
  startedAt = Date.now()
  if (status === '缓冲中...') status = ''
}

function onDur() {
  const args = arguments
  firstShape('duration', args)
  const u = pickUuid(args)
  const v = Math.round(lastNum(args) || 0)
  if (u) {
    if (!uuid || String(u) !== String(uuid)) return
  } else if (!isPlaying || paused) return
  if (!(v > 0)) return

  // 合理性窗：已知时长时只接受 0.5x~2x 内的值（防「剩余时长」类误报把进度条顶满）
  if (durationMs && (v < durationMs * 0.5 || v > durationMs * 2)) {
    log('player', '时长事件舍去 id=' + cur.id + ' v=' + v + '（现 ' + durationMs + '）')
    return
  }
  const changed = Math.abs(v - durationMs) > 500
  durationMs = v
  if (cur.id && cur.durationMs !== v) cur.durationMs = v 
  const al = activeList()
  for (let i = 0; i < al.length; i++) {
    if (al[i] && String(al[i].id) === String(cur.id) && !al[i].durationMs) al[i].durationMs = v
  }
  if (changed) {
    log('player', '时长(事件) id=' + cur.id + ' v=' + v)
    emit()
    persist()
  }
}

// 结束事件：临近结尾 = 自然播完；否则是外部 stop（别的应用/服务抢了单例）→ 中断收尾不连播
function onEnd() {
  const args = arguments
  firstShape('end', args)
  const u = pickUuid(args)
  if (u) {
    if (!uuid || String(u) !== String(uuid)) return
  } else if (!isPlaying || paused) return
  if (!isPlaying || paused) return
  uuid = '' 
  if (!durationMs || positionMs >= durationMs - NEAR_END_MS) {
    requestEnd()
  } else {
    isPlaying = false
    stopTimer()
    hint = '播放中断'
    emit()
    persist() 
    log('player', '播放中断(外部停止): ' + cur.name + ' @' + Math.round(positionMs / 1000) + 's')
  }
}

function onErr() {
  const args = arguments
  firstShape('error', args)
  const u = pickUuid(args)
  if (u) {
    if (!uuid || String(u) !== String(uuid)) return
  }
  if (!isPlaying || paused) return
  uuid = ''
  isPlaying = false
  stopTimer()
  hint = '播放出错'
  emit()
  persist()
  log('player', '播放出错(事件): ' + cur.name + ' err=' + String(args[args.length - 1]).slice(0, 60))
}

// 进度事件：语义未探明 —— 只留形状日志，不参与逻辑
function onProg() {
  firstShape('progress', arguments)
}

function requestEnd() {
  const now = Date.now()
  if (now - endAt < END_DEDUP_MS) return
  endAt = now
  isPlaying = false
  stopTimer()
  log('player', '播放结束: ' + cur.name)
  handleEnded()
}

// 事件登记（同步；真正的 .on 在 sound.js 实例创建后自动补挂）
bindEvents({
  mediaPlayerPositionChanged: onPos,
  mediaPlayerDurationChanged: onDur,
  mediaPlayerProgressChanged: onProg,
  mediaPlayerEndChanged: onEnd,
  mediaPlayerEndWithErrorChanged: onErr
})

const subs = []

function snapshot() {
  const mi = modeInfo(loopMode)
  return {

    // **生效队列**（随机模式 = 打乱后的临时队列）：index 与它配套，队列页显示/点行跳播都按它来
    queue: activeList(),
    queueSrc: queueSrc,
    index: index,
    cur: cur,
    isPlaying: isPlaying,
    paused: paused,
    hint: hint,
    status: status,
    positionMs: positionMs,
    durationMs: durationMs,
    loading: loading,
    srcMode: srcMode,
    cached: !!localPath,
    rate: rate,
    loopMode: loopMode,
    modeLabel: mi.label,
    hasTrack: !!cur.id
  }
}

function emit() {
  const s = snapshot()
  for (let i = 0; i < subs.length; i++) {
    try {
      subs[i](s)
    } catch (e) {}
  }
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

// 随机播放用「把原始队列整体打乱成临时队列」而非每首随机挑下一首：一轮之内每首恰好放一次，
// 走到队尾（一轮放完）再重洗一轮、仍以当前曲为锚点；原始队列不动，切回其它模式按 id 重定位 index 即恢复原顺序
function activeList() {
  return loopMode === 'shuffle' && shuf && shuf.length ? shuf : queue
}

function inShuffle() {
  return !!(loopMode === 'shuffle' && shuf && shuf.length)
}

function buildShuffle(anchor) {
  const anchorId = anchor && anchor.id
  const rest = []
  let head = null
  for (let i = 0; i < queue.length; i++) {

    if (!head && anchorId && queue[i].id === anchorId) {
      head = queue[i]
      continue
    }
    rest.push(queue[i])
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = rest[i]
    rest[i] = rest[j]
    rest[j] = t
  }
  shuf = head ? [head].concat(rest) : rest
  return !!head
}

function shuffleNext(from) {
  const n = shuf ? shuf.length : 0
  if (n === 0) return -1
  if (n === 1) return 0 
  if (from + 1 < n) return from + 1
  const anchored = buildShuffle(cur.id ? cur : null)
  return anchored ? 1 : 0 
}

function shufflePrev(from) {
  const n = shuf ? shuf.length : 0
  if (n === 0) return -1
  if (n === 1) return 0
  return from - 1 >= 0 ? from - 1 : n - 1
}

function rebuildShuffle(ids) {
  const out = []
  if (!ids || !ids.length) return out
  for (let i = 0; i < ids.length; i++) {
    for (let k = 0; k < queue.length; k++) {
      if (queue[k].id === ids[i]) {
        out.push(queue[k])
        break
      }
    }
  }
  return out
}

function snapshotRecord(posOverride) {
  if (!cur.id) return null
  const song = slimSong(cur)
  if (!song) return null

  // 快照里的 queue 始终是**原始队列**；随机模式下 index 指的是临时队列里的位置，
  // 得先按 id 在原始队列里找回当前曲（找不到就沿用 index 并夹紧，别让窗口算飞）
  
  let qi = index
  if (inShuffle()) {
    qi = -1
    for (let k = 0; k < queue.length; k++) {
      if (queue[k].id === cur.id) {
        qi = k
        break
      }
    }
    if (qi < 0) qi = index >= 0 ? Math.min(index, queue.length - 1) : 0
  }
  const q = slimQueue(queue, qi)
  let pos = typeof posOverride === 'number' ? posOverride : positionMs
  pos = Math.max(0, Math.round(pos || 0))
  const rec = {
    v: 1,
    at: Date.now(),
    playing: isPlaying && !paused, 
    queue: q.list,
    index: q.index,
    song: song,
    positionMs: pos,
    src: queueSrc 
  }

  if (inShuffle()) rec.shuffle = slimShuffle(shuf, index)
  return rec
}

// 立即落盘一次（不节流）。posOverride 显式指定快照位置：切歌瞬间传 0（新歌还没出声，
// 别把上一首的位置记到新歌头上）；「播完停下」传 0（恢复时是重播这首，而不是从末尾立刻结束）
function persist(posOverride) {
  const rec = snapshotRecord(posOverride)
  if (!rec) return
  lastSaveAt = Date.now()
  saveSession(rec)
}

export function flushNow() {
  persist()
}

/* 「退出时暂停音乐」（config.pauseOnExit，默认开，设置页可关）：退出前调一次，幂等。
 * 必须主动暂停的原因：SoundPlayer 是**独立的系统进程**（guardian_run 守护），应用退出
 * （closeApp/onDestroy）不会带走它 —— 不 stop 的话音乐会在退出后继续放，而那时应用已经不在了。
 * 走 pause（toggle 的暂停分支）而不是 stopPlay：暂停保留当前进度，下次打开按 ▶ 从原处续播。
 * 兜底超时 800ms：调用方会 await 它，原生调用万一卡住也不能把「退出」卡死。 */
export function pauseForExit() {
  if (!config.get('pauseOnExit')) return Promise.resolve(false)

  // 先作废在途的播放启动（playAt / 续播的每个 await 之后都会对 gen）—— 否则「点歌刚发出、
  // 还没出声」时退出，那个流程会在我们 stop 之后才把原生播放开起来
  
  gen++
  if (!cur.id || paused) return Promise.resolve(false) 
  log('player', '退出前暂停: ' + cur.name)
  const job = toggle().then(function () { return true }, function () { return false })
  return Promise.race([job, new Promise(function (res) {
    setTimeout(function () { res(false) }, 800)
  })])
}

// 墙钟推算当前播放位置：**必须乘倍速**（1.5x 时媒体位置走得比墙钟快）
function elapsed() {
  return baseMs + (Date.now() - startedAt) * rate
}

function startTimer() {
  stopTimer()
  timer = setInterval(function () {
    if (paused) return
    const el = elapsed()
    positionMs = el
    if (cur.durationMs && el > cur.durationMs + 500) {
      positionMs = cur.durationMs
      // EndChanged 的兜底：事件万一不来，墙钟也会连播
      requestEnd() 
      return
    }

    // 流播起播比本地慢（冷 CDN 实测 ~6s）：出声前挂着「缓冲中...」，首个 position 事件会清它；
    // 事件万一不来，3 秒后也清掉，别一直占着时间位
    
    if (status === '缓冲中...' && Date.now() - startedAt > 3000) status = ''
    emit()

    // 播放中定期存位置快照（被强杀/待机自动关机时「上次播放状态」最多丢这么久；正常退出有 flushNow 精确存）
    
    const gap = queue.length > BIGQ ? SAVE_MS_BIGQ : SAVE_MS
    if (Date.now() - lastSaveAt >= gap) persist()
  }, 500)
}

/* 统一的出声入口：本地文件与在线直链都走 playFile（直链同样认位置与倍速，实测定案）。
 * locator: 本地绝对路径或 http 直链；kind: 'file' | 'stream'；my: 调用方代次（缺省当前 gen）。
 * ⚠ 本函数是**破坏性**的：先 stop() 再 playFile —— 失败时旧播放也已经没了。 */
async function startSource(locator, posMs, kind, my) {

  // 先断掉「自己在播」的守卫：这次 stop() 触发的 EndChanged / 迟到事件必须被忽略
  paused = true
  isPlaying = false
  uuid = ''
  stopTimer()
  await stop()
  if (my !== undefined && my !== gen) return false
  const u = await playFile(locator, posMs || 0, rate)
  // 别把别人的任务 uuid 记到自己头上
  if (my !== undefined && my !== gen) return false 
  uuid = u || ''
  baseMs = posMs || 0
  startedAt = Date.now()
  positionMs = baseMs
  paused = false
  isPlaying = true
  srcMode = kind
  if (kind === 'file') {
    localPath = locator
    status = '' 
  }

  // 流播保留当前的「缓冲中...」：出声由首个 position 事件确认（tick 另有 3s 看门狗）
  startTimer()
  emit()
  return true
}

// 下载进度回调工厂（限流 ~500ms 一次，别把渲染打爆）：只在「还是当前曲目」时更新；
// showStatus=true 才占用播放页的时间位置（用户正在等），后台补缓存只更新 hint
function progressStatus(songId, showStatus) {
  let last = 0
  return function (done, total, speed) {
    if (String(cur.id) !== String(songId)) return
    const now = Date.now()
    if (now - last < 500 && total && done < total) return
    last = now
    const pct = total ? Math.floor((done / total) * 100) : 0
    const mb = speed > 0 ? ' ' + (speed / (1024 * 1024)).toFixed(1) + 'M/s' : ''
    if (showStatus) status = total ? '缓冲中 ' + pct + '%' : '缓冲中 ' + Math.round(done / 1024) + 'KB'
    hint = '缓冲中' + mb + ' (' + Math.round(done / 1024) + 'KB)' 
    emit()
  }
}

// 「需要当前曲目的完整本地文件」的兜底（直链拿不到 / 流播起播失败才用），有缓存直接给、没有就等后台缓存下完；
// ensureCached 不缓存失败结果，所以流播途中缓存失败会在这里重试
async function needLocal() {
  if (localPath) return { ok: true, path: localPath }
  if (!cur.id) return { ok: false, error: '没有歌曲' }
  const id = cur.id
  hint = '缓冲中...'
  status = '缓冲中 0%'
  loading = true
  emit()
  const r = await ensureCached(cur, null, { onProgress: progressStatus(id, true) })

  // 等待期间切歌了：别把上一首的路径写到当前曲头上
  if (String(cur.id) !== String(id)) {
    log('player', 'needLocal 期间已切歌，丢弃结果 id=' + id)
    return { ok: false, error: '已切歌' }
  }
  loading = false
  if (!r || !r.ok) {
    hint = (r && r.error) || '缓存失败'
    status = '缓冲失败'
    emit()
    return r || { ok: false, error: '缓存失败' }
  }
  localPath = r.path
  status = ''
  emit()
  return r
}

async function ensureStreamUrl() {
  if (!cur.id) return null
  const id = cur.id
  const q = currentQuality('play')
  if (streamUrl && String(streamUrl.id) === String(id) && streamUrl.q === q &&
      Date.now() - streamUrl.at < URL_TTL_MS) {
    return streamUrl
  }
  if (streamUrlJob && String(streamUrlJob.id) === String(id) && streamUrlJob.q === q) {
    return streamUrlJob.p
  }
  const job = { id: id, q: q, p: null }
  job.p = resolveUrl(id, q).then(function (info) {
    if (streamUrlJob === job) streamUrlJob = null
    if (!info || !info.url) return null
    const rec = Object.assign({}, info, { id: id, q: q, at: Date.now() })
    streamUrl = rec
    log('player', '直链就绪 id=' + id + ' br=' + (info.br || '') +
      ' lvl=' + (info.level || '-') + ' q=' + q)
    return rec
  }, function (e) {
    if (streamUrlJob === job) streamUrlJob = null
    log('player', '直链失败 id=' + id + ': ' + ((e && e.message) || e))
    return null
  })
  streamUrlJob = job
  return job.p
}

// 后台补**播放缓存**（流播也要把整首存下来）：走 play 通道 → 落 $dataDir/cache、按播放音质、
// 受「缓存上限」LRU 滚动、**不**出现在「本地下载」里（缓存与下载分家）。
// KICK_MS 内同曲只踢一次（反复 seek 别反复入队）；不喂直链：让下载层自己重新解析（播放档的直链可能已经太老）
function kickCache() {
  if (!cur.id) return
  const id = cur.id
  if (String(cacheKick.id) === String(id) && Date.now() - cacheKick.at < KICK_MS) return
  cacheKick = { id: id, at: Date.now() }
  const job = ensureCached(cur, null, { onProgress: progressStatus(id, false) })
  job.then(function (r) {
    if (r && r.ok && String(cur.id) === String(id)) {
      localPath = r.path
      emit()
    }
  })
}

/* seek / 续播（▶）/ 改倍速的统一流程：有本地文件 → 本地定位；没有 → 直链流式定位（同时后台补缓存）；
 * 直链也拿不到 → 回退「等整首下载」；流播起播失败 → 同样回退等下载。
 * 入口 ++gen：用户动作里最后一次赢（连点 seek / seek 撞暂停都不会被旧流程抢回去）。 */
async function reopenAt(posMs, label) {
  const my = ++gen
  if (!cur.id) return false
  const pos = Math.max(0, Math.round(posMs || 0))

  let kind = ''
  let locator = ''
  if (localPath) {
    kind = 'file'
    locator = localPath
  } else {

    // 磁盘缓存优先（loadLastState / 接管回灌后 localPath 是空的，但文件可能还在）
    const hit = await cachedPath(cur.id)
    if (my !== gen) return false
    if (hit) {
      localPath = hit
      kind = 'file'
      locator = hit
    } else {
      const info = await ensureStreamUrl()
      if (my !== gen) return false
      if (info && info.url) {
        kind = 'stream'
        locator = info.url
        kickCache() 
      } else {

        // 直链拿不到（受限 / 网络差）→ 回退旧行为：等整首下载
        const l = await needLocal()
        if (my !== gen) return false
        if (l && l.ok) {
          kind = 'file'
          locator = l.path
        } else {
          hint = (l && l.error) || '无法播放'
          status = '歌曲受限'
          emit()
          return false
        }
      }
    }
  }

  if (kind === 'stream') {

    // 解析直链要 200ms~3s，且 startSource 会先 stop 掉当前声音 —— 要有反馈
    status = '缓冲中...'
    hint = '缓冲中...'
    emit()
  }
  let ok = false
  try {
    ok = await startSource(locator, pos, kind, my)
  } catch (e) {
    log('player', '起播失败(' + kind + '): ' + ((e && e.message) || e))
  }
  if (ok) {
    hint = label || hint
    emit()
    return true
  }
  if (my !== gen) return false

  if (kind === 'stream') {
    const l = await needLocal()
    if (my !== gen) return false
    if (l && l.ok) {
      try {
        if (await startSource(l.path, pos, 'file', my)) {
          hint = label || hint
          emit()
          return true
        }
      } catch (e2) {
        log('player', '回退本地起播失败: ' + ((e2 && e2.message) || e2))
      }
    }
  }
  if (my !== gen) return false
  paused = true
  isPlaying = false
  stopTimer()
  hint = '播放失败，按 ▶ 重试'
  status = '播放失败'
  emit()
  persist()
  return false
}

async function handleEnded() {
  const total = activeList().length
  if (total === 0) return
  if (loopMode === 'single') {
    hint = '单曲循环'
    await playAt(index)
    return
  }
  if (inShuffle()) {
    const n = shuffleNext(index)
    if (n >= 0) await playAt(n)
    return
  }

  if (index < total - 1) {
    await playAt(index + 1)
    return
  }

  if (loopMode === 'list_loop') {
    await playAt(0)
    return
  }
  isPlaying = false
  paused = false
  hint = '播放结束'
  status = ''
  stopTimer()
  emit()
  persist(0) 
}

async function playAt(i) {
  // i 是「生效队列」的下标（随机模式 = 临时队列；页面显示的也是它）
  const s = activeList()[i] 
  if (!s) return
  const my = ++gen
  cur = s
  index = i
  durationMs = s.durationMs || 0
  paused = false
  isPlaying = false
  loading = true
  srcMode = ''
  localPath = ''
  uuid = '' 
  cacheKick = { id: '', at: 0 } 
  hint = '准备中...'
  status = '准备中...'

  // 切歌即重置时钟、停掉旧 tick：出声（startSource 会重启计时器）之前的空窗里，
  // 旧 baseMs/startedAt 会算出上一首的进度，甚至对新歌提前触发「播完」判定
  
  stopTimer()
  baseMs = 0
  startedAt = Date.now()
  positionMs = 0
  emit()
  // 上次播放状态：切歌瞬间就记上新歌（位置 0），即便随后播放失败也算「选过它」
  persist(0) 

  // 搜索接口不带封面（只有 picId）、本地下载页的条目可能缺时长 —— 都用详情接口补；带竞态校验
  if (!s.cover || !s.durationMs) {
    getSongDetail(s.id)
      .then(function (d) {
        if (!d) return
        enrich(d) 
        if (cur.id !== d.id || my !== gen) return
        const needCover = !cur.cover && d.cover
        const needDur = !durationMs && d.durationMs
        if (!needCover && !needDur) return
        if (needCover) cur = d
        else cur = Object.assign({}, cur, d) 

        // **模块级 durationMs 也要补**：startTimer 的播完判定、seekTo、快照/进度环都用它 ——
        // 不补的话「从本地下载页点播缺时长的老缓存」永远不自动连播、进度条也拖不动
        
        if (needDur) durationMs = d.durationMs
        emit()
        persist() 
      })
      .catch(function () {})
  }

  const hit = await cachedPath(s.id)
  if (my !== gen) return
  if (hit) {
    localPath = hit
    loading = false
    hint = '本地缓存播放'
    await startSource(hit, 0, 'file', my)
    log('player', '播放中(缓存): ' + s.name + ' rate=' + rate + ' mode=' + loopMode)
    if (cur.id === s.id) record(cur) 
    // 记「最近播放」：缓存上限 LRU 按它决定先淘汰谁（下载目录的条目不受影响）
    touchPlayCache(s.id) 
    return
  }

  // 取直链：用「播放音质」档（ensureStreamUrl 内部按 currentQuality('play') 解析）；
  // 同曲 TTL 内的直链走内存复用（seek/续播/改倍速也都吃这一份）
  

  const info = await ensureStreamUrl()
  if (my !== gen) return
  if (!info) {
    hint = '歌曲受限，暂无直链'
    status = '歌曲受限'
    loading = false
    isPlaying = false
    emit()
    log('player', '受限: ' + s.name)
    return
  }

  // 流式播放：playFile 直链同样认位置与倍速（实测），不再有「倍速≠1 先缓存」
  let streamed = false
  hint = '缓冲中...'
  status = '缓冲中...'
  emit()
  try {
    streamed = await startSource(info.url, 0, 'stream', my)
  } catch (e) {
    log('player', '流式不可用，转下载: ' + ((e && e.message) || e))
  }
  if (my !== gen) return
  if (streamed) {
    loading = false
    hint = rate === 1 ? '流式播放' : '流式播放 ' + rate + 'x'
    log('player', '流式播放: ' + s.name + ' br=' + (info.br || '') +
      ' lvl=' + (info.level || '-') + ' rate=' + rate + ' mode=' + loopMode)
    if (cur.id === s.id) record(cur) 
  }

  // 后台**播放缓存**（落 cache/、按播放音质）：本地 seek/续播要用，也让下次播放秒开；
  // ⚠ 它**不是**「下载」—— 不进「本地下载」列表，且受设置项「缓存上限」按播放顺序 LRU 滚动。
  // 缓存档 = 播放档，这份直链天然可复用；只有太老（>2 分钟，首包会 403）才传 null 让下载层重解析
  

  

  const fresh = Date.now() - (info.at || 0) < URL_FRESH_MS
  const job = ensureCached(s, fresh ? info : null, { onProgress: progressStatus(s.id, !streamed) })
  job.then(function (r) {
    if (r && r.ok && cur.id === s.id) {
      localPath = r.path
      emit()
    }
  })

  if (streamed) {
    emit()
    return
  }

  hint = rate === 1 ? '缓冲中...' : '倍速 ' + rate + 'x'
  status = '缓冲中 0%'
  emit()
  const r = await job
  if (my !== gen) return
  if (!r.ok) {
    hint = r.error || '无法播放'
    status = '下载失败'
    loading = false
    isPlaying = false
    emit()
    log('player', '不可播: ' + s.name + ' ' + (r.error || ''))
    return
  }
  localPath = r.path
  loading = false
  hint = '已缓存 ' + Math.round((r.size || 0) / 1024) + 'KB'
  await startSource(r.path, 0, 'file', my)
  log('player', '播放中(下载): ' + s.name + ' rate=' + rate + ' mode=' + loopMode)
  if (cur.id === s.id) record(cur) 
}

async function toggle() {
  if (!cur.id) return
  if (paused) {

    // 续播：有本地用本地、没有就直链定位起播（不再等整首下载）
    const ok = await reopenAt(positionMs, '继续播放')
    if (ok) persist()
  } else {
    const pos = positionMs
    paused = true
    isPlaying = false
    // 作废在途的启动流程（seek/续播回来时别把播放又开起来）
    gen++ 
    // 这次 stop 的结束事件不该被认成「播完」
    uuid = '' 
    status = ''
    await stop()
    baseMs = pos
    stopTimer()
    hint = '已暂停 @' + fmtDur(pos)
    emit()
    persist() 
  }
}

async function stopPlay() {
  stopTimer()
  gen++ 
  uuid = ''
  paused = false
  isPlaying = false
  positionMs = 0
  baseMs = 0
  status = ''
  await stop()
  hint = '已停止'
  emit()
  // 停在 0（上面刚置零）：恢复后按 ▶ 是重播这首
  persist() 
}

// 原生在线流可直接定位（playFile(url, pos, rate) 实测定案）：有本地文件用文件、没有就直链流式定位；
// 直链拿不到才回退等缓存（见 reopenAt）
async function seekTo(ms) {
  if (!cur.id || !cur.durationMs) return
  let pos = Math.max(0, Math.min(cur.durationMs - 500, Math.round(ms)))
  if (pos < 0) pos = 0
  const ok = await reopenAt(pos, '跳转 @' + fmtDur(pos))
  if (ok) {
    persist()
    log('player', 'seek -> ' + pos + ' (' + srcMode + ' @' + rate + 'x)')
  }
}

// 手动上一/下一**始终环绕**（与自动连播不同：顺序播放只在自然播完到尾时停，手动点则从尾绕到首）
function stepIndex(dir) {
  const total = activeList().length
  if (total === 0) return -1
  if (total === 1) return 0
  if (inShuffle()) return dir > 0 ? shuffleNext(index) : shufflePrev(index)
  let n = index + dir
  if (n < 0) n = total - 1
  if (n >= total) n = 0
  return n
}

function next() {
  const n = stepIndex(1)
  if (n >= 0) playAt(n)
}

function prev() {
  const n = stepIndex(-1)
  if (n >= 0) playAt(n)
}

// src：队列来源标记（可选）—— 目前只有 'downloads'（本地下载页），删下载曲目时按它决定要不要同步清理队列
function playList(songs, i, src) {
  queue = songs || []
  queueSrc = src || ''
  qgen++
  shuf = null 
  const at = i || 0
  if (loopMode === 'shuffle') {
    buildShuffle(queue[at])
    return playAt(0)
  }
  return playAt(at)
}

/* 队列被清空 → 播放器回到**空态**（编辑队列允许清空）。
 * 与 stopPlay 不是一回事：stopPlay 保留曲目、只把位置归零（按 ▶ 是重播这首）；这里连 cur 一起清掉。
 * 三件必须做的事：
 *   ① gen++ / uuid='' 作废在途的起播流程（这次 stop 的结束事件不能被认成「播完」→ 连播）
 *   ② clearSession() 删掉会话快照：不删的话下次启动会把刚清空的队列恢复回来
 *   ③ emit 之后再 stop：订阅者先拿到空态，随后原生播放器才停 */
function clearPlayback(hintText) {
  gen++
  uuid = ''
  stopTimer()
  qgen++
  queue = []
  queueSrc = ''
  shuf = null
  cur = {}
  index = -1
  durationMs = 0
  positionMs = 0
  baseMs = 0
  startedAt = 0
  paused = false
  isPlaying = false
  loading = false
  srcMode = ''
  localPath = ''
  status = ''
  streamUrl = null
  cacheKick = { id: '', at: 0 }
  hint = hintText || '队列已清空'
  emit()
  clearSession()
  try {
    const p = stop()
    if (p && p.catch) p.catch(function () {})
  } catch (e) {}
  log('player', '队列已清空 → 播放器空态')
}

// 只换当前曲、**不出声**（移除在播曲后接下一首；暂停态走这条）：用户本来没在听，不能因为「删了一首」就突然出声
function switchTo(i) {
  const s = activeList()[i]
  if (!s) return false
  gen++ 
  uuid = ''
  stopTimer()
  cur = s
  index = i
  durationMs = s.durationMs || 0
  positionMs = 0
  baseMs = 0
  startedAt = 0
  paused = true
  isPlaying = false
  loading = false
  srcMode = ''
  localPath = ''
  status = ''
  hint = ''
  emit()
  persist(0)
  try {
    const p = stop()
    if (p && p.catch) p.catch(function () {})
  } catch (e) {}
  return true
}

// 在删除**前**的生效队列里找「第 from 首之后第一个活下来的」：先往后找，后面没了再绕回队首
function pickAfter(al, from, drop) {
  const n = al ? al.length : 0
  if (!n) return null
  const start = from >= 0 ? from + 1 : 0
  for (let k = start; k < n; k++) {
    if (al[k] && !drop[String(al[k].id)]) return al[k]
  }
  for (let k = 0; k < Math.min(start, n); k++) {
    if (al[k] && !drop[String(al[k].id)]) return al[k]
  }
  return null
}

/* 从当前播放队列移除若干首（播放列表页多选「移除」）。
 *   - 允许移除正在播放的那首：删完接着播「原来的下一首」（当时在出声就继续出声，暂停态只换曲不播）
 *   - 允许把队列清空：删完一首不剩 → 停播并回空态（见 clearPlayback）
 *   - 原始队列与随机临时队列同时删；在播曲没被删时 index 按它在「生效队列」里的新位置重算
 * 返回 { ok, removed, skipped, emptied, switched } */
function removeFromQueue(ids) {
  const list = ids || []
  const drop = {}
  for (let i = 0; i < list.length; i++) drop[String(list[i])] = 1
  if (!Object.keys(drop).length) {
    return { ok: false, removed: 0, skipped: 0, emptied: false, switched: false }
  }
  const hitCur = !!(cur.id && drop[String(cur.id)])

  // 删除**前**的生效队列与下标：找「下一首」要用旧顺序，删完就找不着了
  const alOld = activeList()
  const curIdx = index
  const wasPlaying = isPlaying && !paused
  const keep = function (arr) {
    const out = []
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i]
      if (s && !drop[String(s.id)]) out.push(s)
    }
    return out
  }
  const before = queue.length
  queue = keep(queue)
  if (shuf) shuf = keep(shuf)
  const removed = before - queue.length
  if (!removed) {
    return { ok: false, removed: 0, skipped: 0, emptied: false, switched: false }
  }

  if (!queue.length) {
    clearPlayback('播放列表已清空')
    return { ok: true, removed: removed, skipped: 0, emptied: true, switched: false }
  }

  // 在播曲被删 → 接着放「原来的下一首」
  if (hitCur) {
    const pick = pickAfter(alOld, curIdx, drop)
    const al = activeList()
    let ni = -1
    for (let i = 0; i < al.length; i++) {
      if (al[i] && pick && String(al[i].id) === String(pick.id)) {
        ni = i
        break
      }
    }
    if (ni < 0) ni = 0
    if (wasPlaying) playAt(ni)
    else switchTo(ni)
    log('player', '队列移除 ' + removed + ' 首（含在播曲，剩 ' + queue.length + '）→ 接第 ' +
      (ni + 1) + ' 首' + (wasPlaying ? '（继续播放）' : '（暂停中，只换曲）'))
    return { ok: true, removed: removed, skipped: 0, emptied: false, switched: true }
  }

  // 在播曲还在 → index 按它在生效队列里的新位置重算；万一找不到（异常态）就夹紧到合法范围
  
  const al = activeList()
  if (cur.id) {
    let ni = -1
    for (let i = 0; i < al.length; i++) {
      if (al[i] && String(al[i].id) === String(cur.id)) {
        ni = i
        break
      }
    }
    index = ni >= 0 ? ni : Math.min(index, Math.max(0, al.length - 1))
  } else {
    index = al.length ? Math.min(Math.max(index, 0), al.length - 1) : -1
  }
  hint = '已移除 ' + removed + ' 首'
  log('player', '队列移除 ' + removed + ' 首（剩 ' + queue.length + '）')
  emit()
  persist()
  return { ok: true, removed: removed, skipped: 0, emptied: false, switched: false }
}

/* 把若干首**插到当前曲之后**（「下一首播放」）：不动在播曲、不改队列顺序，按 id 去重（返回 dup 计数）。
 * 两条队列要一起改，否则「下一首」名不副实 —— 随机模式 index 指临时队列 shuf，插在 index+1 才是「马上播」；
 * 原始队列 queue 里则插在在播曲之后（切回顺序模式时顺序仍正确）。
 * 队列为空时没有「下一首」可插 → 直接起播这几首（等价于点歌）。 */
function insertNext(songs) {
  const add = songs || []
  if (!add.length) return { ok: false, added: 0, dup: 0, played: false }
  if (!queue.length) {
    playList(add.slice(), 0)
    log('player', '队列为空，「下一首播放」改为直接起播 ' + add.length + ' 首')
    return { ok: true, added: add.length, dup: 0, played: true }
  }
  const has = {}
  for (let i = 0; i < queue.length; i++) {
    if (queue[i] && queue[i].id != null) has[String(queue[i].id)] = 1
  }
  const fresh = []
  let dup = 0
  for (let i = 0; i < add.length; i++) {
    const s = add[i]
    if (!s || s.id == null) continue
    const k = String(s.id)
    if (has[k]) {
      dup++
      continue
    }
    has[k] = 1
    fresh.push(s)
  }
  if (!fresh.length) return { ok: true, added: 0, dup: dup, played: false }

  // 原始队列：插在在播曲之后（在播曲不在队列里就插队首）
  let qi = 0
  if (cur.id) {
    for (let i = 0; i < queue.length; i++) {
      if (queue[i] && String(queue[i].id) === String(cur.id)) {
        qi = i + 1
        break
      }
    }
  }
  queue = queue.slice(0, qi).concat(fresh).concat(queue.slice(qi))
  if (inShuffle()) {
    const si = index >= 0 && index < shuf.length ? index + 1 : 0
    shuf = shuf.slice(0, si).concat(fresh).concat(shuf.slice(si))
  }
  hint = '已插入下一首：' + (fresh[0].name || '')
  log('player', '插入下一首 ' + fresh.length + ' 首（重复 ' + dup + '）队列 ' + queue.length)
  emit()
  persist()
  return { ok: true, added: fresh.length, dup: dup, played: false }
}

// 后台补齐起播时记下这个代次，见 appendToQueue
function queueToken() {
  return qgen
}

/* 把若干首**追加到队尾**（大歌单「先起播、后补齐」用）。
 * opts.gen 是起播时 queueToken() 的值：对不上说明用户已经换了队列，这批歌不属于当前播放内容 → 丢弃（stale），
 * 否则会把上一份列表的歌塞进新队列；队列已空（用户清空过）同样丢弃，不擅自起播。
 * 随机模式下临时队列也追加在尾部，当前这一轮的播放路径不变。 */
function appendToQueue(songs, opts) {
  const add = songs || []
  const gen = opts && typeof opts.gen === 'number' ? opts.gen : null
  if (gen !== null && gen !== qgen) {
    return { ok: false, added: 0, dup: 0, stale: true, total: queue.length }
  }
  if (!add.length) return { ok: true, added: 0, dup: 0, stale: false, total: queue.length }
  if (!queue.length) return { ok: false, added: 0, dup: 0, stale: true, total: 0 }
  const has = {}
  for (let i = 0; i < queue.length; i++) {
    if (queue[i] && queue[i].id != null) has[String(queue[i].id)] = 1
  }
  const fresh = []
  let dup = 0
  for (let i = 0; i < add.length; i++) {
    const s = add[i]
    if (!s || s.id == null) continue
    const k = String(s.id)
    if (has[k]) {
      dup++
      continue
    }
    has[k] = 1
    fresh.push(s)
  }
  if (!fresh.length) return { ok: true, added: 0, dup: dup, stale: false, total: queue.length }
  queue = queue.concat(fresh)
  if (shuf) shuf = shuf.concat(fresh)
  log('player', '队列追加 ' + fresh.length + ' 首（重复 ' + dup + '）队列 ' + queue.length)
  emit()
  persist()
  return { ok: true, added: fresh.length, dup: dup, stale: false, total: queue.length }
}

// 改倍速：按当前位置用当前源重开（playFile 第三参数，在线倍速实测可用）
async function setRate(r) {
  const v = typeof r === 'number' ? r : parseFloat(r)
  if (!v || v <= 0) return
  rate = v
  await config.set('rate', v)
  log('player', '倍速 -> ' + v)
  if (!cur.id || paused) {
    emit()
    return
  }
  await reopenAt(positionMs, '倍速 ' + v + 'x')
}

// 切循环模式：进出随机**只重排播放顺序、不动正在放的歌**（不重开播放，只挪 index）
async function setLoopMode(key) {
  for (let i = 0; i < MODES.length; i++) {
    if (MODES[i].key === key) {
      const prev = loopMode
      loopMode = key
      if (key === 'shuffle') {
        shuf = null
        if (buildShuffle(cur.id ? cur : null)) index = 0
      } else if (prev === 'shuffle') {
        shuf = null
        if (cur.id) {
          for (let k = 0; k < queue.length; k++) {
            if (queue[k].id === cur.id) {
              index = k
              break
            }
          }
        }
      }
      await config.set('loopMode', key)
      hint = '模式：' + MODES[i].label
      log('player', '循环模式 -> ' + key + (key === 'shuffle' ? '（重洗 ' + queue.length + ' 首）' : ''))
      emit()
      persist() 
      return
    }
  }
}

async function cycleLoopMode() {
  let i = 0
  for (let k = 0; k < MODES.length; k++) {
    if (MODES[k].key === loopMode) i = k
  }
  await setLoopMode(MODES[(i + 1) % MODES.length].key)
}

export function loadPlayerSettings() {
  const r = config.get('rate')
  if (typeof r === 'number' && r > 0) rate = r
  const m = config.get('loopMode')
  for (let i = 0; i < MODES.length; i++) {
    if (MODES[i].key === m) loopMode = m
  }
  log('player', '设置恢复 rate=' + rate + ' mode=' + loopMode)
}

/* 启动时恢复「上次播放状态」（boot 里 await，幂等）—— 快照由 session.js 落盘。
 * 恢复态**一律暂停**：队列/当前曲/进度都回到内存、首页卡片与播放页立刻显示上次的歌，但不出声；
 * 按 ▶ 才走 toggle() 的续播分支。位置落在末尾 2 秒内的按 0 处理
 * （多半是「快播完时被关机/强杀」，恢复成立刻结束没有意义）。 */
export async function loadLastState() {
  const s = await loadSession()
  if (!s) {
    log('player', '上次播放状态: 无')
    return false
  }
  queue = s.queue
  queueSrc = s.src || '' 
  qgen++
  shuf = null

  // 随机模式：按快照存的 id 序列重建临时队列（顺序与退出前一致）；老快照没有该字段、或大歌单窗口
  // 裁得只剩一两首时，退化为「以当前曲为锚点重洗」
  
  if (loopMode === 'shuffle') {
    shuf = rebuildShuffle(s.shuffle)
    if (shuf.length < 2) buildShuffle(s.song)
    log('player', '随机队列重建: ' + shuf.length + ' 首（快照 ' +
      ((s.shuffle && s.shuffle.length) || 0) + ' 个 id）')
  }

  // 当前曲在**生效队列**里的位置（随机模式 = 临时队列）
  const list = activeList()
  let i = -1
  for (let k = 0; k < list.length; k++) {
    if (list[k].id === s.song.id) {
      i = k
      break
    }
  }
  if (i < 0) {
    i = s.index
    if (!(i >= 0)) i = 0
    if (i > list.length - 1) i = list.length - 1
  }
  index = i
  cur = s.song
  durationMs = cur.durationMs || 0
  let pos = Math.max(0, Math.round(s.positionMs || 0))
  if (durationMs && pos > durationMs - 2000) pos = 0
  stopTimer()
  baseMs = pos
  startedAt = Date.now()
  positionMs = pos
  paused = true
  isPlaying = false
  loading = false
  srcMode = ''
  // 缓存/直链一律现查（reopenAt / playAt），别信上次的快照
  localPath = '' 
  uuid = ''
  status = ''
  hint = '上次播放 · 按 ▶ 继续'
  emit()
  log('player', '恢复上次播放: ' + cur.name + ' @' + Math.round(pos / 1000) + 's（队列 ' +
    queue.length + ' 首，第 ' + (index + 1) + ' 首，退出时' + (s.playing ? '在播' : '未在播') + '）')
  return true
}

function state() {
  return snapshot()
}

function on(fn) {
  subs.push(fn)
  return fn
}

function off(fn) {
  const i = subs.indexOf(fn)
  if (i >= 0) subs.splice(i, 1)
}

export const player = {
  playList: playList,
  playAt: playAt,
  toggle: toggle,
  next: next,
  prev: prev,
  stop: stopPlay,
  seekTo: seekTo,
  setRate: setRate,
  setLoopMode: setLoopMode,
  cycleLoopMode: cycleLoopMode,
  removeFromQueue: removeFromQueue,
  insertNext: insertNext,
  queueToken: queueToken,
  appendToQueue: appendToQueue,
  state: state,
  on: on,
  off: off,
  flushNow: flushNow,
  pauseForExit: pauseForExit
}
