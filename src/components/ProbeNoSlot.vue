<template>
  <view class="pnslot">
    <text class="pnslot-t">NS</text>
  </view>
</template>

<style lang="less" scoped>
.pnslot {
  width: 100px;
  height: 36px;
  background-color: #4a204a;
  display: flex;
  flex-direction: row;
  align-items: center;
}
.pnslot-t {
  font-size: 14px;
  color: #ff99ff;
}
</style>

<script>
/* 探针用：不含 slot 的组件，验证 v-if 切换结构时的渲染稳定性 */
export default {
  name: 'probe-noslot'
}
</script>
