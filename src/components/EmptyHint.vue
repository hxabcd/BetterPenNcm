<template>
  <text class="e-hint">{{ text }}</text>
</template>

<script>
/**
 * 列表空态 / 加载中提示行 —— 全站唯一实现。
 *
 * 统一口径 = @fs-dim + @text-3 + margin-top 4vh + margin-left 4vh。
 *
 * 之所以连「加载中」也归它：各页的 hint 字段本来就把「加载中 / 加载失败 / 空」三态共用一个
 * 文案位（list/playlists/album… 都是），组件只管呈现，语义由页面给。
 * 例外：plinfo 的「暂无介绍」在简介框**里面**（是框内占位，不是列表空态），仍用页面自己的类。
 *
 * 用法：<empty-hint :text="hint" />  /  <empty-hint v-if="!songs.length" text="播放列表为空" />
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
