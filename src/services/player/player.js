/**
 * 播放器单例 —— 跨页面共享的播放状态与控制
 *
 * 基础行为：
 *   - **统一出声入口**：本地文件与在线直链一律走 `playFile(locator, pos, rate)`
 *     （平台实测：fileName 给直链时同样认 position 与 rate）。命中缓存播本地秒开；
 *     没缓存先取直链流播出声（重连发 Range 拿 206 从指定位置续播），下载退到后台做**播放缓存**，
 *     下次同一首秒开。⚠ **「播放缓存」≠「下载」**（分家）：缓存落 `$dataDir/cache`、
 *     按**播放音质**、受设置项「缓存上限」按播放顺序 LRU 滚动、**不出现在本地下载里**；
 *     用户主动下载落 `$dataDir/music`、按**下载音质**、永久保留
 *   - **seek / 续播（▶）/ 改倍速不再等整首下载**：有本地文件用文件、没有就直链定位起播；
 *     直链取不到（受限 / 网络差）才回退旧的「等缓存」（needLocal）
 *   - **进度 = 原生事件锚定 + 墙钟插值兜底**：`reportPosition=1` 的 mediaPlayerPositionChanged
 *     约每 50ms 一条（信号对象 .on 订阅；SoundPlayer 是全系统单例、事件全服务广播，
 *     必须按 playFile 返回的 uuid 过滤）；事件只重锚墙钟（positionMs/baseMs/startedAt），
 *     显示仍由 500ms tick 输出；DurationChanged 回填时长、EndChanged 是播完的精确信号
 *     （与墙钟判定共用 requestEnd 去重）
 *   - **循环模式**：列表循环 / 顺序播放 / 单曲循环 / 随机播放（持久化进 config）
 *   - **随机播放是「假随机」**：进随机时把原始队列打乱成一份**临时队列**
 *     （当前曲作锚点留在队首），之后下一首就沿临时队列走 —— 一轮之内每首恰好放一次，不会重复；
 *     走到队尾再重洗一轮。**原始队列永不被改动**，切回其它模式即恢复原顺序。
 *   - **播完自动连播**：按模式决定下一首；顺序播放到头才停
 *
 * 不变的坑：
 *   - 无 pause：暂停 = stop()，续播 = playFile(源, positionMs, rate)
 *   - 事件回调 20~25 条/秒：里面禁止打日志（log 每条一次 HTTP POST）与 emit
 *
 * 页面用法：`import { player } from '…/player/player.js'`
 *   const off = player.on(s => { this.st = s })   // 订阅
 *   this.st = player.state()                       // 读当前
 *   player.playList(songs, i) / toggle() / next() / prev() / stop() / seekTo(ms) / setRate(r) / setLoopMode(m)
 * 不要在页面里直接操作原生播放器（sound.js / download.js）。
 *
 * 已验证：多页面间 ES 模块为同一实例（粉笔冒烟测试 n=1→2）。
 */
import { cachedPath, resolveUrl, ensureCached, setFileChangedHook, touchPlayCache } from './download.js'
import { setCacheProtectHook } from './cache.js'
import { currentQuality } from './quality.js'
import { save as saveSession, load as loadSession, clear as clearSession, slimSong, slimQueue, slimShuffle } from './session.js'
import { playFile, stop, bindEvents } from './sound.js'
import { record, enrich } from './history.js'
import { getSongDetail } from '../ncm/api.js'
import { fmtDur } from '../format.js'
import { log } from '../log.js'
import config from '../config.js'

/* ---- 循环模式 ---- */
export const MODES = [
  { key: 'list_loop', label: '列表循环' },
  { key: 'list_seq', label: '顺序播放' },
  { key: 'single', label: '单曲循环' },
  { key: 'shuffle', label: '随机播放' }
]

/** 倍速档位 */
export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

function modeInfo(key) {
  for (let i = 0; i < MODES.length; i++) {
    if (MODES[i].key === key) return MODES[i]
  }
  return MODES[0]
}

