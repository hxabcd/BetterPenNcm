import { log } from '../../core/infra/log.js'
import { findLyricIndex } from '../../services/player/lyric.js'

// 歌词时钟（换行判断 + 逐字推送）的推进间隔：约 30fps，够用且比 16ms 省电
const CLOCK_MS = 33 

// 快照与墙钟推算的容差：以内不重锚，避免逐字动画周期性抖动
const ANCHOR_TOL_MS = 80 

export const lyricClockMixin = {
  methods: {
    clockMs() {
      if (!this._playing || !this._anchorAt) return this._anchorMs
      return this._anchorMs + (Date.now() - this._anchorAt) * this._rate
    },
    activeFromClock() {
      if (!this.lines.length) return -1
      return findLyricIndex(this.lines, this.clockMs())
    },
    onState(s) {
      const pos = (s && s.positionMs) || 0
      const playing = !!(s && s.isPlaying && !s.paused)
      const rate = (s && s.rate) || 1
      const wasPlaying = this._playing

      // 小误差不重锚（500ms 快照反复重锚会让逐字动画来回抖），但**换行判断仍要走一次**
      if (playing && wasPlaying && this._anchorAt && rate === this._rate) {
        const diff = pos - this.clockMs()
        if (diff > -ANCHOR_TOL_MS && diff < ANCHOR_TOL_MS) {
          this.syncActive(this.clockMs())
          this.pushClock(pos)
          return
        }
      }
      this._playing = playing
      this._rate = rate
      this._anchorMs = pos
      this._anchorAt = playing ? Date.now() : 0
      this.syncActive(pos)
      this.pushClock(pos)

      // 暂停 → 播放的边沿：时钟可能在暂停时自己停了，这里重新拉起
      if (playing && this._ph && !this._rafId) this.startClock()
    },
    syncActive(ms) {
      const idx = this.lines.length ? findLyricIndex(this.lines, ms) : -1
      if (idx === this.active) return
      this.active = idx

      if (this._actLogs < 6) {
        this._actLogs++
        log('lyric', '活动行 -> ' + idx + ' @' + Math.round(ms) + 'ms ' +
          '帧=' + this._frames + ' 播放=' + this._playing + ' 拖动=' + this.dragging)
      }
    },
    pushClock(ms) {
      const subs = this._subs
      for (let i = 0; i < subs.length; i++) {
        try {
          subs[i](ms)
        } catch (e) {}
      }
    },
    startClock() {
      this.stopClock()
      if (!this._playing) return
      const self = this

      // 定时器驱动（不用 rAF，原因见 scheduleFrame 的注释）
      const tick = function () {
        if (self._dead || !self._playing) {
          self._rafId = 0
          return
        }
        self._frames++
        const ms = self.clockMs()
        self.syncActive(ms)
        self.pushClock(ms)
        self._rafId = setTimeout(tick, CLOCK_MS)
      }
      this._rafId = setTimeout(tick, CLOCK_MS)
    },
    stopClock() {
      if (this._rafId) clearTimeout(this._rafId)
      this._rafId = 0
    },
  }
}
