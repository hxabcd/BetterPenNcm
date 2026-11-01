<template>
  <div
    class="lp-view"
    @touchstart="onDown"
    @touchmove="onMove"
    @touchend="onUp"
    @touchcancel="onUp"
  >
    <text class="lp-empty" v-if="!lines.length">{{ emptyText }}</text>
    <div class="lp-track" v-else :style="trackStyle">
      <div class="lp-row" v-for="r in rowsView" :key="r.i" :style="rowStyle(r)">
        <div class="lp-mark" :style="markStyle(r)"></div>
        <div class="lp-text">
          <text class="lp-main" :style="mainStyle(r)">{{ r.text }}</text>
          <text class="lp-trans" v-if="showTrans && r.trans" :style="transStyle">{{ r.trans }}</text>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
/**
 * 歌词面板 —— 移植社区应用 PenMusic 的 LyricPanel（`player.js`），按本项目需要改了两处：
 *
 * 核心做法：
 *   1. **渲染范围由 `full` 开关决定**（「歌词可以渲染完吗」+「加个设置项」）：
 *      `full=true`（默认）整首铺开，可自由拖动翻看；
 *      `full=false`（省性能，**改版**）只渲染**当前行 ± WIN_SIDE 行（共 7 行）**，
 *      且**不接受拖动** —— 位置恒为「当前行居中」，完全由歌曲进度驱动。
 *      代价是翻不了整首（窗口 7 行 > 可视区 4~5 行，所以画面是满的，只是不能往上翻看），
 *      换来的是每帧不用重算窗口与位移（拖动是这块最大的开销）。
 *      窗口起点随当前行挪，位移同时补掉被挪掉的高度（见 trackStyle / prefixBefore），
 *      两者同一帧生效，画面不会跳。
 *   2. 行盒都很轻（一个竖条 + 一到两个 text）；`rowsAll` 只跟歌词/翻译开关有关、
 *      **不跟播放进度**，所以换行时 v-for 的数组引用不变，渲染器不必重建行节点
 *      （这是「铺全部」不至于卡的唯一理由，别把 active 塞进 rowsAll）。
 *   2. **行盒冻结**：每行高度固定且显式写死，切行/拖动时不会因文字换行而跳动
 *   3. 整条轨道只用**一次 transform: translateY()** 平移，不做真实滚动容器
 *   4. **拖动跟手；松手后进入 3 秒停留期（hold），期间仍然完全冻结**；被按一次就重新计时
 *      （连着翻可以一直停着），3 秒内没动作才滑回当前行、恢复跟歌。**60 秒**看门狗兜底
 *      （有些固件不发 touchend）。→「翻的时候不要跟用户抢，
 *      停下 3s 之后再返回」，所以拖动中与停留期中**高亮也一起冻结**（hlIndex）
 *   5. `transitionDuration` 传**数字**（传 0 会被某些渲染器当成"没设置"而回落到默认，故拖动用 1）
 *   6. **双击某一行 → 抛 `seekline` 事件**（页面据此 seekTo），见 onTap / lineAtY。
 *      注意本固件 `pageY` 是**节点相对**坐标（相对本面板顶边），别再减面板顶边，见 lineAtY
 *
 * 对齐：左对齐，当前行左侧有强调竖条。
 *
 * 几何不依赖任何元素测量 API —— 可视区高度由 utils/player/layout.js 的常量反推。
 */
import { LYRIC, VH, lyricViewPx } from '../utils/player/layout.js'
import { touchAxis } from '../utils/touch.js'
import { log } from '../utils/log.js'
import { accentMixin } from '../utils/theme.js'
import { TOK } from '../utils/ui/tokens.js'

const MAIN_H = LYRIC.MAIN_H * VH // px
const TRANS_H = LYRIC.TRANS_H * VH
/**
 * 省性能模式的窗口：**当前行上下各 3 行**，共 7 行。
 * 可视区高 180px（layout.js 的 lyricViewPx）、行盒 38.4px（带译文 55.2px）→ 只有 3~5 行，
 * 所以 7 行足够铺满画面，不会露白。
 */