/* ---- 状态（模块级 = 单例） ---- */
let queue = [] // 原始队列：随机模式也**绝不重排**它（打乱的是下面那份临时队列）
let queueSrc = '' // 队列来源标记（playList 第三参）：'downloads' = 从「本地下载」页建的队列。
//   用途：删下载曲目时**只**同步清理这种队列（混合/在线队列里的歌删了本地文件还能流播，不动）；
//   随会话快照持久化（session.js 的 src 字段），重启后恢复态仍认得
let shuf = null // 随机模式的临时队列（queue 的乱序副本，同一批歌曲对象）；非随机模式为 null
let index = -1 // 当前曲在**生效队列**里的下标（随机模式指 shuf，其它模式指 queue）
let cur = {}
let isPlaying = false
let paused = false
let hint = ''
let status = '' // 短状态（「缓冲中 42%」「歌曲受限」…）——**会显示在播放页时间位置**，只放短文案
let srcMode = '' // '' | 'file' | 'stream'：当前出声的是本地文件还是在线流
let localPath = '' // 当前曲目已确认完整的本地文件（流播途中缓存完成才补上）
let uuid = '' // 当前原生任务的 uuid（playFile 返回值）：媒体事件按它过滤，stop/结束即清
let streamUrl = null // 当前曲直链的内存缓存 {id,q,url,br,size,type,at}（单条；TTL 见 URL_TTL_MS）
let streamUrlJob = null // 同曲同档在途的直链解析（并发动作合并等待，别重复发请求）
let cacheKick = { id: '', at: 0 } // 后台补缓存的备忘（同曲 KICK_MS 内只踢一次）
let endAt = 0 // 播完处理的去重时间戳（EndChanged 与墙钟判定共用 requestEnd）
let gen = 0 // 播放代次：playAt 每次 +1，异步流程回到现场前对不上就作废
let startedAt = 0
let baseMs = 0
let positionMs = 0
let durationMs = 0
let loading = false
let timer = null
let rate = 1.0
let loopMode = MODES[0].key

/* 本地文件被删除/升质替换时的自清（download.js 的 deleteCached 与「重下替换」都会调）：
   当前曲的 localPath 一旦指向已失效/已被顶替的文件，seek/续播/改倍速就会用错文件。
   钩子在下载 promise resolve **之前**触发，所以各调用方随后写 localPath 的顺序不受影响
   （例如 playAt 的后台缓存完成回调仍是最终值）。正在播的 fd 不受删文件影响，照常放到段尾。 */
setFileChangedHook(function (id) {
  // 空 id = 整库失效（存储页清空缓存）→ 无论播的是哪首都清
  if (!id || (cur.id && String(cur.id) === String(id))) {
    localPath = ''
    log('player', '本地文件变更，清 localPath id=' + (id || '全部'))
  }
})

/* 「缓存上限」LRU 的保护名单：正在播放的那首绝不能被回收掉
   （文件一旦没了，正在播的 fd 虽还在，但 seek/续播/改倍速会立刻失效）。
   与 setFileChangedHook 同一套「注册钩子」风格，避免 cache.js 反过来 import 播放器。 */
setCacheProtectHook(function () {
  return cur.id ? [String(cur.id)] : []
})

/* ---- 上次播放状态落盘（快照组装在这里，存储/合并写在 session.js）---- */
const SAVE_MS = 5000 // 播放中位置快照的节流间隔（切歌/暂停/seek/退出这些动作即时存，不受它限制）
const SAVE_MS_BIGQ = 15000 // 队列很大时退回 15 秒：快照几十 KB，别每 5 秒重写一次整份 preferences.json
const BIGQ = 200 // 「大队列」阈值（≈50KB；history.js 的经验值：60KB 级的写入可能有可感卡顿）
let lastSaveAt = 0

/* ---- 流播 / 事件相关常量（流式定位改造） ---- */
const URL_TTL_MS = 600000 // 直链内存缓存有效期（平台 expi≈1200s，留一半余量）
const URL_FRESH_MS = 120000 // 只有很新的直链才转交下载层复用（太老的首包会 403）
const KICK_MS = 60000 // 后台补缓存的去重窗口（反复 seek 别反复入队）
const NEAR_END_MS = 3000 // 结束事件判定「临近结尾」的容差（区分自然播完与外部 stop）
const END_DEDUP_MS = 1500 // 播完处理去重窗口（EndChanged 与墙钟判定可能双双触发）

/* ---- 媒体事件（流式定位改造） ----
 * SoundPlayer 是全系统单例：事件是全服务广播（别的应用/服务在播什么也会收到），
 * 必须按 playFile 返回的 uuid 过滤，再叠加「正在播 && 非暂停」守卫。
 * 回调形参已实证的是 position 的 (uuid, ms)；End/Duration 的形状未实证 →
 * pickUuid 容忍式解析 + 每种事件首次打一条带实参的形状日志（真机第一轮确认）。
 * ⚠ 事件 20~25 条/秒：回调里禁止逐条打日志（log 每条一次 HTTP POST），也不要 emit
 *   （显示仍由 500ms tick 输出，这里只重锚墙钟）。
 */
