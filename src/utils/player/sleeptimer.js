/**
 * 定时播放（睡眠定时）—— 模块级单例，跨页面 / 跨子面板存活。
 *
 * 接口（唯一写入口在 components/player/TimerPanel.vue；页面只用 on/state 读 active）：
 *   sleepTimer.state() -> { active, remainMs, endsAt, untilText, keepTrack }
 *   sleepTimer.on(fn) / off(fn)              // 每秒广播一次；start/cancel/到点复位时立即广播
 *   sleepTimer.start(minutes, keepTrack?)    // 分钟 1..999；keepTrack 缺省沿用当前设置
 *   sleepTimer.cancel()                      // 取消并复位（不暂停播放）
 *   sleepTimer.setKeepTrack(on)              // 设置「播完整首」开关（影响当前/下一次定时）
 *
 * 到点行为（两种）：
 *   - 不播完整首（keepTrack=false）：到点若在播就 player.toggle() 暂停，然后复位；
 *   - 播完整首（keepTrack=true）  ：到点先不暂停，记下当前曲 id 继续放；等播放器报出「换曲」
 *     （本曲已播完、player 自动连播到下一首）时立刻把下一首拦在起播前并复位 ——
 *     于是「播完整首」= 听完当前这首再停，而不是到点立刻切歌。
 *
 * 设计取舍（别改成持久化、别挪进 boot.js）：
 *   - 不落配置：定时是一次性动作，应用重启即失效是**预期行为**（boot.js 不该知道它）；
 *   - interval 由本模块自己管：start 开启，cancel / 到点 / 复位一律 clearInterval，避免泄漏；
 *   - `player.on` 订阅**只在模块加载时注册一次、永不注销**：模块要跨页面存活（用户切到别的页面
 *     时定时还得继续跑），所以订阅不能跟着组件 unmount 走；
 *   - 精度 1s 就够（面板只显示 H:MM:SS），不做更高频补偿；应用切后台 JS 冻结期间不跑，
 *     回前台后第一次 tick 按 endsAt 墙钟判定，该到点会立刻到点。
 *
 * 未做（按契约范围外，见汇报）：不持久化、不接管退出应用、不感知蓝牙/耳机拔出。
 */
// 与 player.js 同目录；契约指定写 ../player/player.js（相对本文件归一后即本目录的 player.js）
import { player } from '../player/player.js'
import { log } from '../log.js'

const MIN_MS = 60000
const TICK_MS = 1000
const MIN_MINUTES = 1
const MAX_MINUTES = 999
/**
 * 「同一首从 0 重播」的判定阈值（ms）：单曲循环 / 单曲队列播完时 player 会以**同一个 id**
 * 从 0 重播，那一刻的快照是 positionMs=0 且「没在播」。自然播完（顺序播放最后一首）的位置
 * 停在曲末，用这个阈值就能把两种「同一首 id 没变但停了」区分开。
 */
const TAIL_HEAD_MS = 1000

/* ---- 模块级状态（单例） ---- */
let active = false // 定时是否在跑（含「播完整首」的曲末等待段）
let endsAt = 0 // 到点墙钟时间戳（ms）
let keepTrack = false // 「播完整首」设置：跨定时保留，cancel/到点都不重置
let ticker = null // 1s 广播 interval；到点/取消/复位一律清掉
let tailOn = false // 已到点、正在等当前曲播完（只有 keepTrack=true 会进这个段）
let tailId = '' // 曲末等待段锁定的当前曲 id
const subs = [] // 状态订阅者（页面 + 定时面板）

/* ---- 小工具 ---- */
function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