const WIN_SIDE = 3
const WIN_N = WIN_SIDE * 2 + 1
const FREEZE_MS = 3000 // 松手/最后一次操作之后，多久滑回当前行并恢复跟歌
const WATCHDOG_MS = 60000 // 超时强制结束拖动
/* ---- 双击跳转的判定阈值 ---- */
const TAP_SLOP = 6 // px：按下期间最大位移不超过它才算「点按」（否则算拖动）
const TAP_MAX_MS = 400 // 一次点按的最长持续时间
const DBL_MS = 600 // 两次点按**抬起时刻**之间的最长间隔（词典笔手写屏，放宽些）
const DBL_SLOP = 5 * VH // px：两次点按落点允许的偏差（≈半个行高）

export default {
  name: 'LyricPanel',
  mixins: [accentMixin],
  props: {
    /** [{time, text, trans}]，按时间升序（utils/player/lyric.js 产出） */
    lines: { type: Array, default: function () { return [] } },
    /** 当前行下标，-1 = 还没开始 */
    active: { type: Number, default: -1 },
    /** 是否显示翻译 */
    showTrans: { type: Boolean, default: true },
    /**
     * 是否整首铺开。
     * true = 整首铺开、可拖动翻看；
     * false = 省性能：只渲染当前行 ±3 行（共 7 行）且**禁用拖动**（位置恒为当前行居中）。
     */
    full: { type: Boolean, default: true },
    /** 是否允许双击歌词跳转到该行 */
    dblTap: { type: Boolean, default: true },
    emptyText: { type: String, default: '暂无歌词' }
  },
  data() {
    return {
      topOff: 0, // 内容坐标位移 = 第 0 行顶边距面板顶边的 px（可负）
      dur: 0, // 过渡时长（数字，毫秒）
      dragging: false, // 手指按住中
      hold: false, // 松手后仍在停留期（**同样冻结**，见 startHold）
      dragIdx: -1, // 冻结的「当前行」（-1 = 没冻结）
      /**
       * 省性能窗口的起点行号（0 = 从第 0 行开始渲染）。
       * ⚠ **必须是 data 字段**，不能做成 computed（真机修 bug）：
       * 挂在 `layoutActive → hlIndex → active` 这条 computed 链上时，换行**不会触发重算**，
       * 实测就是「永远停在前 7 行，后面的行加载不出来」。整首模式一直是好的，
       * 因为它走的是 `active` watcher → data(`topOff`) 的**显式通路**；窗口照抄这条。
       */
      winStart: 0
    }
  },
  computed: {
    /**
     * 是否处于「锁定」态（= 省性能模式）。
     * 锁定时面板不接受拖动，位置恒为「当前行居中」—— 见 trackStyle 与 onDown。
     */
    locked() {
      return !this.full
    },
    /** 冻结中的当前行（-1 = 没冻结）。拖动中与停留期中都算冻结 */
    frozenIdx() {
      return (this.dragging || this.hold) && this.dragIdx >= 0 ? this.dragIdx : -1
    },
    /** 高亮的行：冻结期间也用冻结值 —— 否则用户正看着，歌曲自己往下跳，就是「跟用户抢」 */
    hlIndex() {
      const f = this.frozenIdx
      return f >= 0 ? f : this.active
    },
    /** 排版用的当前行（不能是 -1） */
    layoutActive() {
      const a = this.hlIndex
      return a < 0 ? 0 : Math.min(a, Math.max(0, this.lines.length - 1))
    },
    /**
     * 整首歌词的行盒（**只跟歌词与翻译开关有关，绝不依赖播放进度**）。
     * 换行时这个数组引用不变 → 渲染器不用重建行节点，铺全部行也不卡。见文件头说明 1。
     */
    rowsAll() {
      const n = this.lines.length
      const out = []
      for (let i = 0; i < n; i++) {
        const line = this.lines[i] || {}
        const hasTr = !!(this.showTrans && line.trans)
        out.push({
          i: i,
          text: line.text || '',
          trans: line.trans || '',
          h: MAIN_H + (hasTr ? TRANS_H : 0),
          hasTr: hasTr
        })
      }
      return out
    },
    /** 实际参与渲染的行（full 时就是整首；省性能时恒为 WIN_N 行，末端会短一点） */
    rowsView() {
      if (!this.locked) return this.rowsAll
      return this.rowsAll.slice(this.winStart, this.winStart + WIN_N)
    },
    /** 轨道几何：自动跟随的位移目标 + 可拖动范围（px）——都是**内容坐标** */
    geo() {
      const rows = this.rowsAll
      const center = lyricViewPx() / 2
      if (!rows.length) return { auto: 0, min: 0, max: 0 }
      const act = this.layoutActive
      let before = 0 // act 之前各行高度和
      let actH = MAIN_H
      let total = 0
      for (let i = 0; i < rows.length; i++) {
        const h = rows[i].h
        if (i < act) before += h
        if (i === act) actH = h
        total += h
      }
      return {
        // 当前行居中
        auto: center - before - actH / 2,
        // 拖动不露白：第一行最多居中，最后一行最多居中
        max: center - rows[0].h / 2,
        min: center - (total - rows[rows.length - 1].h / 2)
      }
    },
    trackStyle() {
      // 位移 `topOff` 是**第 0 行**顶边的面板坐标，而轨道只渲染窗口那一段
      // （轨道内第 s 行的自身偏移是 0），所以要把「窗口起点之前的高度」**加**回来：
      //     T = topOff + prefix(s)
      // ⚠ **是加不是减**（修）：推导 —— 面板 y(第 i 行) = T + (prefix(i) − prefix(s))
      //    必须等于 topOff + prefix(i) ⇒ T = topOff + prefix(s)。写成减号时第 s 行会整体上移
      //    2×prefix(s)，窗口一挪画面就飞出可视区（整首模式 s=0、prefix=0，所以这个错一直藏着）。
      // 窗口与位移由同一个 watcher 在同一帧写好，画面不会跳。
      const shift = this.prefixBefore(this.winStart)
      return {
        transform: 'translateY(' + Math.round(this.topOff + shift) + 'px)',
        transitionDuration: this.dragging ? 1 : this.dur
      }
    },
    /** 译文行的行盒（与 layout.js 的 LYRIC.TRANS_H=7 成对——行盒高参与行距/居中数学，
     *  行高显式收紧到 1.1 倍字号，与 mainStyle 同一套路）。
     *  ⚠ 必须是 computed：模板 `:style="transStyle"` 编译为取字段，写成 method 取到的是
     *  函数 → 样式静默失效、渲染行盒与数学不符（巡检逮到并修）。 */
    transStyle() {
      return { fontSize: '6vh', lineHeight: '6.6vh' }
    }
  },
  watch: {
    /** 切到省性能：清掉可能在途的拖动状态（否则 dragging 会卡在 true，onUp 之后全被拖动态拦住） */
    full() {
      if (!this.locked) return
      this.dragging = false
      this.hold = false
      this.dragIdx = -1
      this._lastTap = null
      this.clearTimers()
      this.syncWindow()
      this.snapToCurrent(0) // 瞬时归位：从「拖动到别处」切过来不该滑一段
    },
    active(n) {
      // ⚠ 平台坑：本平台 watcher 不用「值是否真变了」去重（实测：
      // 同一个 id 被以 500ms 频率重复回调），所以这里自己判重 ——
      // 否则每 tick 都会重算位移、重放过渡动画，看起来就是歌词在抖。
      if (n === this._lastActive) return
      this._lastActive = n
      // 拖动中 / 停留期中：不跟歌走（用户正在翻看，别抢）
      if (this.dragging || this.hold) return
      this.syncWindow() // ⚠ 必须先挪窗口：只有这里能可靠地推动它（见 data.winStart 的注释）
      this.snapToCurrent(300)
    },
    showTrans() {
      if (this.dragging || this.hold) return // 解冻时会自己滑到正确位置
      this.syncWindow()
      this.snapToCurrent(300)
    },
    lines() {
      this.syncWindow()
      this.snapToCurrent(0)
    }
  },
  mounted() {
    this._lastActive = this.active
    this.syncWindow()
    this.snapToCurrent(0)
  },
  beforeDestroy() {
    this.clearTimers()
  },
  methods: {
    /** 第 0..s-1 行的高度和（px）——窗口起点换算回内容坐标用 */
    prefixBefore(s) {
      const rows = this.rowsAll
      let acc = 0
      const e = Math.min(s, rows.length)
      for (let i = 0; i < e; i++) acc += rows[i].h
      return acc
    },
    /**
     * 重算省性能窗口的起点（**写进 data.winStart**，见那里的注释说明为什么不能是 computed）。
     *
     * 锁定态下面板位置恒为「当前行居中」，所以窗口直接取 `当前行 − WIN_SIDE`，
     * 到头/到尾时夹住（第 0 行与最后一行各自成为窗口的一端）。
     * 只有换行时这个值才变 —— 行节点也只在那时重建一次，这是省性能模式的全部收益来源。
     * 调用点：active / lines / showTrans / full 四个 watcher + mounted，**别漏**。
     */
    syncWindow() {
      const n = this.rowsAll.length
      let s = 0
      if (this.locked && n > WIN_N) {
        s = this.layoutActive - WIN_SIDE
        if (s > n - WIN_N) s = n - WIN_N
        if (s < 0) s = 0
      }
      if (s === this.winStart) return
      this.winStart = s
      log('lyric', '歌词窗口 s=' + s + ' 当前行=' + this.layoutActive +
        ' 总行数=' + n + ' 渲染=' + (n ? Math.min(WIN_N, n - s) : 0) + ' 行')
    },
    /** 平移轨道到当前行（ms=0 表示瞬时对齐，不做过渡）；冻结期间不动 */
    snapToCurrent(ms) {
      if (this.dragging || this.hold) return
      this.dur = ms
      this.topOff = this.geo.auto
    },
    /**
     * 进入停留期：松手后**仍然冻结** FREEZE_MS，期间歌曲换行也不会把内容拽走
     * （原来一松手就立刻跟歌走，用户翻到一半就被拽回去 = 跟用户抢）。
     * 期间任何一次按下都会 clearTimers + 重新计时，所以连着翻可以一直停着；
     * 到期才滑回当前行、恢复跟歌。
     */
    startHold() {
      this.hold = true
      const self = this
      this._rt = setTimeout(function () {
        self.hold = false
        self.dragIdx = -1
        self.snapToCurrent(300)
      }, FREEZE_MS)
    },
    clearTimers() {
      if (this._rt) {
        clearTimeout(this._rt)
        this._rt = null
      }
      if (this._wd) {
        clearTimeout(this._wd)
        this._wd = null
      }
    },
    onDown(e) {
      const y = touchAxis(e, 'y')
      if (!isFinite(y)) return // 取不到坐标就当没按（别让轨道莫名跳走）
      this.logRawOnce(e) // 诊断：确认坐标字段与实际约定（每次进页面只打一条）
      this.clearTimers()
      this._startY = y
      this._moved = 0 // 本次按下的最大位移（判定这是点按还是拖动）
      this._downT = Date.now()
      // 省性能模式：**不进拖动** —— 窗口只有 7 行，往上翻也没得翻；面板位置由
      // trackStyle 恒定为「当前行居中」。点按仍记着，所以双击跳行照样能用（见 onUp）。
      if (this.locked) return
      this._startOff = this.topOff
      // 停留期里再按下去：**沿用同一个冻结值**，别把用户正在看的位置弹回去
      const keep = this.frozenIdx
      this.dragging = true
      this.hold = false
      this.dragIdx = keep >= 0 ? keep : this.active
      this.dur = 1
      // 固件不发 touchend 的兜底
      const self = this
      this._wd = setTimeout(function () {
        self.onUp()
      }, WATCHDOG_MS)
    },
    /**
     * 诊断（每次进页面只打一条）：把各候选坐标字段的原值打出来。
     *
     * 这条日志就是当初定位「双击跳上一行」用的：`pageY` 与 `screenY` 的差值 = 42px
     * = 面板顶边到屏幕顶边的距离，证明 **pageY 是节点相对坐标**（见 lineAtY 的注释）。
     * 换固件/换渲染器后如果双击又偏了，先看这条：差值这栏应当约等于面板顶边
     * （约 18vh ≈ 43px），若变成 0 说明该固件的 pageY 已经是页面绝对的，那时才需要减。
     */
    logRawOnce(e) {
      if (this._rawLogged) return
      this._rawLogged = true
      const pick = function (o) {
        if (!o) return '-'
        return [o.pageY, o.clientY, o.screenY, o.y].join('/')
      }
      const list = e && (e.changedTouches || e.touches || e.targetTouches)
      const t = (list && (list[0] || list)) || e || {}
      const d = (e && e.data) || {}
      const dy = (isFinite(Number(t.screenY)) && isFinite(Number(t.pageY)))
        ? Number(t.screenY) - Number(t.pageY) : NaN
      log('lyric', '坐标字段 pageY/clientY/screenY/y = ' + pick(t) +
        ' | data = ' + pick(d) + ' | detail = ' + pick(e && e.detail) +
        ' | screenY-pageY=' + (isFinite(dy) ? Math.round(dy) : '-') +
        ' off=' + Math.round(this.topOff))
    },
    onMove(e) {
      const y = touchAxis(e, 'y')
      if (isFinite(y)) {
        // 位移一律记账（省性能模式下也记：滑动过就不算点按，免得误触发双击跳转）
        const d = Math.abs(y - this._startY)
        if (d > this._moved) this._moved = d
      }
      if (this.locked || !this.dragging) return
      if (!isFinite(y)) return
      const g = this.geo
      let v = this._startOff + (y - this._startY)
      if (v > g.max) v = g.max
      if (v < g.min) v = g.min
      this.topOff = v
    },
    onUp(e) {
      // 省性能模式：没有拖动就没有「停留期 / 滑回当前行」这回事，只走点按判定
      if (this.locked) {
        const dl = Date.now() - this._downT
        if (this._moved <= TAP_SLOP && dl <= TAP_MAX_MS) this.onTap(e)
        else this._lastTap = null
        return
      }
      if (!this.dragging) return
      this.dragging = false
      this.clearTimers()
      // 点按（没怎么动、也没按太久）才进双击判定；拖动过就作废上一次点按
      const dt = Date.now() - this._downT
      if (this._moved <= TAP_SLOP && dt <= TAP_MAX_MS) this.onTap(e)
      else this._lastTap = null
      if (this._jumped) {
        // 刚双击跳转过：用户就是要跳到那行，**立即解冻恢复跟歌**（别冻着等他）。
        // 这里不主动回位 —— seek 是异步的（没缓存时还要先下载），等它落地、
        // active 变了，active watcher 会用 300ms 平滑滑过去，只走一次；若当场回位
        // 就成了「先弹回旧行、再滑到新行」两段走。
        this._jumped = false
        this.hold = false
        this.dragIdx = -1
        return
      }
      this.startHold() // 其余情况：松手后 3 秒停留期，谁都别动
    },
    /**
     * 点按：攒够两次就是双击 → 跳转到该行。
     *
     * 判定看「**两次抬起**之间的间隔」而不是「第二次按下与第一次抬起之间」——
     * 词典笔的手写笔触拖得慢，窗口放宽到 DBL_MS 更跟手；两次落点还要在
     * DBL_SLOP 以内，否则当成两次独立的点按。
     */
    onTap(e) {
      if (!this.dblTap) return // 设置里关掉了「双击跳转」
      const y = touchAxis(e, 'y')
      const yy = isFinite(y) ? y : this._startY // 有的固件 touchend 不带坐标，退回按下时的 y
      const now = Date.now()
      const last = this._lastTap
      this._lastTap = { t: now, y: yy }
      if (!last || !isFinite(yy)) return
      if (now - last.t > DBL_MS) return
      if (!isFinite(last.y) || Math.abs(yy - last.y) > DBL_SLOP) return
      this._lastTap = null // 用掉这组，避免三连击触发两次
      const idx = this.lineAtY(yy)
      log('lyric', '双击歌词 y=' + Math.round(yy) + ' off=' + Math.round(this.topOff) +
        ' 行数=' + this.lines.length + ' 渲染=' + this.rowsView.length +
        ' act=' + this.active + ' -> idx=' + idx)
      if (idx >= 0) {
        this._jumped = true // 让 onUp 跳过停留期：跳过去之后就该跟着走了
        this.$emit('seekline', idx)
      }
    },
    /**
     * 手指的 y → 行下标（-1 = 没落在任何行上）。
     *
     * ⚠ **不要再减面板顶边**（实机踩过）：
     * 本固件的 `pageY`（touchAxis 的首选字段）是**相对「触发触摸的节点」**的坐标，
     * 而不是页面绝对坐标 —— 这里触发节点就是歌词面板本身。实测证据（两首歌、不同位置
     * 各采一次，同一次触摸的两个字段）：
     *     pageY=124 / screenY=166    pageY=135 / screenY=177
     * 差值恒为 **42px**，正是面板顶边到屏幕顶边的距离（`screenY` 才是屏幕绝对的）。
     * 先前按「pageY = 页面绝对」又减了 43.2px，结果每次双击都跳到**上一行**。
     *
     * 于是反推只剩一步：面板内 y − 轨道位移(off) = 轨道内 y（轨道原点 = 第 0 行的顶边），
     * 再按各行**行盒高度**累加定位。行盒高度是我们自己以 px 写进内联样式的（见 rowStyle），
     * 与这里用的是同一组数，所以不受「vh 到底相对谁解析」这类不确定性影响。
     * 轨道被 geo 的 min/max 夹住，长歌词不会露白。
     */
    lineAtY(yPx) {
      const rows = this.rowsAll
      if (!rows.length || !isFinite(yPx)) return -1
      const t = yPx - this.topOff
      if (t < 0) return -1
      let acc = 0
      for (let k = 0; k < rows.length; k++) {
        acc += rows[k].h
        if (t < acc) return rows[k].i
      }
      return -1 // 落在轨道下方（短歌词尾部的留白）
    },
    /* ---- 行内样式（平台不支持 .a.b 复合选择器，状态一律内联） ---- */
    rowStyle(r) {
      return { height: r.h + 'px' }
    },
    markStyle(r) {
      const on = r.i === this.hlIndex
      return {
        height: on ? Math.round(r.h * 0.5) + 'px' : '0px',
        backgroundColor: on ? this.accent.c : 'transparent'
      }
    },
    mainStyle(r) {
      const on = r.i === this.hlIndex
      return {
        fontSize: on ? '10.5vh' : '8vh',
        // 显式行高并压到约 1.1 倍字号（默认行高约 1.3 倍，原文与译文之间会凭空多出一截）
        lineHeight: on ? '11.5vh' : '8.8vh',
        fontWeight: on ? 'bold' : 'normal',
        color: on ? TOK.text : '#c9c9d1' // 非高亮色是单例（#c9c9d1），待归类
      }
    },
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

.lp-view {
  flex: 1;
  overflow: hidden;
  position: relative;
}
.lp-track {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  flex-direction: column;
}
.lp-row {
  flex-direction: row;
  align-items: center;
  /* 左内边距 1.4 → 4.4vh（歌词往右挪一点，避免与左侧控制行按钮重叠）：控制行按钮放大后其右缘逼近歌词文字左缘，把歌词内容
     （含高亮竖条）整体右移；标题行不动，这样只拉开歌词与按钮的距离。 */
  padding-left: 4.4vh;
}
.lp-mark {
  width: 0.7vh;
  border-radius: 50vh;
  margin-right: 2.2vh;
}
.lp-text {
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  overflow: hidden;
}
/* 左对齐（参照 PenMusic）；长行截断，行盒高度固定不随内容变。
   原文与译文贴紧：间距主要由两处控制 —— 这里的 margin（已归零）与 mainStyle 里的
   显式 lineHeight（已压到 1.1 倍）；行距则是 layout.js 的 LYRIC.MAIN_H。 */
.lp-main {
  margin-bottom: 0;
  lines: 1;
  text-overflow: ellipsis;
}
.lp-trans {
  color: @text-3;
  lines: 1;
  text-overflow: ellipsis;
}
.lp-empty {
  font-size: @fs-dim;
  color: @text-3;
  padding-left: 5.2vh; /* 与 .lp-row 的缩进同步（同 +3vh），空态文字不与按钮行的右缘挨着 */
}
</style>