const shapeSeen = {} // 每种事件的形状日志只打一条

function pickUuid(args) {
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === 'string' && /^[0-9a-f]{8,}$/.test(args[i])) return args[i]
  }
  return ''
}

/** 取最后一个数值实参（position/duration 的值都在末位；对形状差异稳一点） */
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

/** 位置事件：只重锚墙钟（显示由 tick 输出）；首个事件顺带清「缓冲中...」（≈ 真的出声了） */
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

/** 时长事件：回填模块级 durationMs 与 cur.durationMs（播放页时长/拖动换算读后者） */
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
  if (cur.id && cur.durationMs !== v) cur.durationMs = v // 就地改字段，别换引用（cur 与队列条目的同一性要用）
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

/** 结束事件：临近结尾 = 自然播完；否则是外部 stop（别的应用/服务抢了单例）→ 中断收尾不连播 */
function onEnd() {
  const args = arguments
  firstShape('end', args)
  const u = pickUuid(args)
  if (u) {
    if (!uuid || String(u) !== String(uuid)) return
  } else if (!isPlaying || paused) return
  if (!isPlaying || paused) return
  uuid = '' // 结束事件只认一次
  if (!durationMs || positionMs >= durationMs - NEAR_END_MS) {
    requestEnd()
  } else {
    isPlaying = false
    stopTimer()
    hint = '播放中断'
    emit()
    persist() // 记下中断位置（下次续播从这里起）
    log('player', '播放中断(外部停止): ' + cur.name + ' @' + Math.round(positionMs / 1000) + 's')
  }
}

/** 出错事件：本轮只收尾 + 记日志（自动恢复重试留待后续） */
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

/** 进度事件：语义未探明 —— 只留形状日志，不参与逻辑 */
function onProg() {
  firstShape('progress', arguments)
}

/** 播完收尾统一入口：EndChanged 与墙钟判定共用，END_DEDUP_MS 内只认一次 */
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

/* ---- 随机播放：临时队列（假随机） ----
 * 不是「每首随机挑下一首」（会重复、也可能半天抽不到某些歌），而是**把原始队列整体打乱成
 * 一份临时队列**：当前曲留在队首当锚点，之后沿临时队列一首首走，一轮之内每首恰好放一次；
 * 走到队尾（一轮放完）再重洗一轮，仍以当前曲为锚点 —— 刚放完的这首不会立刻重放。
 * 原始队列 queue 不动，切回其它模式按 id 重新定位 index 即恢复原顺序。
 * 临时队列只在内存 + 「上次播放状态」快照里（快照存 id 序列，见 session.js 的 slimShuffle）。
 */

/** 当前生效的播放顺序：随机模式是临时队列，其它模式是原始队列 */
function activeList() {
  return loopMode === 'shuffle' && shuf && shuf.length ? shuf : queue
}

/** 是否正处在「临时队列」模式（随机模式且临时队列已就绪） */
function inShuffle() {
  return !!(loopMode === 'shuffle' && shuf && shuf.length)
}

/**
 * 生成/重洗临时队列：anchor 放队首，其余 Fisher-Yates 打乱；
 * anchor 为 null 或不在队列里就整体打乱。返回 anchor 是否放到了队首。
 * rest 是新数组，本函数绝不改动 queue。
 */
