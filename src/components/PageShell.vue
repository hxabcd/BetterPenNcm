<template>
  <div class="psh" :style="bgStyle">
    <!-- :key=railSig：**槽位键集合变化时整体重建 NavRail**（修「点多选键界面不切换」）——
         设备端渲染器对「长度相同、key 全换」的 v-for 更新会抛异常（日志实证 console.error(null)），
         改成整组件重建走「删旧建新」这条每天都走通的路径；键集合不变（只是 on/danger/icon 变化）
         时签名不变，仍走普通属性补丁（播放/暂停图标那类更新一向正常）。 -->
    <nav-rail :key="railSig" :items="railItems" @action="onRail" />
    <div class="psh-body">
      <slot></slot>
    </div>
  </div>
</template>

<script>
import NavRail from './NavRail.vue'
import { accentMixin } from '../utils/theme.js'
import { railBack } from '../utils/rail.js'

/**
 * 页面外壳：左侧全局操作栏 + 右侧内容列。
 *
 * 用法：
 *   <page-shell :rail="rail" @rail="onRail">
 *     <page-topbar … />
 *     <scroller …>…</scroller>
 *   </page-shell>
 *
 * `rail` 是 [{key, icon, on?, text?}]，由 utils/rail.js 的构造函数拼；
 * 第一个槽位固定是返回（railBack()）。**返回不在这里处理** —— 组件里拿不到
 * `this.$page` 不可靠，所以 back 事件原样抛给页面，由 utils/ui/frame.js 的
 * pageFrameMixin 分派到 onBack()（默认 `this.$page.finish()`）。
 */
export default {
  name: 'PageShell',
  // 壳的底色运行时可换（设置页 → 背景色）：bg/accent 与订阅由 accentMixin 管
  mixins: [accentMixin],
  components: { 'nav-rail': NavRail },
  props: {
    /**
     * 左栏槽位。**必须先过 railItems 收敛**（防呆）：页面给什么（undefined /
     * 误传了函数）都兜底成 [返回]，保证整条左栏不会消失。
     */
    rail: { type: Array, default: null }
  },
  computed: {
    bgStyle() {
      return { backgroundColor: this.bg }
    },
    /** 左栏槽位收敛：非数组一律兜底 [返回]（模板与签名都只看这一份，别再直接用 this.rail） */
    railItems() {
      return Array.isArray(this.rail) ? this.rail : [railBack()]
    },
    /** 左栏槽位键集合的签名（键顺序 + 键名）：变了就让 NavRail 整体重建（见模板注释） */
    railSig() {
      const items = this.railItems
      let s = ''
      for (let i = 0; i < items.length; i++) s += ((items[i] && items[i].key) || '') + '|'
      return s
    }
  },
  methods: {
    onRail(key) {
      this.$emit('rail', key)
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

/* 页面外壳：横向 flex —— 左栏 + 内容列 */
.psh {
  width: 100vw;
  height: 100vh;
  flex-direction: row;
  /* 底色由内联 :style 给（主题可换，见 utils/theme.js） */
}
.psh-body {
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  /* 各页的浮层（排序/进度/选项）用 position:absolute 铺满，定位基准就是这里 ——
     这样遮罩只盖内容区、不盖左栏，左栏按钮在浮层打开时仍可见 */
  position: relative;
}
</style>
