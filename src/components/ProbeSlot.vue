<template>
  <view class="pslot">
    <text class="pslot-t">SLOT</text>
    <slot></slot>
  </view>
</template>

<style lang="less" scoped>
.pslot {
  width: 100px;
  height: 36px;
  background-color: #204a4a;
  display: flex;
  flex-direction: row;
  align-items: center;
}
.pslot-t {
  font-size: 14px;
  color: #99ffff;
}
</style>

<script>
/* 探针用：带 slot 的容器，验证 v-if 切换结构时的渲染稳定性 */
export default {
  name: 'probe-slot'
}
</script>
