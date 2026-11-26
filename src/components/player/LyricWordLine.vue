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
 * 逐字行只渲染活动行的原文；译文仍由 LyricTrack 渲染。
 * 单独成组件只为把高频更新关在本组件内：本平台逐帧改 color 会被合并成最终值（写 14 帧等于写 1 帧），
 * 所以字级推进只在「当前字变化」时写一次 data，不按帧更新；color 也没有平滑路径 → 颜色内联硬切。
 * 上浮/微缩放走 transform（可插值），w-past 与 w-cur 同位移同缩放，切类时无差值、不回落。
 */
import { TOK } from '../../ui/tokens.js'

export default {
  name: 'LyricWordLine',
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

      return this.anim ? 'w-past' : 'w-future'
    },

    /** 字的颜色内联硬切：已唱/当前字 TOK.text，未唱 TOK.text2；主题色只留给行左侧指示条 */
    wordStyle(seg) {
      return { color: seg.w > this.wordIdx ? TOK.text2 : TOK.text }
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

/* 三种字状态各一个完整类（平台只认单类名）；w-past 与 w-cur 同位移同缩放：唱过的字保持抬起不落下，
   切类时 transform 没有差值 → 不产生回落动画 */
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
