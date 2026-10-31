<template>
  <div
    class="lb-view"
    @touchstart="onDown"
    @touchmove="onMove"
    @touchend="onUp"
    @touchcancel="onUp"
  >
    <!-- 空态与轨道二选一（v-else 必须紧贴 v-if 节点，中间不能夹注释） -->
    <text class="lb-empty" v-if="!lines.length">{{ emptyText }}</text>
    <!-- 行节点在同目录的 LyricTrack 里（拖动时本组件每帧重渲染，行轨只在「窗口滑动」那几帧才重渲染） -->
    <div class="lb-track" v-else :style="trackStyle">
      <lyric-track :rows="rowsView" :hl="hlIndex" />
    </div>
  </div>
</template>

<script>
/**
 * 歌词面板（播放页右侧子面板，设计稿 PlayerPage 14:1570 的 LyricPanel 14:1753，480×240）
 *
 * 本组件只负责「歌词轨道」本身：根节点铺满父容器、自己不上底色（父级给 TOK.subBg #272727
 * 与左侧圆角）。父页面把它放进 480×240 的子面板槽位即可。
 *
 * 几何（设计稿 px，1vh = 2.4px；完整几何表见 docs/播放页.md）：
 *   面板左右 padding 10px；行距 12px；当前行垂直居中于 240 高面板（中线 y=120）。
 *   行结构 = 指示条容器（宽 3px，上下各内缩 8px）+ 间距 4px + 文本列（左右 padding 6px）；
 *   文本列里原文一行 +（有译文且 showTrans 时）译文一行，间距 2px。
 *   行内左右还有 4px padding（dc_lyric 里 LyricLine 的 px-[4px]）：于是「面板 10 + 行 4」
 *   让指示条左缘落在面板内 14px、文字左缘落在 27px —— 与 shot_player.png 的像素扫描一致。
 *
 * 行盒高度（px，位移数学与渲染共用同一组数，1vh=2.4px 同源）：
 *   原文行高 非当前 26.4 / 当前 31.2；译文行高 非当前 19.2 / 当前 24；
 *   行盒高 无译文 = 原文行高（26.4 / 31.2）；
 *   有译文 = 原文行高 + 2 + 译文行高（非当前 47.6 / 当前 57.2）。
 *   字号走 vh（非当前 9.17 / 6.67，当前 10.83 / 8.33），行高走 px —— 因为行盒高度要参与
 *   逐行累加求位移，必须与渲染出来的盒子严格同一组数（vh 小数换算过来的值就写 px）。
 *
 * ---- 只渲染可见歌词（窗口化，2026-10-31）----
 * `rowsAll` 仍按整首算（行盒/样式/前缀和），但**参与渲染的只有窗口 `[winStart, winEnd)`**：
 * 可视范围上下各留 `BUF_PX`（≈4~6 行）缓冲，一首歌 60~120 行时实际只渲染 7~19 行
 * （无译文 10~19 行、带译文 7~13 行；首尾会更少，因为内容尽头之外本来就只有留白）。
 *
 * 窗口化必须守住两条不变量（改之前先看懂）：
 *   1. **面板 y(行 i) = topOff + rowTop(i)** —— 与窗口起点无关。所以换窗口本身不改变画面，
 *      前提是位移在**同一帧瞬时生效**：trackStyle 的 T = topOff + rowTop(winStart)，
 *      窗口与 T 一起变、且 transitionDuration 为 INSTANT_MS 时，T 的变化正好被
 *      「轨道内相对位置」抵消。窗口变化一律走 `syncWindow` + 调用方保证瞬时帧。
 *   2. **平滑滑动期间窗口不动**：在途 transition 的起点值是上一次的 T，这时换窗口会让
 *      起点失真 → 画面瞬跳。所以滑动前先判断当前窗口能否覆盖整段扫过的范围
 *      （`windowCovers`）；覆盖不了就**瞬时对齐**（手动拖得很远后回位、双击跳转都走这条），
 *      滑动结束后再把窗口按当前位置收回（`afterSlide`）。
 *
 * ---- 拖动性能（2026-10-31 优化，四条，别再退回） ----
 *   1. **行节点渲染拆到子组件 LyricTrack**：拖动帧里本组件会重渲染（topOff 是 data），
 *      行节点留在这里的话每帧都要重建整段 vnode；拆开后只有窗口滑动那几帧子组件才重渲染
 *      （每次 7~19 行），其余帧只重建 3 个 vnode。
 *   2. **行样式对象在 rowsAll 里预算好**（每行 on/off 两套、引用稳定，见 buildRow）：
 *      换行时只有旧/新两行的引用变，其余行 style 值与上次逐项相同 → Vue 的 style 补丁
 *      不产生原生样式写入。
 *   3. **前缀和预算在 rowsAll 里**（每行 `prefix`）：geo / 窗口位移 / lineAtY 都不再逐帧
 *      O(n) 累加，拖动、换行、双击定位都是 O(1)~O(n) 的一次性计算。
 *   4. **touchmove 帧合并**（MOVE_MS）：触摸事件到达频率可能高于渲染帧率，多出来的每一次都会
 *      触发一次重渲染 + 一次原生 transform 写入，纯浪费；touchend 再补最后一帧（applyDrag）。
 *
 * 平移不是滚动容器：整条轨道只用一次 transform: translateY()，位移公式
 *   offset = 面板中线 120 − 当前行之前各行(含行距)累计高 − 当前行行盒高/2
 * 并按首/末行夹紧：
 *   拖动的下界 = 最后一行居中（min）、上界 = 第一行居中（max），拖不出空白。
 *
 * ---- 交互 ----
 *   1. 拖动跟手：touchmove 用两点 y 之差改 offset（坐标系绝对还是相对都无所谓，两点之差无关）；
 *      拖动期间 transitionDuration = INSTANT_MS。
 *   2. **高亮始终跟播放进度**：手动翻看时活动行照样更新，不冻结。
 *   3. **活动行更新时平滑滚动**（`follow` 开关，默认开）：换行 → SNAP_MS 滑到该行。
 *      手指按着的时候**不滚**（否则位移基准 _startOff 失效、内容会在指下跳），
 *      松手后的下一次换行再滑回；`follow=false` = 只换高亮、轨道不动，方便手动翻看。
 *   4. 双击某行 → emit seekline（全量 lines 的下标）。一次点按期间位移 ≤6px 且时长 ≤400ms；
 *      两次点按抬起间隔 ≤600ms 且落点差 ≤12px（词典笔手写屏放宽阈值）。
 *   5. 60 秒看门狗兜底 touchend 缺失的固件（超时强制走 onUp）。
 *   6. pageY 是「相对触发触摸的节点」的坐标（本固件实测，见 lineAtY 注释）：本组件根节点就是
 *      触摸目标、且轨道贴根节点顶边，所以「面板内 y − 轨道位移」就是轨道内容坐标。
 *   7. watcher 入口自己判重（平台 watch 不去重，同一个 active 会以播放器 tick 频率重复回调）。
 *
 * 关于「高亮行变成大字号」的过渡：
 *   设计稿要求当前行 26px / 行盒 57.2、其余 22px / 47.6，所以换行那一帧行盒高、字号、行高、
 *   颜色会一起变。这里给这批属性**声明了 transition**（`HL_MS`，与平移同长），
 *   支持就平滑、不支持就等价于原来的瞬时切换（不会报错）。
 *   ⚠ 除 transform 外的属性过渡在本平台**没有真机验证**（docs/性能与动效优化.md §六.2），
 *   所以是「尽量平滑、不保证」；要退回硬切就把 HL_MS 改成 1。
 *
 * 平台硬约束（逐条遵守）：样式只有单类名；状态/动态色全走内联 :style；text 不嵌套；
 * data 字段先声明；模板裸绑定只来自 props/computed/data；行距用 margin 不用 gap；
 * 颜色走 TOK / accent（本文件没有颜色字面量）。
 */