function buildShuffle(anchor) {
  const anchorId = anchor && anchor.id
  const rest = []
  let head = null
  for (let i = 0; i < queue.length; i++) {
    // 只认第一首同 id 的（队列里不该有重复；真有就当作两首不同条目照常参与乱序）
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

/** 随机模式「下一首」：临时队列 +1；到队尾则重洗一轮（当前曲作锚点）再取第 2 首 */
function shuffleNext(from) {
  const n = shuf ? shuf.length : 0
  if (n === 0) return -1
  if (n === 1) return 0 // 单曲队列：重播本首（与旧行为一致）
  if (from + 1 < n) return from + 1
  const anchored = buildShuffle(cur.id ? cur : null)
  return anchored ? 1 : 0 // 重洗后当前曲在队首，队首那首刚放完 → 取下一首
}

/** 随机模式「上一首」：临时队列 −1；队首再往前绕到队尾（手动上一/下一始终环绕） */
function shufflePrev(from) {
  const n = shuf ? shuf.length : 0
  if (n === 0) return -1
  if (n === 1) return 0
  return from - 1 >= 0 ? from - 1 : n - 1
}

/** 从快照的 id 序列重建临时队列（顺序照旧；队列里没有该 id 的跳过 —— 大歌单窗口裁过界时会丢几首） */
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

/* ---- 上次播放状态：组装快照 → session.js 落盘 ---- */

/** 组装一份快照；没有当前曲就返回 null（不落盘）。posOverride 见 persist 说明 */
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
    playing: isPlaying && !paused, // 仅供日志（恢复态一律暂停，见 session.js）
    queue: q.list,
    index: q.index,
    song: song,
    positionMs: pos,
    src: queueSrc // 队列来源标记（'downloads' 等）：重启恢复后删下载仍能认出这支队列
  }
  // 临时队列（随机顺序）另存 id 序列：体积 ≈ 队列的 1/10，重启后照原顺序接着放
  if (inShuffle()) rec.shuffle = slimShuffle(shuf, index)
  return rec
}

/**
 * 立即落盘一次（不节流）。posOverride：显式指定快照位置 ——
 * 切歌瞬间传 0（新歌还没出声，别把上一首的位置记到新歌头上）、
 * 「播完停下」传 0（恢复时是重播这首，而不是「从末尾立刻结束」）。
 */
function persist(posOverride) {
  const rec = snapshotRecord(posOverride)
  if (!rec) return
  lastSaveAt = Date.now()
  saveSession(rec)
}

/** 兜底存盘（app.js 生命周期回调里调；节流对它无效） */
export function flushNow() {
  persist()
}

/**
 * 「退出时暂停音乐」（config.pauseOnExit，默认开，设置页可关）：退出前调一次，幂等。
 * 必须主动暂停的原因：SoundPlayer 是**独立的系统进程**（guardian_run 守护），
 * 应用退出（closeApp/onDestroy）不会带走它 —— 不 stop 的话音乐会在退出后继续放，
 * 而那时应用已经不在了，没处控制。
 *
 * 走 pause（toggle 的暂停分支）而不是 stopPlay：暂停保留当前进度，
 * 下次打开按 ▶ 从原处续播（stopPlay 会把快照位置记成 0 = 重头放）。
 *
 * 兜底超时 800ms：调用方（index.vue 的退出路径）会 await 它，原生调用万一卡住也不能把「退出」卡死。
 */
export function pauseForExit() {
  if (!config.get('pauseOnExit')) return Promise.resolve(false)
  // 先作废在途的播放启动（playAt / 续播的每个 await 之后都会对 gen，对不上就自己放弃）——
  // 否则「点歌刚发出、还没出声」时退出，那个流程会在我们 stop 之后才把原生播放开起来。
  gen++
  if (!cur.id || paused) return Promise.resolve(false) // 没歌 / 用户本来就暂停着：别动它
  log('player', '退出前暂停: ' + cur.name)
  const job = toggle().then(function () { return true }, function () { return false })
  return Promise.race([job, new Promise(function (res) {
    setTimeout(function () { res(false) }, 800)
  })])
}

/** 墙钟推算当前播放位置；**必须乘倍速**（1.5x 时媒体位置走得比墙钟快） */
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
      requestEnd() // EndChanged 的兜底：事件万一不来，墙钟也会连播
      return
    }
    // 流播起播比本地慢（冷 CDN 实测 ~6s）：出声前挂着「缓冲中...」，
    // 首个 position 事件会清它；事件万一不来，3 秒后也清掉，别一直占着时间位
    if (status === '缓冲中...' && Date.now() - startedAt > 3000) status = ''
    emit()
    // 播放中定期存位置快照（被强杀/待机自动关机时「上次播放状态」最多丢这么久）；
    // 正常退出路径不受它影响 —— 返回键/切后台有 flushNow 精确存（见 app.js）
    const gap = queue.length > BIGQ ? SAVE_MS_BIGQ : SAVE_MS
    if (Date.now() - lastSaveAt >= gap) persist()
  }, 500)
}

/**
 * 统一的出声入口：本地文件与在线直链都走 playFile（直链同样认位置与倍速，实测定案）。
 * locator: 本地绝对路径或 http 直链；kind: 'file' | 'stream'；my: 调用方代次（缺省当前 gen）。
 * 返回 true = 已起播；抛错不 catch，交调用方走回退链。
 * ⚠ 本函数是**破坏性**的：先 stop() 再 playFile —— 失败时旧播放也已经没了。
 */
