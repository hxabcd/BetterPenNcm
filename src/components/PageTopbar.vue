<template>
  <div class="ptb" :style="bgStyle">
    <!-- 标题区结构**恒定**：link 只改「可点性 + › 有无」（文本内容），不增删任何节点。
         实测坑：本平台渲染器对「v-if 换过结构之后再补插节点」会插错位 ——
         歌曲列表页第二次进多选时，右上角 slot（全选）被插到 .ptb-fill 前面、整体左移 ~180px。
         根因是旧写法用 v-if="link" / v-if="!link" 两套节点切换，第二次切换后 slot 落错位。
         所以这里一个 v-if 都不留：三个 text 常驻，cue 为空串时占 0 宽。 -->
    <div class="ptb-link" @click="onTap">
      <text class="ptb-ttl">{{ title }}</text>
      <text class="ptb-sub">{{ sub || '' }}</text>
      <text class="ptb-cue">{{ cue }}</text>
    </div>
    <!-- 不可点的页面（link=false）不显示 › 提示 —— 行为与外观零变化 -->
    <div class="ptb-fill"></div>
    <slot></slot>
  </div>
</template>

<script>
/**
 * 页面顶栏：标题 + 副题 + 右侧插槽（放状态/按钮）。
 *
 * 导航重构：**返回按钮已移除** —— 改由左侧全局操作栏（<page-shell> 的
 * <nav-rail>）第一个固定槽位承担，避免同一页两处返回。
 *
 * `link`（默认 false）：把标题区变成可点区并抛 `open` 事件（曲目列表页用它进「歌单详情」，
 * 搜索页用它唤起输入法改关键词）。
 * 只有明确传 `link` 的页面才可点 —— 顶栏在别的页只是标题，别让它看起来像按钮。
 * 注意：link 现在只改可点性与 › 文本，**不再增删节点**（模板结构恒定，原因见模板注释）。
 * ⚠ 事件名**不要用 `tap`/`longpress`/`swipe` 这些手势名**：预编译器（falcon-vue-precompiler 的
 * hooks/events.js 的 bindEvents）会给绑了手势事件的节点无条件写 `data-evt-<名>` 属性，
 * 自定义组件上就多出一条「原生手势 + 组件 $emit」双通道，可能一次点击触发两次。
 */
import { accentMixin } from '../utils/theme.js'

export default {
  name: 'PageTopbar',
  // 顶栏与页面底/左栏同色且运行时可换 —— 由 accentMixin 管
  mixins: [accentMixin],
  props: {
    title: { type: String, default: '' },
    sub: { type: String, default: '' },
    link: { type: Boolean, default: false }
  },
  computed: {
    bgStyle() {
      return { backgroundColor: this.bg }
    },
    /** 可点提示 ›：link=false 时空串（占 0 宽），结构保持恒定（见模板注释） */
    cue() {
      return this.link ? '›' : ''
    }
  },
  methods: {
    /** 点击守卫：节点常驻（结构恒定），不可点时这里吞掉 */
    onTap() {
      if (this.link) this.$emit('open')
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

.ptb {
  height: @topbar-h;
  flex: none;
  flex-direction: row;
  align-items: center;
  /* 底色由内联 :style 给（主题可换） */
  padding-left: 3vh;
  padding-right: 3vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
/* 可点标题区：整块顶栏高度都是点击区（行高 15vh ≈ 36px，够点）。
   flex:none + 不设宽度 → 由内容撑开；右侧的 .ptb-fill 保证它不吃满整条顶栏 */
.ptb-link {
  height: @topbar-h;
  flex-direction: row;
  align-items: center;
}
/* 可点提示：用半角尖括号（设备字体一定有这个字形；▶⏸ 那类符号才需要走 PNG） */
.ptb-cue {
  font-size: @fs-strong;
  color: @text-3;
  margin-left: 2vh;
}
.ptb-ttl {
  font-size: @fs-strong;
  color: @text;
  font-weight: bold;
  margin-right: 3vh;
}
.ptb-sub {
  font-size: @fs-mute;
  color: @text-3;
}
.ptb-fill {
  flex: 1;
}
</style>