import LyricTrack from './LyricTrack.vue'
import { touchAxis } from '../../utils/touch.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { TOK } from '../../utils/ui/tokens.js'

/* ---- 几何常量（设计稿 px；1vh = 2.4px）---- */
const PANEL_H = 240 // 子面板高（设计稿固定 480×240）
const CENTER_Y = PANEL_H / 2 // 120：当前行行盒中线对齐到这里
const GAP = 12 // 行距（上下两行盒子之间的距离）
const MARK_PAD_Y = 8 // 指示条容器上下各内缩 8px
const WATCHDOG_MS = 60000 // touchend 缺失兜底
const SNAP_MS = 300 // 跟歌 / 翻译开关后的平滑平移时长
const INSTANT_MS = 1 // 「瞬时」帧的过渡时长（不要用 0：有些渲染器把 0 当没设置、回落默认动画）
const MOVE_MS = 16 // touchmove 帧合并窗口（≈ 一帧）
/**
 * 可视范围之外的渲染缓冲（px，≈4 行）。两个作用：
 *   1. 平滑滑动期间窗口不动，靠它在两侧兜住「扫过」的内容；
 *   2. 拖动时窗口不会每 1px 就换一次。
 * 取 240 = 一个面板高：相邻行滑动（约 60px）和落后 3~4 行时回位都能平滑，
 * 再远的跨度（手动拖很远 / 双击跳转）直接瞬时对齐，不渲染中间段。
 */
