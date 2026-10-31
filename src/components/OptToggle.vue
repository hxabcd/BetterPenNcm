<template>
  <div class="otog">
    <opt-chip text="开" :on="on" @pick="$emit('change', true)" />
    <opt-chip text="关" :on="!on" @pick="$emit('change', false)" />
  </div>
</template>

<script>
/**
 * 「开 / 关」两枚胶囊。
 *
 * 各页的 `.xx-chips` 容器样式（flex 行 + 居中）由本组件的 .otog 承接，
 * 所以页面里连容器一起换成它。
 *
 * 用法：<opt-toggle :on="x" @change="setX" />   // setX(true | false)
 */
import OptChip from './OptChip.vue'

export default {
  name: 'OptToggle',
  components: { 'opt-chip': OptChip },
  props: {
    on: { type: Boolean, default: false }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

/* 等价于原各页的 .xx-chips（.po-chips/.dl-chips/.xp-chips/.lk-chips 逐字节相同） */
.otog {
  flex-direction: row;
  align-items: center;
}
</style>
