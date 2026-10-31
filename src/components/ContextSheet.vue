<template>
  <div class="cs-mask" @click="onClose">
    <div class="cs-sheet" :style="sheetStyle" @click="stop">
      <text class="cs-title" v-if="!dense">{{ title }}</text>
      <div class="cs-opt" v-for="o in options" :key="o.key" :style="optStyle(o.key)" @click="onPick(o.key)">
        <image v-if="o.icon" class="cs-ico" :src="o.icon" />
        <text class="cs-opt-t" :style="optTextStyle(o.key)">{{ o.label }}{{ mark(o.key) }}</text>
      </div>
      <div class="cs-cols" v-if="columns && columns.length">
        <text class="cs-cols-label">{{ columnsLabel || '列数' }}</text>
        <opt-chip v-for="n in columns" :key="'c' + n" :text="'' + n" :on="n === activeColumns" @pick="onPickColumns(n)" />
      </div>
    </div>
  </div>
</template>

<script>
/**
 * 上下文面板（左栏按钮展开的浮层）—— 排序 / 更多操作共用。
 *
 * 用法：
 *   <context-sheet v-if="panel" title="排序方式" :options="sortOptions"
 *     :active-key="sortKey" :asc="sortAsc" @pick="pickSort" @close="panel=''" />
 *
 * 带列数选择（专辑页）：
 *   :columns="[2,3,4]" :active-columns="cols" columns-label="列数"
 *   @pick-columns="pickCols"
 *
 * 平台约束：
 *   - 浮层绝对定位基准是 .psh-body（PageShell），所以只盖内容区、不盖左栏；
 *   - 遮罩挂关闭、内层挂空方法挡穿透（平台无 stopPropagation）；
 *   - 面板贴栏底向上生长（bottom:24vh 正对最下面那个左栏按钮的上沿），
 *     与曲目列表页的排序浮窗同一套几何。
 *   - 本组件没有 slot，结构切换（columns 有无）是安全的；仍尽量保持节点简单。
 */
import OptChip from './OptChip.vue'
import { accentMixin } from '../utils/theme.js'
import { TOK } from '../utils/ui/tokens.js'

export default {
  name: 'ContextSheet',
  mixins: [accentMixin],
  components: { 'opt-chip': OptChip },
  props: {
    title: { type: String, default: '' },
    /** [{key, label, icon?}] */
    options: { type: Array, default: function () { return [] } },
    activeKey: { type: String, default: '' },
    asc: { type: Boolean, default: false },
    /** 列数选择；null / 空数组 = 不显示 */
    columns: { type: Array, default: null },
    activeColumns: { type: Number, default: 0 },
    columnsLabel: { type: String, default: '列数' },
    /**
     * 选中项后缀（默认 null = 排序面板的 ↑/↓ 箭头）。
     * 传 '' 可只保留高亮、不要箭头 —— 用于「点一次进入待确认」的破坏性项
     * （plinfo 的本地删除 / 删除：标签由页面自己改成「再点一次确认」）。
     */
    markText: { type: String, default: null },
    /**
     * 密集模式：面板高度收进 .psh-body（85vh）的可用竖空间。
     * 用于选项 ≥4 的面板（plinfo 从本地下载进入时的「下载全部 / 重命名 / 本地删除 / 删除」，
     * 常规几何 4×15.2 + 标题 + 内边距 ≈ 73vh，会从底部 24vh 向上顶穿内容区被裁掉）。
     * 实现：隐藏标题、缩小内边距、选项降到 13vh（仍够点，图标/字号不变）。
     */
    dense: { type: Boolean, default: false }
  },
  computed: {
    sheetStyle() {
      return this.dense ? { padding: '1.6vh' } : null
    }
  },
  methods: {
    stop() {},
    onClose() {
      this.$emit('close')
    },
    onPick(key) {
      this.$emit('pick', key)
    },
    onPickColumns(n) {
      this.$emit('pick-columns', n)
    },
    /** 当前生效项的方向箭头（只在选中项后面）；markText 非 null 时用它替代箭头 */
    mark(k) {
      if (!this.activeKey || k !== this.activeKey) return ''
      if (this.markText !== null) return this.markText
      return this.asc ? ' ↑' : ' ↓'
    },
    optStyle(k) {
      const on = !!this.activeKey && k === this.activeKey
      const out = {
        backgroundColor: on ? this.accent.a18 : TOK.panel2,
        borderWidth: on ? '1px' : '0px',
        borderStyle: 'solid',
        borderColor: on ? this.accent.c : TOK.none
      }
      if (this.dense) {
        out.height = '13vh'
        out.marginBottom = '1vh'
      }
      return out
    },
    optTextStyle(k) {
      const on = !!this.activeKey && k === this.activeKey
      return { color: on ? this.accent.light : TOK.text2 }
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

.cs-mask {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  height: 100%;
  background-color: @scrim;
  z-index: 900;
}
.cs-sheet {
  position: absolute;
  left: 1.4vh;
  bottom: 24vh;
  width: 76vh;
  background-color: @surface-4;
  border-radius: @radius;
  border-width: 1px;
  border-style: solid;
  border-color: @surface-3;
  padding: 2.4vh;
}
.cs-title {
  font-size: @fs-mute;
  color: @text-3;
  margin-bottom: 1.6vh;
  margin-left: 1vh;
}
/* 选项行：14vh ≈ 34px 高（原 11vh 在小屏上太难点），字号提到 @fs-strong。
   面板宽 76vh ≈ 182px，容得下「添加到本地索引」6 个加粗汉字 + 图标。 */
.cs-opt {
  height: 14vh;
  border-radius: 1.8vh;
  flex-direction: row;
  align-items: center;
  padding-left: 3vh;
  padding-right: 3vh;
  margin-bottom: 1.2vh;
}
.cs-ico {
  width: 8vh;
  height: 8vh;
  flex: none;
  margin-right: 2.4vh;
}
.cs-opt-t {
  font-size: @fs-strong;
  color: @text-2;
  lines: 1;
}
.cs-cols {
  flex-direction: row;
  align-items: center;
  margin-top: 1.4vh;
  padding-left: 1vh;
}
.cs-cols-label {
  font-size: @fs-mute;
  color: @text-3;
  margin-right: 2vh;
}
</style>
