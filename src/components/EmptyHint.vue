<template>
  <text class="e-hint">{{ text }}</text>
</template>

<script>

/**
 * 列表空态 / 加载中提示行 —— 全站唯一实现。
 * 各页的 hint 字段本来就把「加载中 / 加载失败 / 空」三态共用一个文案位，组件只管呈现，语义由页面给。
 */
export default {
  name: 'EmptyHint',
  props: {
    text: { type: String, default: '' }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

.e-hint {
  font-size: @fs-dim;
  color: @text-3;
  margin-top: 4vh;
  margin-left: 4vh;
}
</style>
