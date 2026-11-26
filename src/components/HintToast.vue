<template>
  <div class="htoast" v-if="text">
    <div class="htoast-pill">
      <text class="htoast-t">{{ text }}</text>
    </div>
  </div>
</template>

<script>

/**
 * 轻提示（本平台没有 toast / 对话框设施，操作结果靠它显示）
 *
 * 用法：`<hint-toast :text="toast" />` + 页面用 setTimeout 把 text 清空控制时长。
 * 绝对定位在 .psh-body（PageShell 设了 position:relative）底部居中，不参与布局。
 * ⚠ 但**宽度必须写死**（.htoast-pill 的 width），不能像 .lst-sheet 那样靠内容撑 —— 见样式块。
 * z-index 800 —— 低于进度浮窗（900），浮窗开着时提示不压它。
 */
export default {
  name: 'HintToast',
  props: {
    text: { type: String, default: '' }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

.htoast {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 10vh;
  width: 100%;
  /* 平台默认主轴竖向：这里的 align-items 是交叉轴（水平）居中 → pill 居中 */
  align-items: center; 
  z-index: 800;
}

/* ⚠ 这里必须是**定宽**，不能靠内容撑（否则 toast 只剩前几个字、文字显示不全）：
   文字用 lines + ellipsis 裁切，需要有一个确定宽度作基准；pill 若靠 max-width 撑、文字又按
   可用宽度裁，两者互相依赖，运行时 pill 只会被解得剩下内边距，再被 overflow:hidden 裁掉。
   定宽后内容区 260-12=248vh≈595px，@fs-dim 下单行约 35 个汉字、两行约 70 个，覆盖所有现有文案。 */
.htoast-pill {
  width: 260vh;
  overflow: hidden;
  background-color: rgba(0, 0, 0, 0.85);
  border-radius: 5vh;
  padding: 2.4vh 6vh;
}
.htoast-t {
  width: 100%; 
  font-size: @fs-dim;
  color: @text;
  lines: 2; 
  text-overflow: ellipsis;
  text-align: center;
}
</style>
