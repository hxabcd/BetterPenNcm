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
 * 绝对定位在 .psh-body（PageShell 设了 position:relative，见 AGENTS 坑 13）底部居中，
 * 不参与布局（高度由内容撑，同列表页 .lst-sheet 的成熟写法）；
 * ⚠ 但**宽度必须写死**（.htoast-pill 的 width），不能像 .lst-sheet 那样靠内容撑 ——
 *   详见样式块的注释。
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
  align-items: center; /* 主轴是竖向，交叉轴（水平）居中 → pill 居中 */
  z-index: 800;
}
/* ⚠ 这里必须是**定宽**，不能靠内容撑（修「toast 太窄、文字显示不全」）：
   原来写 `max-width: 340vh` + 文字 `lines:1 / text-overflow: ellipsis`，
   整条链上没有任何一个确定宽度 —— pill 要按内容定宽、文字又要按「可用宽度」裁，
   两者互相依赖，运行时就把 pill 解得只剩内边距那么宽，再被 overflow:hidden 一裁，
   于是绝大多数文案都只剩前几个字。
   全项目只有这一处 ellipsis 的节点没有确定宽度（其余要么是定宽行里的 flex:1，
   要么像 .srow-art 直接写 width），也只有这一处用了 max-width。
   定宽之后文字才有可裁/可折的基准：内容区 260-12=248vh≈595px，@fs-dim 下
   单行约 35 个汉字、两行约 70 个，覆盖所有现有文案。 */
.htoast-pill {
  width: 260vh;
  overflow: hidden;
  background-color: rgba(0, 0, 0, 0.85);
  border-radius: 5vh;
  padding: 2.4vh 6vh;
}
.htoast-t {
  width: 100%; /* 跟随 pill 内容区（定宽），文字居中靠 text-align */
  font-size: @fs-dim;
  color: @text;
  lines: 2; /* 超长歌名/报错允许折到两行，别再单行截断 */
  text-overflow: ellipsis;
  text-align: center;
}
</style>
