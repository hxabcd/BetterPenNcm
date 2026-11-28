<template>
  <div
    class="lb-view"
    @touchstart="onDown"
    @touchmove="onMove"
    @touchend="onUp"
    @touchcancel="onUp"
  >
    <text class="lb-empty" v-if="!lines.length">{{ emptyText }}</text>
    <div class="lb-track" v-else :style="trackStyle">
      <lyric-track
        :rows="rowsView"
        :hl="active"
        :ticker="ticker"
        :word-on="wordOn"
        :anim="anim"
      />
    </div>
  </div>
</template>

<script>

// 时间系统：面板自己订阅 player（500ms 快照只做锚定/纠偏），用 positionMs + 墙钟 × 倍速 推算连续位置；
// props 不含 position/active → 播放页整页 500ms 重渲染不会带动本组件
// 窗口化两条不变量：1) 换窗口必须与瞬时位移同帧（trackStyle 的 T = topOff + prefix(winStart)）；
// 2) 平滑滑动期间窗口不动、滑完收回，覆盖不了扫过范围就瞬时对齐
// 行盒：活动/非活动同一行高（单行 60px、长行按预排视觉行数增高）、行间无间距、垂直居中、文本左对齐；
// 字号/颜色过渡都在固定行盒内完成，不靠动画 height
// 平台硬约束：单类名选择器、状态/动态色内联、text 不嵌套、data 先声明

import LyricTrack from './LyricTrack.vue'
import { touchAxis } from '../../core/platform/touch.js'
import { log } from '../../core/infra/log.js'
import { accentMixin } from '../../ui/mixins/accent.js'
import { TOK } from '../../ui/tokens.js'
import { bindPageVis } from '../../ui/vis.js'
import { player } from '../../services/player/player.js'
import { lyricClockMixin } from './lyricClock.js'
import { buildLyricRows, LYRIC_GEO } from '../../services/player/lyriclayout.js'

const PANEL_H = 240
const CENTER_Y = PANEL_H / 2
const WATCHDOG_MS = 60000
const SNAP_MS = 260
const INSTANT_MS = 1
const INERTIA_MIN = 0.04 
const INERTIA_FRICTION = 0.94 
const TAP_SLOP = 6
const TAP_MAX_MS = 400
const DBL_MS = 600
const DBL_SLOP = 12
const BUF_PX = 240
const FRAME_MS = 16 

const FS_MAIN = { on: '10.83vh', off: '9.17vh' }
const FS_TRANS = { on: '8.33vh', off: '6.67vh' }
const LH_MAIN = { on: 31.2, off: 26.4 }
const LH_TRANS = { on: 24, off: 19.2 }

// 帧调度**不用 rAF**：实测（2026-11-01，构建 1101-001456）这个面板里 rAF 基本不调度 ——
// 拖动时画面完全不动、松手瞬间才跳到位，活动行也不随进度更新；setTimeout 每帧 16ms 稳定可达，
// 面板静止时也不会被停掉
function scheduleFrame(fn) {
  return setTimeout(fn, FRAME_MS)
}

function cancelFrame(id) {
  clearTimeout(id)
}

// 行内文字样式：**故意不带 transition** —— 本平台对 font-size / color 不插值
// （写 class 里不行、transition: all 也不管），写了只会让人以为有过渡；高亮就是硬切
function textStyle(fontSize, lineHeight, color) {
  return {
    fontSize: fontSize,
    lineHeight: lineHeight + 'px',
    color: color
  }
}

