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
/**
 * 歌词面板（播放页右侧 480×240 子面板；2026-10-31 重构时间系统与行盒）。
 *
 * 行盒：活动/非活动同一行高（单行 60px、长行按预排视觉行数增高）、行间无间距、
 * 行内容垂直居中、文本左对齐；字号/颜色过渡都在固定行盒内完成，不再动画 height。
 *
 * 时间系统：面板自己订阅 player（500ms 快照只做锚定/纠偏），用
 * positionMs + 墙钟 × 倍速 推算连续位置；rAF 只在播放中跑，驱动：
 *   1. 当前行下标（只在换行时写 data）；
 *   2. 局部时钟 ticker → LyricWordLine 内部做逐字扫亮（高频状态不进本组件）。
 * 播放页整页 500ms 重渲染不会带动本组件（props 不含 position/active）。
 *
 * 滚动：touchmove 只记录最新坐标，rAF 合并成每帧一次；松手短惯性；
 * 自动跟歌与回位共用同一套 rAF。窗口化两条不变量与旧版一致：
 *   1. 换窗口必须与瞬时位移同帧（trackStyle 的 T = topOff + prefix(winStart)）；
 *   2. 平滑滑动期间窗口不动，滑完收回；覆盖不了扫过范围就瞬时对齐。
 *
 * 交互：拖动跟手、高亮始终跟播放进度、双击行 seek、60s 看门狗兜底 touchend 缺失。
 * 平台硬约束：单类名；状态/动态色内联；text 不嵌套；data 先声明；
 * 模板裸绑定只来自 props/computed/data；颜色走 TOK / accent。
 */
import LyricTrack from './LyricTrack.vue'
import { touchAxis } from '../../utils/touch.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { TOK } from '../../utils/ui/tokens.js'
import { player } from '../../utils/player/player.js'
import { findLyricIndex } from '../../utils/player/lyric.js'
import { buildLyricRows, LYRIC_GEO } from '../../utils/player/lyriclayout.js'

const PANEL_H = 240
const CENTER_Y = PANEL_H / 2
const WATCHDOG_MS = 60000
const SNAP_MS = 260
const INSTANT_MS = 1
const CLOCK_MS = 33 // 歌词时钟（换行判断 + 逐字推送）的推进间隔，约 30fps，够用且比 16ms 省电
const INERTIA_MIN = 0.04 // px/ms；低于它直接停
const INERTIA_FRICTION = 0.94 // 每 16ms 的速度保留率
const TAP_SLOP = 6
const TAP_MAX_MS = 400
const DBL_MS = 600
const DBL_SLOP = 12
const BUF_PX = 240
const ANCHOR_TOL_MS = 80 // 快照与墙钟推算的容差；以内不重锚，避免逐字动画周期性抖动
const FRAME_MS = 16 // 帧间隔（拖动合并 / 惯性 / 时钟都走这个定时器）

const FS_MAIN = { on: '10.83vh', off: '9.17vh' }
const FS_TRANS = { on: '8.33vh', off: '6.67vh' }
const LH_MAIN = { on: 31.2, off: 26.4 }
const LH_TRANS = { on: 24, off: 19.2 }

/**
 * 帧调度：**不用 rAF**。
 * 实测（2026-11-01，构建 1101-001456）：这个面板里 rAF 基本不调度 —— 拖动时画面完全不动、
 * 松手瞬间才跳到位；活动行也不随进度更新。两者都只依赖 rAF，所以一起停。
 * 定时器虽然不跟屏幕刷新同步，但每帧 16ms 稳定可达，且面板静止时也不会被停掉。
 */
function scheduleFrame(fn) {
  return setTimeout(fn, FRAME_MS)
}

function cancelFrame(id) {
  clearTimeout(id)
}

