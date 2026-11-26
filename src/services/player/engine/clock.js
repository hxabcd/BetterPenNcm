

// 进度时钟：原生事件锚定 + 墙钟插值。now() 返回的位置（毫秒）已乘倍速（1.5x 时媒体时间比墙钟走得快）；
// setRate 先锚定当前位置再换速率，保证换档瞬间不跳；stop() 后 now() 恒定（暂停态显示用）
export function createClock() {
  let baseMs = 0 
  let at = Date.now() 
  let rate = 1 
  let running = false

  function now() {
    if (!running) return baseMs
    return baseMs + (Date.now() - at) * rate
  }

  return {

    anchor: function (ms) {
      const v = Number(ms)
      if (!isFinite(v) || v < 0) return
      baseMs = v
      at = Date.now()
      running = true
    },

    now: now,

    rate: function () {
      return rate
    },

    setRate: function (r) {
      const v = Number(r)
      if (!v || v <= 0) return
      const pos = now()
      baseMs = pos
      at = Date.now()
      rate = v
    },

    stop: function () {
      baseMs = now()
      running = false
    },

    reset: function (ms) {
      baseMs = Number(ms) || 0
      at = Date.now()
      running = true
    },

    running: function () {
      return running
    }
  }
}