export default {
  name: 'LyricBoard',
  components: { 'lyric-track': LyricTrack },
  mixins: [accentMixin, lyricClockMixin],
  props: {

    // [{time, end, text, trans, words}]，按时间升序（services/player/lyric.js 产出）
    lines: { type: Array, default: function () { return [] } },

    showTrans: { type: Boolean, default: true },

    // true = 可拖动翻看；false = 省性能（禁拖动，位置恒跟当前行）
    full: { type: Boolean, default: true },

    follow: { type: Boolean, default: true },

    dblTap: { type: Boolean, default: true },

    // 逐字歌词：活动行才拆字节点；无 YRC 自动等价逐行
    wordOn: { type: Boolean, default: true },

    anim: { type: Boolean, default: true },
    emptyText: { type: String, default: '暂无歌词' }
  },
  data() {
    return {

      // 当前行下标（-1 = 还没到第一行；由局部时钟驱动，不由播放页传入）
      active: -1,

      // 轨道位移（px）：第 0 行顶边相对面板顶边的 y（补间每帧改它）
      topOff: 0,

      dragging: false,

      winStart: 0,
      winEnd: 0,

      // 局部时钟对象（created 里赋值；传给逐字行订阅，刻意不作为响应式状态）
      ticker: null
    }
  },
  computed: {
    locked() {
      return !this.full
    },

    layoutActive() {
      const a = this.active
      const n = this.lines.length
      const last = n > 0 ? n - 1 : 0
      return a < 0 ? 0 : a > last ? last : a
    },

    // 排版行 + 预算样式（只跟歌词/翻译/逐字/动画/主题色有关，不依赖播放进度）；
    // 换行时数组引用不变 → LyricTrack 不重渲染，只有 hl 变化时才重渲染窗口内的行
    rowsAll() {
      const rows = buildLyricRows(this.lines, this.showTrans, this.wordOn)
      const accentC = this.accent.c
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        r.sRow = { height: r.h + 'px' }
        r.sMarkOn = { backgroundColor: accentC }
        r.sMarkOff = { backgroundColor: TOK.none }
        r.sMainOn = textStyle(FS_MAIN.on, LH_MAIN.on, TOK.text)
        r.sMainOff = textStyle(FS_MAIN.off, LH_MAIN.off, TOK.text2)
        r.sTransOn = textStyle(FS_TRANS.on, LH_TRANS.on, TOK.text2)
        r.sTransOff = textStyle(FS_TRANS.off, LH_TRANS.off, TOK.text3)
      }
      return rows
    },
    rowsView() {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return rows
      let s = this.winStart
      let e = this.winEnd
      if (s < 0) s = 0
      if (s > n) s = n
      if (e < s) e = s
      if (e > n) e = n
      return rows.slice(s, e)
    },

    // 自动跟随目标与拖动边界（px，内容坐标；前缀和 O(1)）
    geo() {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return { auto: 0, min: 0, max: 0 }
      const act = this.layoutActive
      return {
        auto: CENTER_Y - this.rowTop(act) - rows[act].h / 2,
        max: CENTER_Y - rows[0].h / 2,
        min: CENTER_Y - (this.contentH() - rows[n - 1].h / 2)
      }
    },

    // 整条轨道唯一一次 translateY；窗口起点之前的高度要加回来（见 T 公式）
    // **不用 CSS transition**：平台对 transform 的过渡插值不可靠（实测硬跳），过渡期间窗口/节点一变就闪
    trackStyle() {
      const rows = this.rowsAll
      const n = rows.length
      const shift = n ? this.rowTop(Math.max(0, Math.min(this.winStart, n - 1))) : 0
      return { transform: 'translateY(' + (this.topOff + shift).toFixed(2) + 'px)' }
    }
  },
  watch: {
    full() {
      this.resetTouchState()
      this.applyJump(this.geo.auto)
    },

    active() {

      // up 事件丢失（平台偶发）：1s 内没有 touchmove 就当手指早已松开，否则 dragging 一直挂着，
      // 自动跟歌从此不再滚动 —— 表现就是「歌词不跟着走」
      if (this.dragging && Date.now() - (this._lastMoveAt || 0) > 1000) {
        log('lyric', '拖动态超时未收到 up，复位')
        this.resetTouchState()
      }
      if (this.dragging || this._inertia) return
      if (!this.follow && !this.locked) return
      this.snapToCurrent(this.anim ? SNAP_MS : 0)
    },
    showTrans() {
      this.relayoutAfterRows()
    },
    wordOn() {
      this.relayoutAfterRows()
    },
    anim() {
      this.relayoutAfterRows()
    },

    lines() {
      this.active = this.activeFromClock()
      this.resetTouchState()
      this.applyJump(this.geo.auto)
    },

    follow(on) {
      if (!on || this.dragging || this._inertia) return
      this.snapToCurrent(this.anim ? SNAP_MS : 0)
    }
  },
  created() {

    this._subs = []
    const self = this
    this._ticker = {
      on: function (fn) {
        if (fn && self._subs.indexOf(fn) < 0) self._subs.push(fn)
      },
      off: function (fn) {
        const i = self._subs ? self._subs.indexOf(fn) : -1
        if (i >= 0) self._subs.splice(i, 1)
      },
      ms: function () {
        return self.clockMs()
      }
    }
    this.ticker = this._ticker
    this._anchorMs = 0
    this._anchorAt = 0
    this._playing = false
    this._rate = 1
    this._rafId = 0
    this._dragRaf = 0
    this._inertia = false
    this._inertiaRaf = 0
    this._speed = 0
    this._lastY = 0
    this._lastMoveAt = 0
    this._frames = 0 
    this._actLogs = 0 
    this._diagT = 0
    this.onState(player.state())
    this.topOff = this.geo.auto
    this.syncWindow(this.topOff, this.topOff)
  },
  mounted() {
    const self = this
    this._dead = false

    // 播放器快照只在**可见**时消费：被上层页盖住时 onState 会写 active、推送时钟给每个 LyricWordLine，
    // 整块歌词随之重渲染；露出时用最新快照重锚，隐藏期间丢掉的 tick 不会让画面停在旧位置
    this._visible = true
    this._ph = player.on(function (s) {
      if (!self._visible) return
      self.onState(s)
    })
    this.startClock()

    // 不可见时连时钟一起停（33ms 一拍 = 每秒 30 次推进 + 逐字状态推送）；
    // player 订阅本身保留，用于露出时重锚
    this._visOff = bindPageVis(this, function (on) {
      self._visible = on
      if (on) {
        self.onState(player.state())
        if (self._playing) self.startClock()
      } else {
        self.stopClock()
      }
    })
    // 幂等对齐（页面会挂两遍）
    this.applyJump(this.geo.auto) 
    log('lyric', '歌词面板挂载 行数=' + this.rowsAll.length +
      ' 渲染=' + this.rowsView.length + ' 行（窗口 ' + this.winStart + '..' + this.winEnd + '）')

    // 挂载 3s 后采一次样（拍数 / 是否在播 / 时钟位置 / 活动行）：
    // 「活动行不跟播放进度」看这一条就能分清是时钟没走还是没换行
    this._diagT = setTimeout(function () {
      self._diagT = 0
      if (self._dead) return
      log('lyric', '时钟采样 拍=' + self._frames +
        ' 播放=' + self._playing + ' 时钟=' + Math.round(self.clockMs()) + 'ms' +
        ' 活动行=' + self.active + ' 拖动=' + self.dragging)
    }, 3000)
  },
  beforeDestroy() {
    this._dead = true
    if (this._ph) player.off(this._ph)
    this._ph = null
    if (this._visOff) this._visOff()
    this._visOff = null
    if (this._diagT) clearTimeout(this._diagT)
    this._diagT = 0
    this.stopClock()
    this.resetTouchState()
    this.stopAnim()
  },
  methods: {

    rowTop(i) {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return 0
      const k = i < 0 ? 0 : i >= n ? n - 1 : i
      return rows[k].prefix
    },
    rowH(i) {
      const rows = this.rowsAll
      const n = rows.length
      if (i < 0 || i >= n) return LYRIC_GEO.ROW_H
      return rows[i].h
    },
    contentH() {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return 0
      return rows[n - 1].prefix + rows[n - 1].h
    },

    findWindowRange(from, to) {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return { s: 0, e: 0 }
      const lo = -Math.max(from, to) - BUF_PX
      const hi = -Math.min(from, to) + PANEL_H + BUF_PX
      let s = 0
      while (s < n && this.rowTop(s) + rows[s].h <= lo) s++
      let e = s
      while (e < n && this.rowTop(e) < hi) e++
      return { s: s, e: e }
    },
    syncWindow(from, to) {
      const rows = this.rowsAll
      if (!rows.length) {
        if (this.winStart !== 0 || this.winEnd !== 0) {
          this.winStart = 0
          this.winEnd = 0
        }
        return
      }
      const a = from === undefined ? this.topOff : from
      const b = to === undefined ? a : to
      const w = this.findWindowRange(a, b)
      if (w.s === this.winStart && w.e === this.winEnd) return
      this.winStart = w.s
      this.winEnd = w.e
    },
    windowCovers(a, b) {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return true
      const s = Math.max(0, Math.min(this.winStart, n - 1))
      const e = Math.max(s + 1, Math.min(this.winEnd, n))
      const last = e - 1
      const lo = s === 0 ? -Infinity : this.rowTop(s)
      const hi = last === n - 1 ? Infinity : this.rowTop(last) + rows[last].h
      const c0 = -Math.max(a, b)
      const c1 = -Math.min(a, b) + PANEL_H
      return c0 >= lo - 0.5 && c1 <= hi + 0.5
    },

    applyJump(target) {
      this.stopAnim()
      this.topOff = target
      this.syncWindow(target, target)
    },

    // JS 补间滚到 target（ease-out）：本平台 CSS transition 对 transform 不插值（硬跳），
    // 在途过渡遇到窗口/节点变化还会闪；补间还能控窗口 —— 开始前一次性扩窗覆盖 from→target，
    // 期间只改 topOff，结束再收窗
    animateTo(target, ms) {
      this.stopAnim()
      if (ms <= 0 || target === this.topOff) {
        this.topOff = target
        this.syncWindow(target, target)
        return
      }
      const from = this.topOff
      const t0 = Date.now()
      const self = this
      this.syncWindow(from, target) 
      const step = function () {
        if (self._dead) {
          self._animT = 0
          return
        }
        const p = Math.min(1, (Date.now() - t0) / ms)
        const e = 1 - Math.pow(1 - p, 3) 
        self.topOff = from + (target - from) * e
        if (p < 1) {
          self._animT = setTimeout(step, FRAME_MS)
        } else {
          self._animT = 0
          self.topOff = target
          self.syncWindow(target, target) 
        }
      }
      this._animT = setTimeout(step, FRAME_MS)
    },
    stopAnim() {
      if (this._animT) {
        clearTimeout(this._animT)
        this._animT = 0
      }
    },
    snapToCurrent(ms) {
      if (this.dragging || this._inertia) return
      const target = this.geo.auto
      if (ms <= 0 || !this.windowCovers(this.topOff, target) || target === this.topOff) {
        this.applyJump(target)
        return
      }
      this.animateTo(target, ms)
    },
    relayoutAfterRows() {
      if (this.dragging || this._inertia) {
        this.syncWindow(this.topOff, this.topOff)
        return
      }
      if (this.follow || this.locked) this.snapToCurrent(this.anim ? SNAP_MS : 0)
      else this.applyJump(this.topOff)
    },

    applyDrag(y) {
      const g = this.geo
      let v = this._startOff + (y - this._startY)
      if (v > g.max) v = g.max
      if (v < g.min) v = g.min
      if (Math.abs(v - this.topOff) < 0.05) return
      this.topOff = v
      this.syncWindow(v, v)
    },
    dragFrame() {
      this._dragRaf = 0
      if (!this.dragging) return
      this.applyDrag(this._lastY)
    },
    inertiaFrame() {
      if (!this._inertia) {
        this._inertiaRaf = 0
        return
      }
      const now = Date.now()
      let dt = now - (this._inertiaAt || now)
      if (dt > 40) dt = 40
      if (dt <= 0) dt = 16
      this._inertiaAt = now
      this._speed *= Math.pow(INERTIA_FRICTION, dt / 16)
      const g = this.geo
      let v = this.topOff + this._speed * dt
      if (v >= g.max) {
        v = g.max
        this._speed = 0
      }
      if (v <= g.min) {
        v = g.min
        this._speed = 0
      }
      this.topOff = v
      this.syncWindow(v, v)
      if (Math.abs(this._speed) < INERTIA_MIN) {
        this._inertia = false
        this._inertiaRaf = 0
            return
      }
      const self = this
      this._inertiaRaf = scheduleFrame(function () {
        self.inertiaFrame()
      })
    },
    resetTouchState() {
      if (this._dragRaf) cancelFrame(this._dragRaf)
      if (this._inertiaRaf) cancelFrame(this._inertiaRaf)
      if (this._wd) clearTimeout(this._wd)
      this._dragRaf = 0
      this._inertiaRaf = 0
      this._inertia = false
      this._wd = null
      this.dragging = false
      this._speed = 0

      // 注意不清 _lastTap：双击的第二次按下要保留第一次抬起的信息
    },
    onDown(e) {
      const y = touchAxis(e, 'y')
      if (!isFinite(y)) return
      this.logRawOnce(e)
      this.stopAnim() 
      this.resetTouchState()
      this._startY = y
      this._lastY = y
      this._startOff = this.topOff
      this._moved = 0
      this._downT = Date.now()
      this._lastMoveAt = this._downT
      if (this.locked) return
      this.dragging = true
      const self = this
      this._wd = setTimeout(function () {
        self.onUp()
      }, WATCHDOG_MS)
    },
    onMove(e) {
      const y = touchAxis(e, 'y')
      if (!isFinite(y)) return
      const d = Math.abs(y - this._startY)
      if (d > this._moved) this._moved = d
      if (this.locked || !this.dragging) return
      const now = Date.now()
      const dt = now - this._lastMoveAt
      if (dt > 0) this._speed = (y - this._lastY) / dt
      this._lastY = y
      this._lastMoveAt = now
      if (!this._dragRaf) {
        const self = this
        this._dragRaf = scheduleFrame(function () {
          self.dragFrame()
        })
      }
    },
    onUp(e) {
      if (this.locked) {
        const dl = Date.now() - this._downT
        if (this._moved <= TAP_SLOP && dl <= TAP_MAX_MS) this.onTap(e)
        else this._lastTap = null
        return
      }
      if (!this.dragging) return
      const y = touchAxis(e, 'y')
      if (isFinite(y)) this.applyDrag(y)
      this.dragging = false
      if (this._dragRaf) {
        cancelFrame(this._dragRaf)
        this._dragRaf = 0
      }
      if (this._wd) {
        clearTimeout(this._wd)
        this._wd = null
      }
      const dt = Date.now() - this._downT
      if (this._moved <= TAP_SLOP && dt <= TAP_MAX_MS) {
        this.onTap(e)
        return
      }

      if (Math.abs(this._speed) > INERTIA_MIN) {
        this._inertia = true
        this._inertiaAt = Date.now()
            const self = this
        this._inertiaRaf = scheduleFrame(function () {
          self.inertiaFrame()
        })
      } else {
        this._speed = 0
      }
    },
    onTap(e) {
      if (!this.dblTap) return
      const y = touchAxis(e, 'y')
      const yy = isFinite(y) ? y : this._startY
      const now = Date.now()
      const last = this._lastTap
      this._lastTap = { t: now, y: yy }
      if (!last || !isFinite(yy)) return
      if (now - last.t > DBL_MS) return
      if (!isFinite(last.y) || Math.abs(yy - last.y) > DBL_SLOP) return
      this._lastTap = null
      const idx = this.lineAtY(yy)
      log('lyric', '双击歌词 y=' + Math.round(yy) + ' off=' + Math.round(this.topOff) +
        ' 行数=' + this.lines.length + ' 渲染=' + this.rowsView.length +
        ' act=' + this.active + ' -> idx=' + idx)
      if (idx >= 0) this.$emit('seekline', idx)
    },
    lineAtY(yPx) {
      const rows = this.rowsAll
      const n = rows.length
      if (!n || !isFinite(yPx)) return -1
      const t = yPx - this.topOff
      if (t < 0) return -1
      for (let k = 0; k < n; k++) {
        const top = this.rowTop(k)
        if (t < top) return -1
        if (t < top + rows[k].h) return rows[k].i
      }
      return -1
    },
    logRawOnce(e) {
      if (this._rawLogged) return
      this._rawLogged = true
      const pick = function (o) {
        if (!o) return '-'
        return [o.pageY, o.clientY, o.screenY, o.y].join('/')
      }
      const list = e && (e.changedTouches || e.touches || e.targetTouches)
      const t = (list && (list[0] || list)) || e || {}
      log('lyric', '坐标字段 pageY/clientY/screenY/y = ' + pick(t) +
        ' off=' + Math.round(this.topOff))
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.lb-view {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.lb-track {
  position: absolute;
  top: 0;
  left: 10px;
  right: 10px;
  flex-direction: column;
}
.lb-empty {
  font-size: 8.33vh;
  color: @text-3;
}
</style>
