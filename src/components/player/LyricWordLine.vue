<template>
  <div class="lwl-wrap">
    <div class="lwl-line" v-for="(ln, li) in row.wordLines" :key="li">
      <text
        v-for="seg in ln.words"
        :key="seg.w + '-' + seg.part"
        :class="wordCls(seg)"
        :style="wordStyle(seg)"
      >{{ seg.text }}</text>
    </div>
  </div>
</template>

<script>
/**
 * 逐字歌词行（只渲染「当前活动行」的原文；译文仍由 LyricTrack 渲染）。
 *
 * 为什么单独成组件：逐字推进需要按播放位置判断「当前字」，
 * 如果把 wordIdx 放在 LyricBoard 或 LyricTrack 的 data 里，每帧会带着整个渲染窗口重渲染。
 * 这里让本组件直接订阅 LyricBoard 的局部时钟（ticker 对象），状态只落在本组件内。
 *
 * 动画（2026-11-01 按真机能力重做）：
 *   - **字级推进**：只在「当前字变化」时写一次 data，不按帧更新 —— 本平台 `color` 逐帧改
 *     会被合并成最终值（写 14 帧等于写 1 帧），之前那种逐帧混色是白费开销；
 *   - **已唱/当前字用主题色，未唱字用正文白**（内联，硬切：`color` 在本平台没有任何平滑路径，
 *     见 docs/平台约束与自检.md 的动画能力表）；
 *   - **上浮 + 微缩放**由 class 里的 `transition: transform 120ms` 负责（`transform` 可插值）：
 *     当前字 `w-cur` 抬起，唱过的字**保持抬起不落下**（`w-past` 与 `w-cur` 同位移同缩放，
 *     切类时 transform 没有差值 → 不产生回落动画，颜色仍由内联硬切）；
 *   - `anim=false` 时全部字都用 `w-future`（不抬起，也就没有过渡，只有颜色的硬切）。
 *
 * 平台约束：样式单类名（每个状态一个完整类）；text 不嵌套；v-for key 稳定（字下标 + 段序）。
 */
import { TOK } from '../../utils/ui/tokens.js'
import { accentMixin } from '../../utils/theme.js'

export default {
  name: 'LyricWordLine',
  mixins: [accentMixin],
  props: {
    /** LyricBoard.rowsAll 里带 wordLines 的行（只传活动行） */
    row: { type: Object, required: true },
    /** LyricBoard 的局部时钟对象：{ on, off, ms }；引用稳定，不作为响应式状态 */
    ticker: { type: Object, required: true },
    /** 是否启用动画（false = 不做当前字抬起，等价于字级硬切） */
    anim: { type: Boolean, default: true }
  },
  data() {
    return {
      /** 当前字下标（-1 = 本行还没进第一个字） */
      wordIdx: -1
    }
  },
  mounted() {
    const self = this
    this._fn = function (ms) {
      self.onTick(ms)
    }
    this.ticker.on(this._fn)
    this.onTick(this.ticker.ms())
  },
  beforeDestroy() {
    if (this._fn) this.ticker.off(this._fn)
    this._fn = null
  },
  methods: {
    /** 局部时钟推进：只在「字下标变化」时写 data */
    onTick(ms) {
      const words = this.row.words || []
      let idx = -1
      for (let i = 0; i < words.length; i++) {
        const w = words[i]
        if (ms < w.time) break
        idx = i
        if (ms < w.end) break
      }
      if (idx !== this.wordIdx) this.wordIdx = idx
    },
    /** 字的状态类：未唱 / 当前（抬起） / 已唱（保持抬起不落下） */
    wordCls(seg) {
      if (seg.w > this.wordIdx) return 'w-future'
      if (seg.w === this.wordIdx && this.anim) return 'w-cur'
      // 无动画时已唱/当前字也不抬起（纯颜色硬切），统一按未抬起渲染
      return this.anim ? 'w-past' : 'w-future'
    },
    /** 颜色只能内联（主题色是运行时值），硬切 */
    wordStyle(seg) {
      return { color: seg.w > this.wordIdx ? TOK.text : this.accent.c }
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 逐字原文容器：铺满文本列；行内左对齐，视觉行之间不留额外间距（行高已含） */
.lwl-wrap {
  width: 100%;
  flex-direction: column;
  align-items: flex-start;
}
/* 一条视觉行：横向排字；折行由 lyriclayout.js 预排，不依赖平台 flex-wrap */
.lwl-line {
  flex-direction: row;
  align-items: flex-start;
}
/* 三种字状态各一个完整类（平台单类名；样式全在类里，内联只给颜色）。
   w-past 与 w-cur 同位移同缩放：唱过的字保持抬起不落下，切类时 transform 无差值 */
.w-future {
  font-size: 10.83vh;
  line-height: 31.2px;
  font-weight: bold;
  transform: translateY(0px) scale(1);
  transition: transform 120ms ease-out;
}
.w-past {
  font-size: 10.83vh;
  line-height: 31.2px;
  font-weight: bold;
  transform: translateY(-1.5px) scale(1.02);
  transition: transform 120ms ease-out;
}
.w-cur {
  font-size: 10.83vh;
  line-height: 31.2px;
  font-weight: bold;
  transform: translateY(-1.5px) scale(1.02);
  transition: transform 120ms ease-out;
}
</style>
