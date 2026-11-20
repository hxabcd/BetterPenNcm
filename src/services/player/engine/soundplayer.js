/**
 * SoundPlayer 适配器 —— 把平台（`$falcon.jsapi.soundPlayer`，底层是 DAL 的 YMediaPlayer）
 * 翻译成 engine/index.js 定义的干净端口。
 *
 * ## 它负责吞掉的三件脏事
 *
 * 1. **uuid 过滤**：SoundPlayer 是全系统单例，事件全服务广播（别的应用/服务在播什么也会收到）。
 *    这里保留当前会话的 uuid，不匹配的一律丢弃，上层再也不用认识 uuid。
 * 2. **stop() 会派发结束/错误事件**：这个平台的 stop 会发 `EndChanged` 和
 *    `EndWithErrorChanged`。上层只要调了 stop()，这些事件就不该被当成「播完了」。
 *    这里用 `expectingStopAt` 时间窗把窗口内的事件直接吞掉 —— 上层因此不再需要
 *    `paused` 兼职「保护位」（现在 startSource 里那句 `paused = true` 就是在干这个）。
 * 3. **事件实参形状**：position 的 (uuid, ms) 是实证过的，duration / end / error 的形状
 *    在固件升级后可能变。容错解析（pickUuid / lastNum）只在这里出现一次。
 *
 * ## 依赖
 *
 * 需要 sound.js 提供 `subscribe(fn)` 多播（fn(name, args)）。
 * 现在 sound.js 只有一个 handlers 槽位、且已被 player.js 占用，所以接线前先做
 * 《音频引擎分层设计.md》里的 Step 0：给 sound.js 加订阅数组（约 15 行，不动旧路径）。
 */
import { playFile, stop, subscribe } from '../sound.js'
import { EVENTS, END_REASON, nextSessionId } from './index.js'

/** 平台能力声明：上层按这个走降级逻辑，不要自己写「平台没有 pause」的判断 */
export const CAPABILITIES = {
  pause: 'stop', // 无原生 pause：暂停 = stop()，位置由上层记住
  seek: 'reopen', // 无原生 seek：换位置 = 重新 open
  rate: 'native', // playFile 第三个参数支持倍速（在线同样生效）
  volume: 'none', // 无音量接口（YMediaPlayer 没有 volume 方法）→ 只能走系统音量
  route: 'none' // 无输出设备选择（蓝牙/喇叭通路由系统决定）
}

const NEAR_END_MS = 3000 // 结束事件判定「临近结尾」的容差（区分自然播完与外部 stop）
const STOP_WINDOW_MS = 2000 // stop() 之后的多长时间内，原生事件视为「我们自己停的」

function pickUuid(args) {
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === 'string' && /^[0-9a-f]{8,}$/.test(args[i])) return args[i]
  }
  return ''
}

/** 取最后一个数值实参（position/duration 的值都在末位，对形状差异稳一点） */
function lastNum(args) {
  for (let i = args.length - 1; i >= 0; i--) {
    const n = Number(args[i])
    if (isFinite(n)) return n
  }
  return NaN
}

export function createSoundPlayerEngine() {
  const listeners = []
  let session = 0 // 当前会话令牌（open 时递增）
  let uuid = '' // 当前会话的原生任务 id
  let lastPos = 0 // 最近一次位置（判断自然播完用）
  let lastDur = 0 // 最近一次时长
  let expectingStopAt = 0 // 非 0 = 正在等 stop 的回声，窗口内事件吞掉
  let closed = false

  function emit(name, payload) {
    if (closed) return
    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i](name, payload || {})
      } catch (e) {}
    }
  }

  /** 这次事件是不是我们自己的（uuid 对得上；uuid 缺失时只在「当前有任务」时认） */
  function mine(args) {
    const u = pickUuid(args)
    if (!u) return !!uuid
    return !!uuid && String(u) === String(uuid)
  }

  function onPlatformEvent(name, args) {
    // stop() 的回声：既不是播完也不是出错，直接吞
    if (expectingStopAt && Date.now() - expectingStopAt < STOP_WINDOW_MS) {
      if (name === 'mediaPlayerEndChanged' || name === 'mediaPlayerEndWithErrorChanged') return
    }

    if (name === 'mediaPlayerPositionChanged') {
      if (!mine(args)) return
      const ms = lastNum(args)
      if (!isFinite(ms) || ms < 0) return
      lastPos = ms
      emit(EVENTS.POSITION, { positionMs: ms })
      return
    }

    if (name === 'mediaPlayerDurationChanged') {
      if (!mine(args)) return
      const v = Math.round(lastNum(args) || 0)
      if (!(v > 0)) return
      // 合理性窗：已知时长时只接受 0.5x~2x 内的值（防「剩余时长」类误报把进度条顶满）
      if (lastDur && (v < lastDur * 0.5 || v > lastDur * 2)) return
      lastDur = v
      emit(EVENTS.DURATION, { durationMs: v })
      return
    }

    if (name === 'mediaPlayerEndChanged') {
      if (!mine(args)) return
      uuid = ''
      const natural = !lastDur || lastPos >= lastDur - NEAR_END_MS
      emit(EVENTS.ENDED, {
        reason: natural ? END_REASON.NATURAL : END_REASON.INTERRUPTED,
        positionMs: lastPos,
        durationMs: lastDur
      })
      return
    }

    if (name === 'mediaPlayerEndWithErrorChanged') {
      if (!mine(args)) return
      uuid = ''
      emit(EVENTS.ERROR, {
        message: String(args[args.length - 1] || '').slice(0, 120),
        positionMs: lastPos
      })
    }
  }

  // 平台信号 → 端口事件（一个订阅者，内部再分发给上层）
  subscribe(onPlatformEvent)

  return {
    describe: function () {
      return { id: 'soundplayer', capabilities: Object.assign({}, CAPABILITIES) }
    },

    on: function (fn) {
      listeners.push(fn)
      return function () {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },

    /**
     * 起播。返回本次会话令牌；上层拿它判断「这个 await 回来时还是不是当前会话」，
     * 取代现在散布各处的 `gen++ / my !== gen`。
     * 平台语义：open 是**破坏性**的（内部先 stop 再 playFile），失败时旧播放也已经没了。
     */
    open: async function (req) {
      const id = nextSessionId()
      // 旧的先停：stop 的回声必须在窗口内，否则会被当成「上一首播完」触发连播
      expectingStopAt = Date.now()
      uuid = ''
      await stop()
      if (closed) return 0
      const u = await playFile(req.locator, req.positionMs || 0, req.rate || 1)
      if (closed) return 0
      session = id
      uuid = u || ''
      lastPos = req.positionMs || 0
      lastDur = 0
      expectingStopAt = 0
      emit(EVENTS.STARTED, { session: id, locator: req.locator, kind: req.kind })
      return id
    },

    /** 停止：只保证「不再有声」，不产生任何后续事件（回声在窗口内被吞掉） */
    stop: async function () {
      expectingStopAt = Date.now()
      uuid = ''
      await stop()
    },

    /** 释放订阅（页面/应用退出时调，池化单例则不必） */
    dispose: function () {
      closed = true
      listeners.length = 0
    },

    /** 当前会话令牌（0 = 没有在播的任何东西） */
    sessionId: function () {
      return session
    }
  }
}
