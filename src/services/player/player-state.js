// 播放器（拆分自 player.js）：模块级可变状态 S + 快照/广播/计时器 + 队列读视图 + 时间常量。
// 播放器状态原本是 28 个模块级可变绑定，被原文件里所有函数共享；ES module 在小程序里是同一实例，
// 收进 S 之后各拆分文件 import 的都是这一份，不会出现两份副本。

import { log } from '../../core/infra/log.js'
import { setCacheProtectHook } from './cache.js'
import { setFileChangedHook } from './download.js'
import { MODES, modeInfo } from './player-modes.js'

export const S = {
  // 原始队列：随机模式也绝不重排它（打乱的是下面那份临时队列）
  queue: [],
  
  // 队列来源标记（playList 第三参）：'downloads' = 从「本地下载」页建的队列 —— 删下载曲目时只清理这种队列；
  // 随会话快照持久化（session.js 的 src 字段），重启恢复后仍认得
  queueSrc: '',
  

  // 随机模式的临时队列（queue 的乱序副本，同一批歌曲对象）；非随机模式为 null
  shuf: null,
  
  // 当前曲在**生效队列**里的下标（随机模式指 shuf，其它模式指 queue）
  index: -1,
  
  // 队列代次：换队列就自增；后台补齐起播时记下代次，对不上 = 用户已换队列，这批歌直接丢
  qgen: 0,
  cur: {},
  isPlaying: false,
  paused: false,
  hint: '',
  // 短状态（「缓冲中 42%」「歌曲受限」…）—— 会显示在播放页时间位置，只放短文案
  status: '',
  
  // '' | 'file' | 'stream'：当前出声的是本地文件还是在线流
  srcMode: '',
  
  // 当前曲目已确认完整的本地文件（流播途中缓存完成才补上）
  localPath: '',
  
  // 当前原生任务的 uuid（playFile 返回值）：媒体事件按它过滤，stop/结束即清
  uuid: '',
  
  // 当前曲直链的内存缓存（单条；TTL 见 URL_TTL_MS）
  streamUrl: null,
  streamUrlJob: null,
  cacheKick: { id: '', at: 0 },
  endAt: 0,
  
  // 播放代次：playAt 每次 +1，异步流程回到现场前对不上就作废
  gen: 0,
  startedAt: 0,
  baseMs: 0,
  positionMs: 0,
  durationMs: 0,
  loading: false,
  timer: null,
  rate: 1.0,
  loopMode: MODES[0].key,
  lastSaveAt: 0,
  subs: [],
}



// 播放中位置快照的节流间隔（切歌/暂停/seek/退出这些动作即时存，不受它限制）；
// 队列很大时退回 15 秒：快照几十 KB，别每 5 秒重写一次整份 preferences.json。
// BIGQ=200 首 ≈50KB（history.js 经验值：60KB 级写入可能有可感卡顿）
export const SAVE_MS = 5000 
export const SAVE_MS_BIGQ = 15000 
export const BIGQ = 200

// URL_TTL_MS：直链内存缓存有效期（平台 expi≈1200s，留一半余量）
// URL_FRESH_MS：只有很新的直链才转交下载层复用（太老的首包会 403）
// KICK_MS：后台补缓存的去重窗口（反复 seek 别反复入队）
// NEAR_END_MS：结束事件判定「临近结尾」的容差（区分自然播完与外部 stop）
// END_DEDUP_MS：播完处理去重窗口（EndChanged 与墙钟判定可能双双触发）
export const URL_TTL_MS = 600000 
export const URL_FRESH_MS = 120000 
export const KICK_MS = 60000 
export const NEAR_END_MS = 3000 
export const END_DEDUP_MS = 1500


// 本地文件被删除/升质替换时的自清：当前曲的 localPath 一旦指向已失效/已被顶替的文件，
// seek/续播/改倍速就会用错文件。钩子在下载 promise resolve **之前**触发，所以各调用方随后写
// localPath 的顺序不受影响；正在播的 fd 不受删文件影响，照常放到段尾
setFileChangedHook(function (id) {

  // 空 id = 整库失效（存储页清空缓存）→ 无论播的是哪首都清
  if (!id || (S.cur.id && String(S.cur.id) === String(id))) {
    S.localPath = ''
    log('player', '本地文件变更，清 localPath id=' + (id || '全部'))
  }
})

// 「缓存上限」LRU 的保护名单：正在播放的那首绝不能被回收掉
// （文件一旦没了，正在播的 fd 虽还在，但 seek/续播/改倍速会立刻失效）。
// 与 setFileChangedHook 同一套「注册钩子」风格，避免 cache.js 反过来 import 播放器
setCacheProtectHook(function () {
  return S.cur.id ? [String(S.cur.id)] : []
})

function snapshot() {
  const mi = modeInfo(S.loopMode)
  return {

    // **生效队列**（随机模式 = 打乱后的临时队列）：index 与它配套，队列页显示/点行跳播都按它来
    queue: activeList(),
    queueSrc: S.queueSrc,
    index: S.index,
    cur: S.cur,
    isPlaying: S.isPlaying,
    paused: S.paused,
    hint: S.hint,
    status: S.status,
    positionMs: S.positionMs,
    durationMs: S.durationMs,
    loading: S.loading,
    srcMode: S.srcMode,
    cached: !!S.localPath,
    rate: S.rate,
    loopMode: S.loopMode,
    modeLabel: mi.label,
    hasTrack: !!S.cur.id
  }
}

export function emit() {
  const s = snapshot()
  for (let i = 0; i < S.subs.length; i++) {
    try {
      S.subs[i](s)
    } catch (e) {}
  }
}

export function stopTimer() {
  if (S.timer) {
    clearInterval(S.timer)
    S.timer = null
  }
}

// 随机播放用「把原始队列整体打乱成临时队列」而非每首随机挑下一首：一轮之内每首恰好放一次，
// 走到队尾（一轮放完）再重洗一轮、仍以当前曲为锚点；原始队列不动，切回其它模式按 id 重定位 index 即恢复原顺序
export function activeList() {
  return S.loopMode === 'shuffle' && S.shuf && S.shuf.length ? S.shuf : S.queue
}

export function inShuffle() {
  return !!(S.loopMode === 'shuffle' && S.shuf && S.shuf.length)
}

export function state() {
  return snapshot()
}

export function on(fn) {
  S.subs.push(fn)
  return fn
}

export function off(fn) {
  const i = S.subs.indexOf(fn)
  if (i >= 0) S.subs.splice(i, 1)
}