async function startSource(locator, posMs, kind, my) {
  // 先断掉「自己在播」的守卫：这次 stop() 触发的 EndChanged / 迟到事件必须被忽略
  paused = true
  isPlaying = false
  uuid = ''
  stopTimer()
  await stop()
  if (my !== undefined && my !== gen) return false
  const u = await playFile(locator, posMs || 0, rate)
  if (my !== undefined && my !== gen) return false // 别把别人的任务 uuid 记到自己头上
  uuid = u || ''
  baseMs = posMs || 0
  startedAt = Date.now()
  positionMs = baseMs
  paused = false
  isPlaying = true
  srcMode = kind
  if (kind === 'file') {
    localPath = locator
    status = '' // 本地出声快，状态位直接清（播放页时间位置恢复显示时间）
  }
  // 流播保留当前的「缓冲中...」：出声由首个 position 事件确认（tick 另有 3s 看门狗）
  startTimer()
  emit()
  return true
}

/**
 * 下载进度回调工厂（限流 ~500ms 一次，别把渲染打爆）。
 *   - 只在「还是当前曲目」时更新，切歌后旧下载的进度直接忽略
 *   - showStatus=true 才占用播放页的时间位置（**用户正在等**的下载）；
 *     后台补缓存（音乐已经在放）只更新 hint，不能把时间显示挤掉
 */
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
    hint = '缓冲中' + mb + ' (' + Math.round(done / 1024) + 'KB)' // 详细（含速度）走 hint/日志
    emit()
  }
}

/**
 * 「需要当前曲目的完整本地文件」的兜底：有缓存直接给；没有就等后台缓存下完（hint 亮「缓冲中...」）。
 * 起降级为兜底角色（直链拿不到 / 流播起播失败才用），正常 seek/续播/改倍速走 reopenAt。
 * 注意：流播途中缓存失败会在这里重试（ensureCached 不缓存失败结果）。
 */
async function needLocal() {
  if (localPath) return { ok: true, path: localPath }
  if (!cur.id) return { ok: false, error: '没有歌曲' }
  const id = cur.id
  hint = '缓冲中...'
  status = '缓冲中 0%'
  loading = true
  emit()
  const r = await ensureCached(cur, null, { onProgress: progressStatus(id, true) })
  // 等待期间切歌了：别把上一首的路径写到当前曲头上（loading 也别动，新流程自己在管）
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

/**
 * 当前曲的播放直链（内存缓存 + 在途合并）：
 *   - 同曲同档且 URL_TTL_MS 内 → 直接复用（seek / 续播 / 改倍速都吃这一份，不重复发请求）
 *   - 换歌 / 过期 / 换播放档位 → 重新解析（resolveUrl 自带档位降级链）
 *   - 失败返回 null（不缓存失败结果）；VIP/受限歌也是 null
 */
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

/**
 * 后台补**播放缓存**（流播路径也要把整首存下来 —— 保留「听一次就缓存」的既有行为）。
 * 走 play 通道：落到 `$dataDir/cache`、按**播放音质**、受「缓存上限」LRU 滚动、
 * **不会**出现在「本地下载」里（缓存与下载分家）。
 * KICK_MS 内同曲只踢一次（反复 seek 别反复入队/反复挂进度钩子）。
 * 不喂直链：让下载层自己重新解析（播放档的直链可能已经太老）。
 */
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

/**
 * seek / 续播（▶）/ 改倍速的统一流程（这三处以前各写一遍 needLocal + startPlay）：
 *   有本地文件（localPath 或磁盘缓存）→ 本地定位；没有 → 直链流式定位（同时后台补缓存）；
 *   直链也拿不到 → 回退旧的「等整首下载」；流播起播失败 → 同样回退等下载。
 * 入口 ++gen：用户动作里最后一次赢（连点 seek / seek 撞暂停都不会被旧流程抢回去）。
 * 返回是否成功出声；hint 文案由 label 给。
 */
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
        kickCache() // 流播也要补缓存（否则只听流、永远不缓存）
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

  // 流播起播失败 → 回退等缓存（保住旧路径「一定能播」）
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

/**
 * 播完一首后按循环模式决定下一步（对齐 PenMusic 的 stepIndex(auto=true)）：
 *   列表循环 → 下一首（到尾回第一首）
 *   顺序播放 → 下一首；已是最后一首则停
 *   单曲循环 → 重播本首
 *   随机播放 → 临时队列的下一首（到队尾 = 一轮放完 → 重洗一轮接着放，见 shuffleNext）
 */
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
  // 列表循环 / 顺序播放：还有下一首就往下走
  if (index < total - 1) {
    await playAt(index + 1)
    return
  }
  // 已是最后一首：列表循环绕回开头，顺序播放停下
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
  persist(0) // 播完停下：位置存 0，恢复后按 ▶ 是重播这首，而不是「从末尾立刻结束」
}

