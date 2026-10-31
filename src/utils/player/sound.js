/**
 * 音频播放封装 —— 全工程唯一直接使用原生 soundPlayer 模块的地方。
 *
 * 平台事实（探针两轮实测，证据见 docs/播放与定位能力.md）：
 *   const { SoundPlayer } = await import('soundPlayer')   // 裸模块名可用
 *   const sp = new SoundPlayer()
 *   sp.playFile(fileName, positionMs, rate, interruptPowerOff, reportPosition) -> 任务 UUID
 *     - **fileName 可以是本地文件，也可以是 http 直链**（引擎 fileExists 判断：
 *       本地直开 / URL 走流式源，重连发 `Range: bytes=` 拿 206 从指定位置续播）；
 *     - **position(ms) 与 rate 在线同样生效**（实测 60s 起播、1.5x 倍速）；
 *     - 第 5 参 reportPosition 必须 **true**，守护进程才上报进度/时长事件（早期探针传 false，
 *       所以当时媒体事件不触发）。
 *   sp.stop() / sp.quickStop() / sp.playMediaSection(json)（段播放；字段名 reportPostion
 *   少一个 i 是平台原文拼写）
 *
 * 媒体事件（mediaPlayerPositionChanged / DurationChanged / ProgressChanged /
 * EndChanged / EndWithErrorChanged）必须用**信号对象 .on(cb)** 订阅（属性赋值不触发），
 * 回调形参（position 已实证）：(uuid, 毫秒值)。
 * ⚠️ SoundPlayer 是**全系统单例进程**：事件是全服务广播（别的应用/服务在播什么也会收到），
 *    调用方必须按 playFile 返回的 uuid 过滤（player.js 的守卫就是这么写的）。
 *
 * 用法：player.js 模块加载时 `bindEvents({...})` 登记回调（同步、幂等）；
 * 真正的 .on() 在实例创建后由 getInst() 自动补挂。
 */
import { log } from '../log.js'

let inst = null
let handlers = null
const wired = {} // 已挂上的事件名（幂等标记）

const EVENTS = [
  'mediaPlayerPositionChanged',
  'mediaPlayerDurationChanged',
  'mediaPlayerProgressChanged',
  'mediaPlayerEndChanged',
  'mediaPlayerEndWithErrorChanged'
]

/** 实例就绪后把登记的回调挂到信号对象上（幂等；`.on` 才是可用姿势） */
function wireIfReady(sp) {
  if (!sp || !handlers) return
  let ok = 0
  for (let i = 0; i < EVENTS.length; i++) {
    const n = EVENTS[i]
    const h = handlers[n]
    if (typeof h !== 'function' || wired[n]) continue
    try {
      const sig = sp[n]
      if (sig && typeof sig.on === 'function') {
        sig.on(function () {
          // 事件派发里抛异常会污染框架的 onAppError 通道，这里全包住
          try {
            h.apply(null, arguments)
          } catch (e) {}
        })
        wired[n] = 1
        ok++
      }
    } catch (e) {}
  }
  if (ok) log('sound', '事件订阅 ' + ok + ' 项')
}

async function getInst() {
  if (!inst) {
    const m = await import('soundPlayer')
    const M = (m && m.default) || m
    const K = M.SoundPlayer || M
    inst = new K()
    wireIfReady(inst)
  }
  return inst
}

/** 播放本地文件或直链；positionMs 起始偏移（ms）、rate 倍速；返回任务 uuid（事件按它过滤） */
export async function playFile(fileName, positionMs, rate) {
  const sp = await getInst()
  const pos = typeof positionMs === 'number' ? positionMs : 0
  const r = typeof rate === 'number' ? rate : 1.0
  return sp.playFile(fileName, pos, r, true, true)
}

export async function stop() {
  const sp = await getInst()
  return sp.stop()
}

/**
 * 登记媒体事件回调（同步、幂等；实例还没建就先存着，getInst 时补挂）：
 *   bindEvents({ mediaPlayerPositionChanged: fn(uuid, ms), ... })
 * ⚠ 回调触发频率可达 20~25 条/秒 —— 里面禁止打日志 / 触发重渲染，只做轻量状态更新。
 */
export function bindEvents(h) {
  handlers = h || {}
  wireIfReady(inst)
}
