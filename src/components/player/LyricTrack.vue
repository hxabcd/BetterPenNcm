<template>
  <div class="lt-wrap">
    <div class="lt-row" v-for="r in rows" :key="r.i" :style="rowStyle(r)">
      <div class="lt-mark" :style="markStyle(r)"></div>
      <div class="lt-text">
        <!-- 逐字活动行：字节点在 LyricWordLine 里高频更新，别把 wordPct 提到本组件 -->
        <lyric-word-line
          v-if="wordOn && r.wordLines && r.i === hl"
          :row="r"
          :ticker="ticker"
          :anim="anim"
        ></lyric-word-line>
        <div class="lt-main" v-else>
          <text
            class="lt-main-text"
            v-for="(t, ti) in r.mainLines"
            :key="ti"
            :style="mainStyle(r)"
          >{{ t }}</text>
        </div>
        <text
          class="lt-trans"
          v-for="(t, ti) in r.transLines"
          :key="ti"
          :style="transStyle(r)"
        >{{ t }}</text>
      </div>
    </div>
  </div>
</template>

<script>
/**
 * 行盒口径：单行 60px、长行按 lyriclayout.js 预排的视觉行数增高；行高只由行内 sRow 给，
 * 行间无 margin/gap，内容在行盒内垂直居中。
 * 样式对象由 LyricBoard 预算并挂在 row 上（引用稳定）：换行时只有旧/新两行的引用变，
 * 其余逐项相同 → Vue 的 style 补丁不产生原生写入。
 */
import LyricWordLine from './LyricWordLine.vue'

export default {
  name: 'LyricTrack',
  components: { 'lyric-word-line': LyricWordLine },
  props: {
    /** LyricBoard.rowsView（窗口内的排版行） */
    rows: { type: Array, default: function () { return [] } },
    /** 高亮行下标（-1 = 还没到第一行） */
    hl: { type: Number, default: -1 },
    /** LyricBoard 的局部时钟对象：{ on, off, ms }；引用稳定，本组件不响应它的变化 */
    ticker: { type: Object, required: true },
    /** 是否启用逐字歌词（活动行才拆字节点） */
    wordOn: { type: Boolean, default: false },
    anim: { type: Boolean, default: true }
  },
  methods: {
    rowStyle(r) {
      return r.sRow
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

.lt-wrap {
  width: 100%;
  flex-direction: column;
}

/* 行高由行内 sRow 内联给出（60px 起、长行按预排视觉行数增高）；行间无 margin/gap，内容垂直居中 */
.lt-row {
  position: relative;
  flex-direction: row;
  align-items: center;
  padding-left: 4px;
  padding-right: 4px;
}

/* 左侧指示条：绝对定位不参与文本宽度；活动行显示主题色，其余透明 */
.lt-mark {
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 3px;
  border-radius: 2px;
}

/* 文本列：flex:1 拿确定宽度；margin-left 7px = lyriclayout.js 的 MARK_SPACE，给指示条让位 */
.lt-text {
  flex: 1;
  margin-left: 7px;
  padding-left: 6px;
  padding-right: 6px;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  overflow: hidden;
}

/* 普通原文：视觉行由 lyriclayout.js 预排，这里每个视觉行一个 text、不交给平台折行 */
.lt-main {
  width: 100%;
  flex-direction: column;
  align-items: flex-start;
}
.lt-main-text {
  font-weight: bold;
  lines: 1;
}
.lt-trans {
  font-weight: bold;
  margin-top: 2px;
  lines: 1;
}
</style>