/** 本地墙钟 HH:MM（「播放至」用；不补秒，设计稿就是 16px 的 HH:MM） */
function clockText(ms) {
  const d = new Date(ms)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function state() {
  const remain = active ? Math.max(0, endsAt - Date.now()) : 0
  return {
    active: active,
    remainMs: remain,
    endsAt: active ? endsAt : 0,
    untilText: active ? clockText(endsAt) : '',
    keepTrack: keepTrack
  }
}

/** 广播当前状态。订阅者回调全包住：一个页面/面板抛错不能影响其他人，更不能打断定时。 */
function emit() {
  const s = state()
  for (let i = 0; i < subs.length; i++) {
    try {
      subs[i](s)
    } catch (e) {}
  }
}

function stopTicker() {
  if (ticker) {
    clearInterval(ticker)
    ticker = null
  }
}

function startTicker() {
  stopTicker()
  ticker = setInterval(onTick, TICK_MS)
}

/**
 * 调 player.toggle() 暂停：平台**没有 pause**，暂停 = toggle 的「暂停」分支。
 * 调用方必须先确认播放器不处于 paused（paused 时 toggle 走续播分支，会把音乐重新放起来）。
 * 后台动作：异步失败吞掉，别把未处理的 rejection 抛到框架的 onAppError。
 */
function pausePlayer() {
  try {
    const p = player.toggle()
    if (p && p.catch) p.catch(function () {})
  } catch (e) {}
}

/**
 * 收尾：可选暂停 → 复位 → 广播一次。
 * wantPause=false 用于「播放本来就已经停了」的场合（自然播完 / 被外部 stop），别再 toggle
 * 把停着的播放续起来。wantPause=true 时也只在非暂停态才真的 toggle（见 pausePlayer 注释）。
 */
function finishNow(wantPause) {
  if (wantPause) {
    const st = player.state()
    if (st && !st.paused) pausePlayer()
  }
  const was = active
  active = false
  endsAt = 0
  tailOn = false
  tailId = ''
  stopTicker()
  if (was) log('timer', wantPause ? '到点，已暂停播放' : '到点，播放已停，复位')
  emit()
}

/**
 * keepTrack=true 到点：进入「等本曲播完」段。
 * 定时到点时如果根本没在播（用户已经暂停 / 没有歌），就没有「播完整首」可等，直接收尾。
 */
function beginTail() {
  const st = player.state()
  const id = st && st.cur && st.cur.id
  const playing = !!(st && st.isPlaying && !st.paused)
  if (!playing || !id) {
    // 没在出声：两种可能都要收尾，且都要可能「拦一次」——
    //   ① 用户已暂停（paused=true）：finishNow 的守卫会跳过 toggle，只复位；
    //   ② 恰好卡在切歌/起播途中的瞬时态（isPlaying=false 但 paused=false）：finishNow 会
    //      toggle 进暂停分支作废在途起播，否则定时到点后那首歌还会照样响起来。
    finishNow(!st.paused)
    return
  }
  tailOn = true
  tailId = String(id)
  log('timer', '到点，等本曲播完 id=' + tailId)
  // active 仍为 true、remainMs 为 0：面板保持在倒计时态，等曲末收尾时再回选时长态
  emit()
}

function onTick() {
  if (!active) {
    stopTicker() // 兜底：任何路径漏了清 interval 都在这里收口
    return
  }
  if (Date.now() < endsAt) {
    emit()
    return
  }
  // 到点：interval 先停（不播完整首就收尾了；播完整首则由 player 事件推进曲末段）
  stopTicker()
  if (keepTrack) beginTail()
  else finishNow(true)
}

/**
 * 播放器状态订阅（模块加载时注册一次、长期保留）。
 * 只在「到点后的曲末等待段」里干活；其余时间第一行就返回，回调频率（约 2 条/秒）无副作用。
 */
function onPlayer(s) {
  if (!active || !tailOn) return
  const id = s && s.cur ? s.cur.id : ''
  if (!id) {
    // 队列被清空（player 连 cur 一起清掉）：没有「这一首」可等了，直接复位
    finishNow(false)
    return
  }
  if (String(id) !== tailId) {
    // 换曲了 = 当前曲已播完、player 自动连播到下一首。**立刻**拦下这次起播：
    // player 的 playAt 一进来就 emit（此时 isPlaying 已被置 false、还没出声），所以不能按
    // isPlaying 判断；toggle 走「暂停」分支时会 gen++ 作废这次在途起播，新曲停在 0 位。
    // 若是用户暂停着手动切歌（paused=true），toggle 会变续播 —— 交给 finishNow 里的守卫跳过。
    finishNow(true)
    return
  }
  if (!s.isPlaying && !s.paused) {
    // 同一首 id 没变却「停」了，两类（用位置区分）：
    //   ① 播放自然停止（顺序播放最后一首播完 / 被外部 stop）：本来已静音，只复位；
    //   ② 单曲循环（或单曲队列）：播完立刻以同一 id 从 0 重播 —— playAt 的 emit 里
    //      positionMs=0 且尚未出声，必须 toggle 拦住，否则会一直循环下去、定时等于没生效。
    finishNow((s.positionMs || 0) < TAIL_HEAD_MS)
  }
}

/* ---- 对外接口 ---- */

/**
 * 开始定时。minutes 分钟（1..999）；keepTrack 传 undefined 表示沿用当前设置
 * （设计稿的选时长态/自定义态没有复选框，启动时只能沿用）。返回是否成功。
 */
function start(minutes, keepTrackArg) {
  const n = Number(minutes)
  if (!isFinite(n)) return false
  const m = Math.round(n)
  if (m < MIN_MINUTES || m > MAX_MINUTES) return false
  if (typeof keepTrackArg !== 'undefined') keepTrack = !!keepTrackArg
  stopTicker()
  active = true
  endsAt = Date.now() + m * MIN_MS
  tailOn = false
  tailId = ''
  startTicker()
  log('timer', '开始定时 ' + m + ' 分钟，播完整首=' + keepTrack + '，到点 ' + clockText(endsAt))
  emit()
  return true
}

/** 取消定时（不暂停播放）。返回之前是否真的在跑。 */
function cancel() {
  if (!active) return false
  active = false
  endsAt = 0
  tailOn = false
  tailId = ''
  stopTicker()
  log('timer', '取消定时')
  emit()
  return true
}

/** 切「播完整首」开关。已经在曲末等待段里再关掉 → 立刻按到点处理，否则要白等一整首。 */
function setKeepTrack(on) {
  keepTrack = !!on
  if (active && tailOn && !keepTrack) {
    log('timer', '关闭播完整首：曲末等待改为立即暂停')
    finishNow(true)
    return
  }
  emit()
}

function on(fn) {
  // 判重：页面/面板 mounted 可能被执行两遍（平台会挂两遍），同一个回调只登记一次
  if (typeof fn === 'function' && subs.indexOf(fn) < 0) subs.push(fn)
  return fn
}

function off(fn) {
  const i = subs.indexOf(fn)
  if (i >= 0) subs.splice(i, 1)
}

/* 订阅播放器状态：只注册一次、永不注销（见文件头「设计取舍」） */
player.on(onPlayer)

export const sleepTimer = {
  state: state,
  on: on,
  off: off,
  start: start,
  cancel: cancel,
  setKeepTrack: setKeepTrack
}
