<template>
  <div class="ochip" :style="chipStyle" @click="onTap">
    <text class="ochip-t" :style="chipTextStyle">{{ text }}</text>
  </div>
</template>

<script>
/**
 * 选项胶囊 —— 设置族三页（playeropts / setdl / setlook）共用。
 *
 * 选中态配色全走主题色（内联 style —— 平台只认单类名、且主题色运行时可换，见 utils/theme.js）。
 *
 * 用法：<opt-chip text="开" :on="x" @pick="fn" />
 * ⚠ 事件名用 `pick` 不用 `tap`：预编译器会给绑了手势名的节点再挂一条原生手势通道，
 *   自定义组件上会一次触发两次（同 SongRow 的 hold / PageTopbar 的注释）。
 */
import { accentMixin } from '../utils/theme.js'
import { TOK } from '../utils/ui/tokens.js'

export default {
  name: 'OptChip',
  mixins: [accentMixin],
  props: {
    text: { type: String, default: '' },
    on: { type: Boolean, default: false }
  },
  computed: {
    /** 选中 = 主题色 18% 底 + 主题色描边；未选 = 次级面底 + 透明边 */
    chipStyle() {
      return {
        backgroundColor: this.on ? this.accent.a18 : TOK.panel2,
        borderColor: this.on ? this.accent.c : 'transparent'
      }
    },
    chipTextStyle() {
      return { color: this.on ? this.accent.light : TOK.text2 }
    }
  },
  methods: {
    onTap() {
      this.$emit('pick')
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

/* 与设置族原 .xx-chip 逐字节一致（18vh 高 / 左右 4.5vh / 半径 9vh / 1px 边 / 右间距 2.4vh） */
.ochip {
  height: 18vh;
  align-items: center;
  justify-content: center;
  padding-left: 4.5vh;
  padding-right: 4.5vh;
  border-radius: 9vh;
  border-width: 1px;
  border-style: solid;
  margin-right: 2.4vh;
}
.ochip-t {
  font-size: @fs-dim;
}
</style>