const BUF_PX = 240
const TAP_SLOP = 6 // px：按下期间最大位移 ≤ 它才算点按
const TAP_MAX_MS = 400 // 一次点按的最长时长
const DBL_MS = 600 // 两次点按抬起之间的最长间隔
const DBL_SLOP = 12 // px：两次点按落点允许偏差（≈半个非当前行行高）
/** 高亮切换（行盒高/字号/行高/颜色）的过渡时长；= 1 即硬切（见文件头说明） */
const HL_MS = SNAP_MS

/* 字号走 vh（平台实测可用）；行高走 px（参与位移数学，必须与渲染同源） */
const FS_MAIN = { on: '10.83vh', off: '9.17vh' } // 26px / 22px
const FS_TRANS = { on: '8.33vh', off: '6.67vh' } // 20px / 16px
const LH_MAIN = { on: 31.2, off: 26.4 } // px
const LH_TRANS = { on: 24, off: 19.2 } // px
const TRANS_GAP = 2 // 原文与译文之间的间距（px）
/* 行盒高（px）：无译文 = 原文行高；有译文 = 原文行高 + 2 + 译文行高。
   round1 只为让内联样式输出干净的 "47.6px"（浮点相加会得到 47.599999...） */
function round1(v) {
  return Math.round(v * 10) / 10
}
const ROW_H_MAIN = { on: LH_MAIN.on, off: LH_MAIN.off } // 31.2 / 26.4
const ROW_H_TRANS = {
  on: round1(LH_MAIN.on + TRANS_GAP + LH_TRANS.on), // 57.2
  off: round1(LH_MAIN.off + TRANS_GAP + LH_TRANS.off) // 47.6
}

/* ---- 行内样式生成（**只在 rowsAll 里跑一次**；返回对象给模板长期复用，见文件头 2） ---- */
/** 行盒 / 指示条容器：只有高度会随高亮变 */
function boxStyle(h) {
  return {
    height: h + 'px',
    transitionProperty: 'height',
    transitionDuration: HL_MS
  }
}
/** 指示条：非当前行高度 0（隐藏），颜色恒为主题色 */
function markStyle(h, on, accentC) {
  const mh = round1(h - MARK_PAD_Y * 2)
  return {
    height: on ? (mh > 0 ? mh : 0) + 'px' : '0px',
    marginTop: MARK_PAD_Y + 'px',
    backgroundColor: accentC,
    transitionProperty: 'height',
    transitionDuration: HL_MS
  }
}
/** 文本：字号 / 行高 / 颜色随高亮变。非当前行用「次要 / 弱」文字色**实色**弱化，
 *  不用 opacity —— 半透明文本要走 alpha 合成、还会连带子节点，比直接换 fill 颜色贵，
 *  而且本面板要的是固定一档弱化色、不是淡入淡出。 */
