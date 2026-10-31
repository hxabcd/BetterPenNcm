<template>
  <div class="ocue" @click="onTap">
    <div class="ocue-main">
      <text :class="dim ? 'ocue-nm-dim' : 'ocue-nm'">{{ name }}</text>
      <text class="ocue-sub">{{ sub }}</text>
    </div>
    <image v-if="cue" class="ocue-cue" :src="ICON.chevright" />
  </div>
</template>

<script>
/**
 * 「可进入下一页」入口行：标题 + 副行 + 灰色 › 提示。
 *
 * 行高/留白 26vh+6vh 与设置族选项行一致（@row-h 是 23vh；设置族刻意高一档放两行文字）。
 *
 * dim = 只读信息行（如设置页的「关于」）：标题不加粗、用 @text-2，并靠「无 › 」与入口区分
 *   —— 靠 `:cue="false"` 而不是移除 handler（本组件不消灭可点性，页面不监听就是静态行）。
 *
 * 用法：<cue-row name="个人中心" :sub="accountText" @open="openAccount" />
 *       <cue-row name="关于" :sub="'…'" :cue="false" :dim="true" />
 * ⚠ 发出事件名用 `open`（不用 tap —— 手势名会再挂原生通道，见 OptChip 注释）。
 */
import { ICON } from '../assets/icons.js'

export default {
  name: 'CueRow',
  props: {
    name: { type: String, default: '' },
    sub: { type: String, default: '' },
    cue: { type: Boolean, default: true },
    dim: { type: Boolean, default: false }
  },
  data() {
    return { ICON: ICON }
  },
  methods: {
    onTap() {
      this.$emit('open')
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

/* 与 settings 的 .st-item / setdl 的 .dl-item 逐字节一致（仅前缀不同） */
.ocue {
  height: 26vh;
  flex-direction: row;
  align-items: center;
  padding-left: 6vh;
  padding-right: 6vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.ocue-main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
}
.ocue-nm {
  font-size: @fs-strong;
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
/* 只读信息行的标题：比 .ocue-nm 低一档 —— 不加粗、用 @text-2。
   ⚠ 必须是**独立完整类名**，不能在 .ocue-nm 上叠修饰类（平台不支持 .a.b 复合选择器） */
.ocue-nm-dim {
  font-size: @fs-dim;
  color: @text-2;
  lines: 1;
  text-overflow: ellipsis;
}
.ocue-sub {
  font-size: @fs-mute;
  color: @text-3;
  lines: 1;
  text-overflow: ellipsis;
  margin-top: 1.2vh;
}
/* 「可进入下一页」提示箭头：灰色（@text-3，见 gen_icons.py 的 COLORS）+ 11vh = 26px */
.ocue-cue {
  width: 11vh;
  height: 11vh;
  flex: none;
  margin-left: 2vh;
}
</style>