/**
 * 播放队列第 i 首：缓存命中 → 直接播本地；否则直链流式播放 + 后台缓存。
 * 每次进入都 `++gen`：切歌后旧流程的任何 await 回来都会被作废（防止连点跑偏）。
 */
async function playAt(i) {
  const s = activeList()[i] // i 是「生效队列」的下标（随机模式 = 临时队列；页面显示的也是它）
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
  uuid = '' // 旧任务即将被 stop，事件先断掉
  cacheKick = { id: '', at: 0 } // 换歌重置补缓存备忘
  hint = '准备中...'
  status = '准备中...'
  // 切歌即重置时钟、停掉旧 tick：出声（startSource 会重启计时器）之前的
  // 空窗里，旧 baseMs/startedAt 会算出上一首的进度，甚至对新歌提前触发「播完」判定
  stopTimer()
  baseMs = 0
  startedAt = Date.now()
  positionMs = 0
  emit()
  persist(0) // 上次播放状态：切歌瞬间就记上新歌（位置 0），即便随后播放失败也算「选过它」
  // 搜索接口不带封面（只有 picId）、本地下载页的条目可能缺时长 —— 都用详情接口补；带竞态校验
  if (!s.cover || !s.durationMs) {
    getSongDetail(s.id)
      .then(function (d) {
        if (!d) return
        enrich(d) // 历史条目补封面等缺失字段（仅该 id 已在历史里时生效）
        if (cur.id !== d.id || my !== gen) return
        const needCover = !cur.cover && d.cover
        const needDur = !durationMs && d.durationMs
        if (!needCover && !needDur) return
        if (needCover) cur = d
        else cur = Object.assign({}, cur, d) // 只补时长：别丢 cur 已有字段
        // **模块级 durationMs 也要补**：startTimer 的播完判定、seekTo、快照/进度环都用它 ——
        // 不补的话「从本地下载页点播缺时长的老缓存」永远不自动连播、进度条也拖不动
        if (needDur) durationMs = d.durationMs
        emit()
        persist() // 快照跟着补上封面/时长（恢复后首页卡片才有图）
      })
      .catch(function () {})
  }

  // 1) 本地缓存优先（秒开，且可定位/可暂停续播）
  const hit = await cachedPath(s.id)
  if (my !== gen) return
  if (hit) {
    localPath = hit
    loading = false
    hint = '本地缓存播放'
    await startSource(hit, 0, 'file', my)
    log('player', '播放中(缓存): ' + s.name + ' rate=' + rate + ' mode=' + loopMode)
    if (cur.id === s.id) record(cur) // 播放历史（去重；续播/seek/改倍速不走这里）
    touchPlayCache(s.id) // 记「最近播放」：缓存上限 LRU 按它决定先淘汰谁（下载目录的条目不受影响）
    return
  }

  // 2) 取直链 —— 用「播放音质」档（ensureStreamUrl 内部按 currentQuality('play') 解析）；
  //    同曲 10 分钟内的直链走内存复用（seek/续播/改倍速也都吃这一份）。
  //    下面第 4 步的播放缓存也是播放档，所以这份直链可以直接复用给缓存层
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

  // 3) 流式播放：playFile 直链同样认位置与倍速（实测），不再有「倍速≠1 先缓存」
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
    if (cur.id === s.id) record(cur) // 播放历史（去重）
  }

  // 4) 后台**播放缓存**（落到 cache/、按播放音质）：本地 seek/续播要用，也让下次播放秒开。
  //    ⚠ 它**不是**「下载」—— 不显示在本地下载里，且受设置项「缓存上限」按播放顺序 LRU 滚动。
  //    showStatus 只在「没走成流播、用户正等着下载出声」时为真。
  //    缓存档 = 播放档，这份直链天然可复用；只有太老（>2 分钟，首包会 403）时才传 null
  //    让下载层自己重解析。
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

  // 没走成流播：等缓存完成后本地播放（下载期间状态位显示进度）
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
  if (cur.id === s.id) record(cur) // 播放历史（去重）
}