function textStyle(fontSize, lineHeight, color) {
  return {
    fontSize: fontSize,
    lineHeight: lineHeight + 'px',
    color: color,
    transitionProperty: 'fontSize,lineHeight,color',
    transitionDuration: HL_MS
  }
}
/** 一行 = 数据 + 5 组 on/off 样式对象（引用稳定，换行只换被点到的那两行） */
function buildRow(i, line, hasTr, hOff, hOn, prefix, accentC) {
  return {
    i: i,
    text: line.text || '',
    trans: line.trans || '',
    hasTr: hasTr,
    hOff: hOff, // 非当前行行盒高（px）
    hOn: hOn, // 当前行行盒高（px）
    prefix: prefix, // 内容坐标：本行顶边（前面各行按非当前行高累计，见 rowsAll）
    sRowOff: boxStyle(hOff),
    sRowOn: boxStyle(hOn),
    sBoxOff: boxStyle(hOff),
    sBoxOn: boxStyle(hOn),
    sMarkOff: markStyle(hOff, false, accentC),
    sMarkOn: markStyle(hOn, true, accentC),
    sMainOff: textStyle(FS_MAIN.off, LH_MAIN.off, TOK.text2),
    sMainOn: textStyle(FS_MAIN.on, LH_MAIN.on, TOK.text),
    sTransOff: textStyle(FS_TRANS.off, LH_TRANS.off, TOK.text3),
    sTransOn: textStyle(FS_TRANS.on, LH_TRANS.on, TOK.text2)
  }
}

