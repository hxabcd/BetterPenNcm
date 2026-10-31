<template>
  <div class="lt-wrap">
    <div class="lt-row" v-for="r in rows" :key="r.i" :style="rowStyle(r)">
      <div class="lt-markbox" :style="boxStyle(r)">
        <div class="lt-mark" :style="markStyle(r)"></div>
      </div>
      <div class="lt-text">
        <text class="lt-main" :style="mainStyle(r)">{{ r.text }}</text>
        <text class="lt-trans" v-if="r.hasTr" :style="transStyle(r)">{{ r.trans }}</text>
      </div>
    </div>
  </div>
</template>

<script>
/**
 * 歌词行轨 —— `LyricBoard` 的内部渲染层（只被它使用，不对外）。
 *
 * ## 为什么拆成子组件（拖动性能的关键，别合并回去）
 *
 * 轨道的 `translateY` 由父组件 LyricBoard 的 `topOff` 驱动，拖动时每个（合并后的）触摸帧
 * 都会写一次 `topOff` → **父组件整份重渲染**。如果行节点也在父组件里，那每帧都要重建
 * 整个窗口（7~19 行 × 每行 4~6 个节点）的 vnode。拆出来后：父组件每帧只重建
 * 「根 div + 轨道 div + 本组件 vnode」三个 vnode，而本组件的 props（`rows` / `hl`）没变，
 * Vue 不会重渲染本组件 —— 只有**渲染窗口滑动**（跨过行边界，约每 60px 一次）和**换行**
 *（hl 变化）时才重渲染，每次只 7~19 行。
 *
 * ## 行的样式来自父组件预算（不要在这里 new 对象）
 *
 * `rows` 的每一项带 5 组内联样式、每组 on/off 两份（**引用稳定**，见 LyricBoard.rowsAll）：
 *   sRowOff/On   行盒     { height, transition* }
 *   sBoxOff/On   指示条容器（高度恒等于行盒高，单独一份对象，避免两个节点共用同一对象）
 *   sMarkOff/On  指示条本体 { height, marginTop, backgroundColor, transition* }
 *   sMainOff/On  原文 text { fontSize, lineHeight, color, transition* }
 *   sTransOff/On 译文 text
 * 换行时只有旧/新两行的引用变，其余行 style 值与上次逐项相同 → Vue 的 style 补丁逐个属性
 * 比对时不产生任何原生写入。
 * 所以下面 5 个方法都必须是**查表返回**，写任何 `return { ... }` 都会把这些收益吃回去。
 *
 * ## 平台约束
 *
 * 样式只认单类名；状态差异（当前/非当前）全部走内联 `:style`；`<text>` 不嵌套。
 * 行高随高亮变化（当前行 57.2/31.2，其余 47.6/26.4），是设计稿要的「变大」，
 * 过渡声明见 LyricBoard 的 HL_MS 注释。
 */
export default {
  name: 'LyricTrack',
  props: {
    /** LyricBoard.rowsAll（整首）或 rowsView（省性能模式下的 7 行窗口） */
    rows: { type: Array, default: function () { return [] } },
    /** 高亮行下标（-1 = 还没开始，此时全部按非当前行渲染） */
    hl: { type: Number, default: -1 }
  },
  methods: {
    rowStyle(r) {
      return r.i === this.hl ? r.sRowOn : r.sRowOff
    },
    boxStyle(r) {
      return r.i === this.hl ? r.sBoxOn : r.sBoxOff
    },
    markStyle(r) {
      return r.i === this.hl ? r.sMarkOn : r.sMarkOff
    },
    mainStyle(r) {
      return r.i === this.hl ? r.sMainOn : r.sMainOff
    },
    transStyle(r) {
      return r.i === this.hl ? r.sTransOn : r.sTransOff
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 行轨：铺满父级 .lb-track（absolute + 左右 10px，列向） */
.lt-wrap {
  width: 100%;
  flex-direction: column;
}
/* 行：横排；左右 4px = dc_lyric 里 LyricLine 的 px-[4px]；
   行距 12px 用 margin（平台不支持 gap）；高度走内联（随高亮变化） */
.lt-row {
  flex-direction: row;
  align-items: center;
  padding-left: 4px;
  padding-right: 4px;
  margin-bottom: 12px;
}
/* 指示条容器：宽 3px。高度/内缩/颜色全走内联（见 LyricBoard 的 markStyle 生成） */
.lt-markbox {
  width: 3px;
  flex: none;
  flex-direction: column;
  align-items: center;
}
/* 指示条本体：3px 宽、圆角 2px（高度、上内缩、主题色都内联） */
.lt-mark {
  width: 3px;
  border-radius: 2px;
}
/* 文本列：定宽父级里 flex:1（文字截断需要确定宽度，行盒高度全靠 px 算式）。
   左右 padding 6px；align-items 保持默认 stretch → text 拿到确定宽度，
   lines:1 + text-overflow: ellipsis 才生效 */
.lt-text {
  flex: 1;
  flex-direction: column;
  align-items: stretch;
  overflow: hidden;
  padding-left: 6px;
  padding-right: 6px;
}
/* 原文/译文：字号、行高、颜色全走内联（当前/非当前两态）；字重按设计稿 dc_lyric
   的 LyricText 容器 font-bold（两种状态同一容器，都是粗体） */
.lt-main {
  font-weight: bold;
  lines: 1;
  text-overflow: ellipsis;
}
.lt-trans {
  font-weight: bold;
  margin-top: 2px; /* 原文与译文间距 2px */
  lines: 1;
  text-overflow: ellipsis;
}
</style>