async function toggle() {
  if (!cur.id) return
  if (paused) {
    // 续播：有本地用本地、没有就直链定位起播（起不再等整首下载）
    const ok = await reopenAt(positionMs, '继续播放')
    if (ok) persist()
  } else {
    const pos = positionMs
    paused = true
    isPlaying = false
    gen++ // 作废在途的启动流程（seek/续播回来时别把播放又开起来）
    uuid = '' // 这次 stop 的结束事件不该被认成「播完」
    status = ''
    await stop()
    baseMs = pos
    stopTimer()
    hint = '已暂停 @' + fmtDur(pos)
    emit()
    persist() // 暂停点就是下次启动的续播位置
  }
}

async function stopPlay() {
  stopTimer()
  gen++ // 作废在途的启动流程（别在停止后又把播放开起来）
  uuid = ''
  paused = false
  isPlaying = false
  positionMs = 0
  baseMs = 0
  status = ''
  await stop()
  hint = '已停止'
  emit()
  persist() // 停在 0（上面刚置零）：恢复后按 ▶ 是重播这首
}

/**
 * 跳到当前曲目的某个位置。原生在线流现在可直接定位（playFile(url, pos, rate) 实测定案），
 * 所以：有本地文件用文件、没有就直链流式定位；直链拿不到才回退等缓存（见 reopenAt）。
 */
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

/**
 * 手动上一/下一首：**始终环绕**（与自动连播不同；对齐 PenMusic：
 * 顺序播放只在「自然播完到尾」时停，手动点则从尾绕到首）。
 */
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

/** 设置队列并开始播放第 i 首（列表页点歌用）；随机模式下重洗临时队列（点的那首作锚点放队首）。
 *  src：队列来源标记（可选）——目前只有 'downloads'（本地下载页），删下载曲目时按它决定
 *  要不要同步清理队列（见 downloads.vue 的 doDeleteSelected）；其它页面不传 */
function playList(songs, i, src) {
  queue = songs || []
  queueSrc = src || ''
  shuf = null // 换队列 = 旧临时队列作废（随机模式下下面重建）
  const at = i || 0
  if (loopMode === 'shuffle') {
    buildShuffle(queue[at])
    return playAt(0)
  }
  return playAt(at)
}

/**
 * 队列被清空 → 播放器回到**空态**（编辑队列允许清空）。
 *
 * 与 stopPlay 不是一回事：stopPlay 保留曲目、只把位置归零（按 ▶ 是重播这首）；
 * 这里连 `cur` 一起清掉 —— 队列里已经没有这首歌了，首页卡片就该写「未在播放」、
 * 播放页也回空（`hasTrack=false`）。
 *
 * 三件必须做的事：
 *   ① `gen++` 作废在途的起播流程、`uuid=''`（这次 stop 抛出的结束事件不能被认成「播完」→ 连播）
 *   ② **删掉 storage 里的会话快照**：不删的话下次启动 `loadLastState()` 会把刚清空的队列
 *      恢复回来，用户看到「清完又回来了」
 *   ③ emit 之后再 stop：订阅者（首页卡等）先拿到空态，随后原生播放器才停
 */