export default {
  name: 'LyricBoard',
  components: { 'lyric-track': LyricTrack },
  mixins: [accentMixin],
  props: {
    /** [{time, text, trans}]，按时间升序（utils/player/lyric.js 产出） */
    lines: { type: Array, default: function () { return [] } },
    /** 当前行下标，-1 = 还没开始（未开始时不显示指示条，视口仍以第 0 行为准居中） */
    active: { type: Number, default: -1 },
    /** 是否显示译文 */
    showTrans: { type: Boolean, default: true },
    /**
     * true = 可拖动翻看整首（位置由用户控制）；
     * false = 省性能（兼容老配置 lyricFull=false）：**禁用拖动**，位置恒为「当前行居中」，
     *         只保留双击跳行。两种模式都只渲染可视范围（见文件头「窗口化」）。
     */
    full: { type: Boolean, default: true },
    /**
     * 活动行更新时是否平滑滚动到该行（设置项「自动跟歌」，默认开）。
     * false = 只更新高亮、轨道不动（手动翻看时不会被拽走）。
     * 省性能模式（full=false）恒为跟随：那时位置只能由播放进度决定。
     */
    follow: { type: Boolean, default: true },
    /** 是否允许双击歌词跳转到该行 */
    dblTap: { type: Boolean, default: true },
    /** 空态文案（暂无歌词 / 纯音乐，请欣赏 等由页面决定） */
    emptyText: { type: String, default: '暂无歌词' }
  },
  data() {
    return {
      /** 轨道位移（px）：第 0 行顶边相对面板顶边的 y，可为负 */
      topOff: 0,
      /** 过渡时长（数字毫秒；拖动/瞬时对齐用 INSTANT_MS） */
      dur: INSTANT_MS,
      /** 手指按住中（只用来「按着时别自动滚」，高亮照样更新） */
      dragging: false,
      /** 渲染窗口（左闭右开，按 rowsAll 下标）：只渲染这一段 */
      winStart: 0,
      winEnd: 0
    }
  },
  computed: {
    /** 锁定态 = full=false 的省性能模式（不接受拖动、位置恒跟当前行） */
    locked() {
      return !this.full
    },
    /** 高亮行：**永远跟随播放进度**（不再有拖动/停留期冻结） */
    hlIndex() {
      return this.active
    },
    /** 排版用的当前行（不能是 -1；越界也夹回来） */
    layoutActive() {
      const a = this.hlIndex
      const n = this.lines.length
      const last = n > 0 ? n - 1 : 0
      return a < 0 ? 0 : a > last ? last : a
    },
    /**
     * 整首歌词的行盒（只跟歌词 / 翻译开关 / 主题色有关，绝不依赖播放进度）：
     * 换行时数组引用不变 → 子组件 LyricTrack 不重渲染（窗口内行节点的样式也全部来自这里）。
     * 每行带 5 组 on/off 样式对象与一个前缀和，全部在这里一次算好。
     */
    rowsAll() {
      const n = this.lines.length
      const out = []
      const accentC = this.accent.c
      let prefix = 0
      for (let i = 0; i < n; i++) {
        const line = this.lines[i] || {}
        const hasTr = !!(this.showTrans && line.trans)
        const hOff = hasTr ? ROW_H_TRANS.off : ROW_H_MAIN.off
        const hOn = hasTr ? ROW_H_TRANS.on : ROW_H_MAIN.on
        out.push(buildRow(i, line, hasTr, hOff, hOn, prefix, accentC))
        prefix += hOff + GAP
      }
      return out
    },
    /** 真正参与渲染的行：只有窗口 `[winStart, winEnd)`（窗口由 syncWindow 维护） */
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
    /** 轨道几何：自动跟随的位移目标 + 拖动范围（px），都是内容坐标。O(1)（前缀和） */
    geo() {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return { auto: 0, min: 0, max: 0 }
      const act = this.layoutActive
      const actH = this.rowH(act)
      return {
        // 当前行居中
        auto: CENTER_Y - this.rowTop(act) - actH / 2,
        // 拖动不露白：第一行最多居中
        max: CENTER_Y - this.rowH(0) / 2,
        // 最后一行最多居中（再往下拖就会在底部露出空白）
        min: CENTER_Y - (this.contentH() - this.rowH(n - 1) / 2)
      }
    },
    /**
     * 轨道样式：整条轨道只做一次 translateY。
     * T = topOff + rowTop(winStart) —— 窗口只渲染从 winStart 开始的那段，
     * 要把「窗口起点之前的高度」**加**回来（是加不是减，老组件修过）：
     *   面板 y(第 i 行) = T + (rowTop(i) − rowTop(s)) 必须等于 topOff + rowTop(i) ⇒ T = topOff + rowTop(s)
     * 窗口（data）与 topOff（data）在同一帧写好，且窗口变化一定伴随 INSTANT_MS，
     * 所以画面不变（见文件头「两条不变量」）。
     */
    trackStyle() {
      const rows = this.rowsAll
      const n = rows.length
      const shift = n ? this.rowTop(Math.max(0, Math.min(this.winStart, n - 1))) : 0
      return {
        transform: 'translateY(' + Math.round(this.topOff + shift) + 'px)',
        // 拖动时 INSTANT_MS（跟手）
        transitionDuration: this.dragging ? INSTANT_MS : this.dur
      }
    }
  },
  watch: {
    /** 切换「可拖动 / 省性能」：清掉在途状态，窗口与位移瞬时归位 */
    full() {
      this.dragging = false
      this._lastTap = null
      this.clearTimers()
      this.applyJump(this.geo.auto)
    },
    /**
     * 换行：高亮由渲染自动跟上（hlIndex = active）；**滚动**才看开关与手指状态。
     * 平台坑：watcher 不用「值是否真变了」去重（同一个值会以播放器 tick 频率重复回调），
     * 入口必须自己判重。
     */
    active(n) {
      if (n === this._lastActive) return
      this._lastActive = n
      if (this.dragging) return // 按着时不动轨道（见文件头交互 3）
      if (!this.follow && !this.locked) return // 关掉自动跟歌：只换高亮
      this.snapToCurrent(SNAP_MS)
    },
    /** 翻译开关：行盒行数变了 → 重新排版，跟随状态下顺带重新居中 */
    showTrans() {
      if (this.dragging) {
        // 拖动中：只把窗口按新布局重算（拖动帧本来就是瞬时，换窗口不改画面）
        this.syncWindow(this.topOff, this.topOff)
        return
      }
      if (this.follow || this.locked) this.snapToCurrent(SNAP_MS)
      else this.applyJump(this.topOff) // 只重算窗口，不移动
    },
    /** 歌词换了（切歌）：瞬时归位，不要从上一首的位置滑一段 */
    lines() {
      if (this.dragging) {
        // 拖动中换歌：只重算窗口，别把轨道从手指下拽走
        this.syncWindow(this.topOff, this.topOff)
        return
      }
      this.applyJump(this.geo.auto)
    },
    /** 「自动跟歌」从关到开：立刻平滑滚回当前行（关掉时不动，保留用户位置） */
    follow(on) {
      if (!on || this.dragging) return
      this.snapToCurrent(SNAP_MS)
    }
  },
  created() {
    // 首帧就要有窗口：放在 created（props/computed 已就绪、还没首次渲染），
    // 否则「歌词已加载、之后才打开面板」时会先闪一帧空轨道
    this.dur = INSTANT_MS
    this.topOff = this.geo.auto
    this.syncWindow(this.topOff, this.topOff)
  },
  mounted() {
    // 页面会挂两遍：这里的初始化全部幂等（只依赖 props 重算）
    this._lastActive = this.active
    this.snapToCurrent(INSTANT_MS) // created 里已定位过；这里只是幂等地再对齐一次
    log('lyric', '歌词面板挂载 行数=' + this.rowsAll.length +
      ' 渲染=' + this.rowsView.length + ' 行（窗口 ' + this.winStart + '..' + this.winEnd + '）')
  },
  beforeDestroy() {
    this.clearTimers()
  },
  methods: {
    /** 某一行「此刻」的渲染行盒高（px）：当前行按加大字号，其余按普通字号 */
    rowH(i) {
      const rows = this.rowsAll
      if (i < 0 || i >= rows.length) return 0
      return i === this.hlIndex ? rows[i].hOn : rows[i].hOff
    },
    /**
     * 高亮造成的累计位移（px）：当前行比非当前行高出来的那部分。
     * 只有当前行**之后**的行会被它推下去，所以 rowTop(i) 只在 i > hlIndex 时加它。
     */
    activeDelta() {
      const rows = this.rowsAll
      const act = this.hlIndex
      if (act < 0 || act >= rows.length) return 0
      return this.rowH(act) - rows[act].hOff
    },
    /**
     * 第 i 行在**当前布局**下的内容坐标顶边（px）= 面板坐标 − topOff。
     *   rowTop(i) = prefix(i) + (i 在当前行之后 ? 当前行撑高的增量 : 0)
     * prefix 是 rowsAll 按「非当前行高」累加的前缀和（O(1)）；越界会夹到首/末行
     * （调用点都只在 [0, n) 内用，夹一下只为防窗口初始状态）。
     */
    rowTop(i) {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return 0
      const k = i < 0 ? 0 : i >= n ? n - 1 : i
      return rows[k].prefix + (this.hlIndex >= 0 && k > this.hlIndex ? this.activeDelta() : 0)
    },
    /** 当前布局的内容总高（px，含行距、按当前行实际行高） */
    contentH() {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return 0
      return this.rowTop(n - 1) + this.rowH(n - 1)
    },
    /**
     * 算窗口 [s, e)：覆盖「位移 from → to 这段滑动扫过的可见范围 + 上下 BUF_PX」。
     *
     * 扫过的内容范围：面板顶在内容坐标里是 −topOff，所以
     *   起点可见 = [−from, −from + 面板高]，终点可见 = [−to, −to + 面板高]，
     *   并集 = [−max(from,to), −min(from,to) + 面板高]（from=to 时就是当前可见范围）。
     * 行在内容坐标里占 [rowTop(i), rowTop(i)+rowH(i)]，取与之相交的行即窗口。
     * 线性扫描 O(n)：只在一帧一次，n 是歌词行数（≤ 几百），比逐帧重建 vnode 便宜得多。
     */
    findWindowRange(from, to) {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return { s: 0, e: 0 }
      const lo = -Math.max(from, to) - BUF_PX
      const hi = -Math.min(from, to) + PANEL_H + BUF_PX
      let s = 0
      while (s < n && this.rowTop(s) + this.rowH(s) <= lo) s++
      let e = s
      while (e < n && this.rowTop(e) < hi) e++
      return { s: s, e: e }
    },
    /**
     * 重算渲染窗口并写进 data（只有变化时才写，避免多余渲染）。
     * 调用方负责保证「这一刻位移是瞬时的」——见文件头不变量 1。
     */
    syncWindow(from, to) {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) {
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
    /**
     * 当前窗口能不能覆盖「从 a 滑到 b」扫过的可见范围（内容坐标）。
     * 覆盖不了就不能边滑边不换窗口 —— 调用方改为瞬时对齐（不渲染中间段）。
     *
     * 边界处理：窗口贴着歌词首/尾时（s=0 / e=n），可见范围越出内容两端是**正常留白**
     * （首行/末行居中时上下本来就有空），不算露白；行与行之间的 12px 行距同理（空的就是空的）。
     */
    windowCovers(a, b) {
      const rows = this.rowsAll
      const n = rows.length
      if (!n) return true
      const s = Math.max(0, Math.min(this.winStart, n - 1))
      const e = Math.max(s + 1, Math.min(this.winEnd, n))
      const last = e - 1
      const lo = s === 0 ? -Infinity : this.rowTop(s) - GAP
      const hi = last === n - 1 ? Infinity : this.rowTop(last) + this.rowH(last) + GAP
      const c0 = -Math.max(a, b)
      const c1 = -Math.min(a, b) + PANEL_H
      return c0 >= lo - 0.5 && c1 <= hi + 0.5
    },
    /**
     * 瞬时对齐到 target：位移与窗口**同一帧**、且过渡时长 INSTANT_MS ——
     * 此时各行面板位置不因窗口变化而改变（见文件头不变量 1）。
     */
    applyJump(target) {
      this.clearSnapTimer()
      this.dur = INSTANT_MS
      this.topOff = target
      this.syncWindow(target, target)
    },
    /**
     * 平滑滑到 target（ms > INSTANT_MS）。
     *
     * 走这条之前必须满足「窗口能覆盖扫过范围」，否则露白，所以覆盖不了就退回 applyJump。
     * 滑动期间窗口不动（不动的原因见文件头不变量 2），滑完由 afterSlide 收窗口。
     */
    snapToCurrent(ms) {
      if (this.dragging) return
      const target = this.geo.auto
      if (ms <= INSTANT_MS || !this.windowCovers(this.topOff, target)) {
        this.applyJump(target)
        return
      }
      if (target === this.topOff) {
        // 位置没变（行高变了但目标恰好相同）：只把窗口按新布局重算，瞬时
        this.applyJump(target)
        return
      }
      this.clearSnapTimer()
      this.dur = ms
      this.topOff = target
      this.afterSlide(ms)
    },
    /**
     * 平滑滑动结束后：按当前位置把窗口重算（收回「可视 + 缓冲」），并且**瞬时**生效。
     * 不做这一步的话，窗口会一直偏在滑动前的范围里，几次换行后就没法再平滑了。
     */
    afterSlide(ms) {
      this.clearSnapTimer()
      const self = this
      this._snapTimer = setTimeout(function () {
        self._snapTimer = null
        if (self.dragging) return
        self.dur = INSTANT_MS
        self.syncWindow(self.topOff, self.topOff)
      }, ms + 60)
    },
    clearSnapTimer() {
      if (this._snapTimer) {
        clearTimeout(this._snapTimer)
        this._snapTimer = null
      }
    },
    /**
     * 把当前手指位置换算成轨道位移并夹进拖动范围，同时让窗口跟着可视区走。
     * 位移按「按下点 + 两点之差」算（不是增量累加），所以帧合并丢掉中间事件也不影响精度；
     * 拖动帧里 dur = INSTANT_MS，换窗口不会改变各行面板位置（不变量 1）。
     */
    applyDrag(y) {
      const g = this.geo
      let v = this._startOff + (y - this._startY)
      if (v > g.max) v = g.max
      if (v < g.min) v = g.min
      if (v === this.topOff) return // 夹住后没变 → 不触发重渲染
      this.topOff = v
      this.syncWindow(v, v)
    },
    clearTimers() {
      if (this._wd) {
        clearTimeout(this._wd)
        this._wd = null
      }
      this.clearSnapTimer()
    },
    onDown(e) {
      const y = touchAxis(e, 'y')
      if (!isFinite(y)) return // 取不到坐标就当没按（别让轨道莫名跳走）
      this.logRawOnce(e) // 诊断：每次进页面打一条原始坐标字段
      this.clearTimers()
      this._startY = y
      this._moved = 0 // 本次按下的最大位移（判定点按还是拖动）
      this._downT = Date.now()
      this._moveAt = 0 // 帧合并：按下后的第一次 move 一定处理
      // 省性能模式：不进拖动（位置恒为当前行居中）；点按仍记账，双击跳行照样能用
      if (this.locked) return
      this._startOff = this.topOff
      this.dragging = true
      this.dur = INSTANT_MS
      // 固件不发 touchend 的兜底
      const self = this
      this._wd = setTimeout(function () {
        self.onUp()
      }, WATCHDOG_MS)
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
      // 帧合并：一帧最多算一次位移（多余的事件即使处理了，渲染器一帧也只画一次）
      const now = Date.now()
      if (now - this._moveAt < MOVE_MS) return
      this._moveAt = now
      this.applyDrag(y)
    },
    onUp(e) {
      // 省性能模式：没有拖动，只走点按判定
      if (this.locked) {
        const dl = Date.now() - this._downT
        if (this._moved <= TAP_SLOP && dl <= TAP_MAX_MS) this.onTap(e)
        else this._lastTap = null
        return
      }
      if (!this.dragging) return
      // 补最后一帧：touchend 前的最后一段移动可能被帧合并窗口丢掉
      const y = touchAxis(e, 'y')
      if (isFinite(y)) this.applyDrag(y)
      this.dragging = false
      this.clearTimers()
      // 点按（没怎么动、也没按太久）才进双击判定；拖动过就作废上一次点按
      const dt = Date.now() - this._downT
      if (this._moved <= TAP_SLOP && dt <= TAP_MAX_MS) this.onTap(e)
      else this._lastTap = null
    },
    /**
     * 点按：攒够两次就是双击 → 跳转到该行。
     * 判定看「两次抬起之间的间隔」而不是「第二次按下与第一次抬起之间」（手写笔拖得慢，放宽 DBL_MS）。
     */
    onTap(e) {
      if (!this.dblTap) return
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
      if (idx >= 0) this.$emit('seekline', idx)
    },
    /**
     * 手指的 y → 行下标（-1 = 没落在任何行上/落在行距里）。
     * 本固件的 pageY 是**相对触发节点**的坐标（touchAxis 首选 pageY；实测 screenY−pageY =
     * 面板顶边到屏幕顶边距离），本组件根节点即触摸目标、轨道顶边与根节点重合，
     * 所以「y − 轨道位移」就是内容坐标，**不要再减面板顶边**（老组件减了导致双击跳上一行）。
     * 行高/行顶都用 rowTop()/rowH() 现算，与渲染同一组数（窗口化后仍按整首坐标系算，
     * 所以点窗口外的行也能算对，只是不会渲染）。
     */
    lineAtY(yPx) {
      const rows = this.rowsAll
      const n = rows.length
      if (!n || !isFinite(yPx)) return -1
      const t = yPx - this.topOff
      if (t < 0) return -1
      for (let k = 0; k < n; k++) {
        const top = this.rowTop(k)
        if (t < top) return -1 // 落在上一行与这一行之间的行距里
        if (t < top + this.rowH(k)) return rows[k].i
      }
      return -1 // 落在轨道下方
    },
    /**
     * 诊断（每次进页面只打一条）：把各候选坐标字段的原值打出来。
     * 若双击又偏了先看这条：screenY−pageY 应约等于面板顶边到屏幕顶边的距离（约 43px）；
     * 若变成 0 说明该固件的 pageY 已经是页面绝对坐标，那时才需要减面板顶边。
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
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 根节点铺满父容器（480×240 子面板；底色与左侧圆角由父级给，本组件不上底色）。
   根节点同时是触摸坐标系原点：轨道贴顶，所以「面板内 y − 轨道位移」= 内容坐标。 */
.lb-view {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
/* 整条歌词轨道：唯一一次 translateY 平移（不是滚动容器；行轨只渲染窗口内的行）。
   左右 inset 10px = 面板左右 padding（不写在根节点上，避免把触摸坐标系也内缩） */
.lb-track {
  position: absolute;
  top: 0;
  left: 10px;
  right: 10px;
  flex-direction: column;
}
/* 空态：20px、弱文字色、居中（根节点已 align/justify center） */
.lb-empty {
  font-size: 8.33vh;
  color: @text-3;
}
</style>