/**
 * 行内文字样式。**故意不带 transition**：本平台对 `font-size` / `color` 不插值
 * （写 class 里也不行、`transition: all` 也不管，见 docs/平台约束与自检.md 的动画能力表），
 * 写了只会让人误以为有过渡 —— 高亮就是硬切。真想做渐变只能 JS 逐帧改内联值。
 */
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
  mixins: [accentMixin],
  props: {
    /** [{time, end, text, trans, words}]，按时间升序（utils/player/lyric.js 产出） */
    lines: { type: Array, default: function () { return [] } },
    /** 是否显示译文 */
    showTrans: { type: Boolean, default: true },
    /** true = 可拖动翻看；false = 省性能（禁拖动，位置恒跟当前行） */
    full: { type: Boolean, default: true },
    /** 活动行更新时是否平滑滚动（false = 只换高亮） */
    follow: { type: Boolean, default: true },
    /** 是否允许双击歌词跳转 */
    dblTap: { type: Boolean, default: true },
    /** 是否启用逐字歌词（活动行才拆字节点；无 YRC 自动等价逐行） */
    wordOn: { type: Boolean, default: true },
    /** 是否启用歌词动画（false = 定位/高亮/逐字全部瞬时） */
    anim: { type: Boolean, default: true },
    emptyText: { type: String, default: '暂无歌词' }
  },
  data() {
    return {
      /** 当前行下标（-1 = 还没到第一行；由局部时钟驱动，不再由播放页传入） */
      active: -1,
      /** 轨道位移（px）：第 0 行顶边相对面板顶边的 y（补间每帧改它） */
      topOff: 0,
      /** 手指按住中（按着时不自动滚，高亮照常更新） */
      dragging: false,
      /** 渲染窗口 [winStart, winEnd) */
      winStart: 0,
      winEnd: 0,
      /** 局部时钟对象（created 里赋值；传给逐字行订阅，不作为响应式状态） */
      ticker: null
    }
  },
  computed: {
    locked() {
      return !this.full
    },
    /** 排版用的当前行（不能是 -1；越界夹回来） */
    layoutActive() {
      const a = this.active
      const n = this.lines.length
      const last = n > 0 ? n - 1 : 0
      return a < 0 ? 0 : a > last ? last : a
    },
    /**
     * 排版行 + 预算样式（只跟歌词/翻译/逐字/动画/主题色有关，不依赖播放进度）。
     * 行高由 lyriclayout.js 预排给出；换行时数组引用不变 → LyricTrack 不重渲染，
     * 只有 hl 变化时它才重渲染窗口内行。
     */
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
    /** 自动跟随目标与拖动边界（px，内容坐标；前缀和 O(1)） */
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
    /**
     * 整条轨道唯一一次 translateY；窗口起点之前的高度要加回来（推导见旧版注释，公式不变）。
     * **不用 CSS transition**：本平台对 transform 的过渡插值不可靠（实测硬跳），且过渡期间
     * 窗口/节点一变就闪。改成 JS 补间（animateTo）逐帧写 transform，所见即所得。
     */
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
    /** 换行：滚动看 follow/锁定/手指/惯性；高亮由渲染自动跟上 */
    active() {
      // up 事件丢失（平台偶发）：1s 没有任何 touchmove 就当手指早松开了，
      // 否则 dragging 会一直挂着，自动跟歌从此不再滚动 —— 表现就是「歌词不跟着走」。
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
    /** 切歌：瞬时归位，不从上一首的位置滑过来 */
    lines() {
      this.active = this.activeFromClock()
      this.resetTouchState()
      this.applyJump(this.geo.auto)
    },
    /** 自动跟歌从关到开：立刻滚回当前行 */
    follow(on) {
      if (!on || this.dragging || this._inertia) return
      this.snapToCurrent(this.anim ? SNAP_MS : 0)
    }
  },
  created() {
    // 局部时钟与订阅表（非响应式；ticker 引用稳定，LyricWordLine 直接挂回调）
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
    this._frames = 0 // 时钟实际走了多少拍（诊断用）
    this._actLogs = 0 // 换行日志条数上限（避免刷屏）
    this._diagT = 0
    this.onState(player.state())
    this.topOff = this.geo.auto
    this.syncWindow(this.topOff, this.topOff)
  },
  mounted() {
    const self = this
    this._dead = false
    this._ph = player.on(function (s) {
      self.onState(s)
    })
    this.startClock()
    this.applyJump(this.geo.auto) // 幂等对齐（页面会挂两遍）
    log('lyric', '歌词面板挂载 行数=' + this.rowsAll.length +
      ' 渲染=' + this.rowsView.length + ' 行（窗口 ' + this.winStart + '..' + this.winEnd + '）')
    // 挂载 3s 后采一次样：时钟拍数 / 是否在播 / 时钟位置 / 活动行。
    // 「活动行不跟播放进度」这类问题，看这一条就能分清是时钟没走还是没换行。
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
    if (this._diagT) clearTimeout(this._diagT)
    this._diagT = 0
    this.stopClock()
    this.resetTouchState()
    this.stopAnim()
  },
  methods: {
    /* ---- 局部时钟 ---- */
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
      // 暂停 → 播放的边沿：rAF 时钟可能在暂停时自己停了，这里重新拉起
      if (playing && this._ph && !this._rafId) this.startClock()
    },
    syncActive(ms) {
      const idx = this.lines.length ? findLyricIndex(this.lines, ms) : -1
      if (idx === this.active) return
      this.active = idx
      // 换行日志（前几条）：定位「不换行」时最直接的证据 —— 看是时钟没走还是没换行
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
      // 定时器驱动（不用 rAF，原因见文件头 scheduleFrame 的注释）
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
    /* ---- 行几何（无行距：rowTop = prefix，O(1)） ---- */
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
    /* ---- 窗口化（不变量：换窗口必须伴随瞬时帧） ---- */
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
    /** 瞬时对齐：停掉在跑的补间，直接落到目标，窗口按端点收拢 */
    applyJump(target) {
      this.stopAnim()
      this.topOff = target
      this.syncWindow(target, target)
    },
    /**
     * JS 补间滚到 target（ease-out）。
     *
     * 为什么不用 CSS transition：实测这个平台对 transform 的过渡不插值（硬跳），
     * 而且在途过渡遇到窗口/节点变化会闪。补间还有一个好处 —— 窗口可控：
     * 开始前一次性把窗口扩到能盖住 from→target（不变量 2：滑动期间不换窗口），
     * 期间只改 topOff，结束时再收窗，滑过的范围内一定有节点。
     */
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
      this.syncWindow(from, target) // 预扩窗：整段滑动都在窗口覆盖内
      const step = function () {
        if (self._dead) {
          self._animT = 0
          return
        }
        const p = Math.min(1, (Date.now() - t0) / ms)
        const e = 1 - Math.pow(1 - p, 3) // ease-out cubic
        self.topOff = from + (target - from) * e
        if (p < 1) {
          self._animT = setTimeout(step, FRAME_MS)
        } else {
          self._animT = 0
          self.topOff = target
          self.syncWindow(target, target) // 收窗
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
    /* ---- 拖动 / 惯性（rAF 合并；速度用最近一次 move 的两点差） ---- */
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
      this.stopAnim() // 手指一按就接管位置，别让还在跑的补间继续拉（否则 _startOff 会漂）
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
      // 松手惯性：速度方向与 topOff 一致（手指往下拖 = 内容往下移 = topOff 增大）
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