function clearPlayback(hintText) {
  gen++
  uuid = ''
  stopTimer()
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

/**
 * 只换当前曲、**不出声**（移除在播曲后接下一首；暂停态走这条）。
 * 与 playAt 的区别：playAt 立刻起播；这里把曲目与位置摆好就停住，按 ▶ 才从头放 ——
 * 用户本来没在听，不能因为「删了一首」就突然出声。
 */
function switchTo(i) {
  const s = activeList()[i]
  if (!s) return false
  gen++ // 作废在途的起播流程（缓冲中的那首已经不属于队列了）
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

/**
 * 在 `al`（删除**前**的生效队列）里找「第 from 首之后第一个活下来的」：
 * 先往后找，后面没了再绕回队首。移除在播曲后的「下一首」就是它
 * （环绕语义与手动 next() 一致：手动上一/下一始终环绕）。
 */
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

/**
 * 从当前播放队列移除若干首（播放列表页多选「移除」用）。
 *   - **允许移除正在播放的那首**：删完接着播「原来的下一首」
 *     （当前曲之后第一个活下来的，后面没了就绕回队首；返回的 `switched=true`）。
 *     当时在出声就继续出声（走 playAt），当时是暂停态就只换曲不播（走 switchTo）。
 *   - **允许把队列清空**：删完一首不剩 → 停播并回空态（`emptied=true`，见 clearPlayback）
 *   - 原始队列与随机临时队列同时删；在播曲没被删时 index 按它在「生效队列」里的新位置重算
 *   - 队列变了即时落盘（快照）并 emit，队列页/播放页立刻可见
 * 返回 { ok, removed, skipped, emptied, switched }
 */
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
  // 队列被清空：停播 + 回空态（index 重算已无意义，clearPlayback 内部统一处理）
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
  // 在播曲还在 → index 按它在生效队列里的新位置重算；
  // 万一找不到（异常态）就夹紧到合法范围，别让 playAt/队列页读飞
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

/**
 * 把若干首**插到当前曲之后**（「下一首播放」）。
 *
 * 与 playList 的区别：不动在播曲、不改队列顺序，只把这几首塞进「下一首」的位置；
 * 队列里已有的同 id 曲目不重复插（返回 `dup` 计数，页面据此提示「已在队列里」）。
 *
 * 两条队列要一起改，否则「下一首」会名不副实：
 *   - 随机模式：`index` 指向**临时队列** shuf，插在 index+1 才是「马上播」；
 *     原始队列 queue 里则插在在播曲之后（切回顺序模式时顺序仍正确）。
 *   - 其它模式：index 指向 queue，插在 index+1 之后 index 不变。
 *
 * 队列为空时没有「下一首」可插 → 直接起播这几首（等价于点歌，不算插入）。
 * 返回 { ok, added, dup, played }
 */
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

/* ---- 倍速 ---- */

/** 改倍速：按当前位置用当前源（本地文件或直链）重开（playFile 第三参数，在线倍速实测可用），持久化 */
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

/* ---- 循环模式 ---- */

/**
 * 切循环模式。进出随机**只重排播放顺序、不动正在放的歌**（不重开播放，只挪 index）：
 *   进随机 → 打乱临时队列（当前曲作锚点留在队首，index 归位到 0）
 *   出随机 → 丢掉临时队列，按 id 在原始队列里找回当前曲的位置
 */
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
      persist() // 顺序变了 → 快照跟上（否则异常退出后恢复的是旧顺序）
      return
    }
  }
}

/** 按 MODES 顺序循环到下一个模式（播放页那个文字按钮用） */
async function cycleLoopMode() {
  let i = 0
  for (let k = 0; k < MODES.length; k++) {
    if (MODES[k].key === loopMode) i = k
  }
  await setLoopMode(MODES[(i + 1) % MODES.length].key)
}

/** 启动时从 config 恢复设置（主页 boot() 里调一次即可，幂等） */
export function loadPlayerSettings() {
  const r = config.get('rate')
  if (typeof r === 'number' && r > 0) rate = r
  const m = config.get('loopMode')
  for (let i = 0; i < MODES.length; i++) {
    if (MODES[i].key === m) loopMode = m
  }
  log('player', '设置恢复 rate=' + rate + ' mode=' + loopMode)
}

/**
 * 启动时恢复「上次播放状态」（boot 里 await，幂等）——快照由 session.js 落盘。
 * 恢复态**一律暂停**：队列/当前曲/进度都回到内存，
 * 首页卡片与播放页立刻显示上次的歌，但**不出声**；按 ▶ 才走 toggle() 的续播分支
 * （必要时先补齐缓存，见 needLocal）。
 * 位置落在末尾 2 秒内的按 0 处理（多半是「快播完时被关机/强杀」，恢复成立刻结束没有意义）。
 */
export async function loadLastState() {
  const s = await loadSession()
  if (!s) {
    log('player', '上次播放状态: 无')
    return false
  }
  queue = s.queue
  queueSrc = s.src || '' // 队列来源标记（老快照没有该字段 → ''）
  shuf = null
  // 随机模式：按快照存的 id 序列重建临时队列（顺序与退出前一致，接着放没放完的那些）；
  // 老快照没有该字段、或大歌单窗口裁得只剩一两首时，退化为「以当前曲为锚点重洗」
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
  localPath = '' // 缓存/直链一律现查（reopenAt / playAt），别信上次的快照
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
  state: state,
  on: on,
  off: off,
  flushNow: flushNow,
  pauseForExit: pauseForExit
}
