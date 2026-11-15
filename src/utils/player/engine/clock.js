/**
 * 播放进度时钟 —— 「原生事件锚定 + 墙钟插值」的唯一实现。
 *
 * 为什么要单独一个模块：现在 player.js 里 `baseMs / startedAt / rate / positionMs`
 * 四个变量由 startSource、onPos、startTimer、seekTo、reopenAt 各自手工同步，
 * 任何一处漏乘倍速或漏重置锚点，都会表现为进度跳变 / 提前判定播完。
 * 这里把「时间」这段状态收成一个对象，外面只能通过 anchor / setRate / reset 改它。
 *
 * 语义：
 *   anchor(ms)   以原生上报的位置为准重设锚点（收到 position 事件、起播成功时调）
 *   now()        当前应显示的位置 —— 已乘倍速（1.5x 时媒体时间比墙钟走得快）
 *   setRate(r)   先取一次快照再换倍速，保证换档瞬间进度不跳
 *   stop()       冻结（暂停后 now() 恒定，用于显示）
 *   reset(ms)    清空重新开始（换歌时用）
 */
export function createClock() {
  let baseMs = 0 // 锚点位置（毫秒）
  let at = Date.now() // 锚点对应的墙钟
  let rate = 1 // 当前倍速
  let running = false

  function now() {
    if (!running) return baseMs
    return baseMs + (Date.now() - at) * rate
  }

  return {
    /** 以原生位置为准重设锚点 */
    anchor: function (ms) {
      const v = Number(ms)
      if (!isFinite(v) || v < 0) return
      baseMs = v
      at = Date.now()
      running = true
    },
    /** 当前位置（毫秒，已乘倍速） */
    now: now,
    /** 当前倍速 */
    rate: function () {
      return rate
    },
    /** 换倍速：先锚定当前位置，再换速率 */
    setRate: function (r) {
      const v = Number(r)
      if (!v || v <= 0) return
      const pos = now()
      baseMs = pos
      at = Date.now()
      rate = v
    },
    /** 冻结（暂停态显示用） */
    stop: function () {
      baseMs = now()
      running = false
    },
    /** 清空并从 ms 重新开始 */
    reset: function (ms) {
      baseMs = Number(ms) || 0
      at = Date.now()
      running = true
    },
    /** 是否在走 */
    running: function () {
      return running
    }
  }
}
