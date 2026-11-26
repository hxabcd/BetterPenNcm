<template>

  <!-- 右侧分类侧栏：搜索页专有（分类来自 SEARCH_TYPES，后续加分类只改那张表）。
       外壳宽度由 sideStyle 控制（0 = 收起/非搜索页），内容固定宽、超出部分被裁。 -->
  <div class="sbs-side" :style="sideStyle">
    <scroller class="sbs-scroll">
      <div class="sbs-in">
        <div class="sbs-cat" v-for="c in cats" :key="c.key" :style="catStyle(c.key)" @click="pick(c.key)">
          <text class="sbs-cat-t" :style="catTextStyle(c.key)">{{ c.label }}</text>
        </div>
      </div>
    </scroller>
  </div>
</template>

<script>

/**
 * 搜索分类侧栏（list.vue 拆解件）：开合状态、外壳宽度、选中底色都由本组件自己算，
 * 页面只传 searchType（当前分类）并接 pick 事件。
 *
 * 宽度 62.5vh（≈150px）与本文件 .sbs-side/.sbs-scroll/.sbs-in 三处成对维护，
 * 改宽度必须一起改（不再依赖页面 script 里的常量）。
 */
import { SEARCH_TYPES } from '../../services/ncm/api.js'
import { accentMixin } from '../../ui/mixins/accent.js'
import { TOK } from '../../ui/tokens.js'

const SIDE_W = 62.5

export default {
  name: 'SearchSidebar',
  mixins: [accentMixin],
  props: {

    /** 当前搜索分类（SEARCH_TYPES 的 key）；非搜索页传 0（侧栏收起） */
    searchType: { type: Number, default: 0 },

    /** 侧栏是否展开（只表示开合；非搜索页由页面不渲染本组件来表达） */
    open: { type: Boolean, default: false }
  },
  data() {
    return { cats: SEARCH_TYPES }
  },
  computed: {
    sideStyle() {
      return {
        width: (this.open ? SIDE_W : 0) + 'vh',
        borderLeftWidth: this.open ? '1px' : '0px'
      }
    }
  },
  methods: {
    pick(t) {
      this.$emit('pick', Number(t))
    },

    /** 分类项选中底色（平台不支持复合选择器 → 状态色走内联 style） */
    catStyle(k) {
      const on = Number(k) === this.searchType
      return {
        backgroundColor: on ? this.accent.a18 : TOK.none,
        borderWidth: on ? '1px' : '0px',
        borderStyle: 'solid',
        borderColor: on ? this.accent.c : TOK.none
      }
    },

    catTextStyle(k) {
      return { color: Number(k) === this.searchType ? this.accent.light : TOK.text2 }
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 外壳宽度由内联 sideStyle 控制；内容固定 62.5vh（≈150px）——外壳收窄时由
   overflow:hidden 裁掉，而不是重排文字。 */
.sbs-side {
  overflow: hidden;
  background-color: @panel;
  border-left-style: solid;
  border-left-color: @line;
}

/* 分类区套 scroller：4 项目前放得下、不滚动；以后加分类超出高度时可滚（别把高度写死在内层）。 */
.sbs-scroll {
  width: 62.5vh;
  height: 100vh;
}
.sbs-in {

  /* 平台把 width 当 border-box：62.5vh 已含 padding。
     左 5vh、右 7.5vh（右侧 = 左侧 1.5 倍）→ 按钮宽 = 62.5 - 5 - 7.5 = 50vh。
     不要再用「内容宽 + 两侧 padding = 侧栏宽」的写法，否则右侧会多出一大块空白。 */
  width: 62.5vh;
  flex-direction: column;
  padding-top: 5vh;
  padding-bottom: 5vh;
  padding-left: 5vh;
  padding-right: 7.5vh;
}

/* 分类行：高 20vh，4 项 + 间距排满可用高度（后续加项要同时调高度，或改成滚动）。
   按钮宽度 = 上面的内容宽，不再额外写左右 margin/padding。 */
.sbs-cat {
  height: 20vh;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 2vh;
  margin-bottom: 1.4vh;
}
.sbs-cat-t {
  font-size: @fs-strong;
  /* 默认（未选中）的书面值；选中态由模板内联 style 给主题色 */
  color: @text-2; 
}
</style>
