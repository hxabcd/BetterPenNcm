<template>
  <div class="pcard" @click="$emit('select')">
    <div class="pcard-cv">
      <image v-if="localCover" class="pcard-cvi" :src="localCover" resize="cover" />
    </div>
    <div class="pcard-info">
      <text class="pcard-nm">{{ item.name }}</text>
      <text class="pcard-ct">{{ item.count }} 首</text>
    </div>
  </div>
</template>

<script>
import { ensureCover } from '../utils/cover.js'

/**
 * 横向封面卡：封面 + 名称 + 曲目数
 *
 * 通用卡：歌单页（网格，一行 4 张）与歌手页的专辑行（横向滑动）共用。
 * 所以 prop 叫 `item` 而不是 `playlist` —— 专辑按 {id: 'al'+专辑id, name, count: 曲目数,
 * cover} 映射进来即可；id 带前缀是为了不和歌曲 id 在 cover 缓存里撞车。
 * 封面由卡片自己 mounted 时按需取（同 SongRow 的理由）。
 */
export default {
  name: 'PlaylistCard',
  props: {
    item: { type: Object, required: true },
    /** 封面缩略图边长；卡片封面 28vh ≈ 67px，默认 60 略糊，专辑行传 120 */
    coverSize: { type: Number, default: 60 }
  },
  data() {
    return { localCover: '' }
  },
  mounted() {
    const self = this
    ensureCover(this.item, function (id, path) {
      if (path) self.localCover = path
    }, this.coverSize)
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

/* 92.5vh：歌单页一行 4 张 + 每张 5vh 右间距 = 4×(92.5+5) = 390vh，
   内容区可用宽 = 左栏 25vh 之后（400vh）− 列表页左右内边距 7vh = 393vh，390 ≤ 393 放得下
   （2026-10-30 左栏由 28vh 收窄到 25vh，多出 3vh 余量；改左栏宽度时要重算这里）。 */
.pcard {
  width: 92.5vh;
  height: 36vh;
  background-color: @panel;
  border-width: 1px;
  border-style: solid;
  border-color: @line;
  border-radius: @radius;
  flex-direction: row;
  align-items: center;
  padding-left: 3vh;
  padding-right: 3vh;
  margin-right: 5vh;
}
.pcard-cv {
  width: 28vh;
  height: 28vh;
  border-radius: 1.4vh;
  background-color: @panel-2;
  overflow: hidden;
  margin-right: 3vh;
}
.pcard-cvi {
  width: 28vh;
  height: 28vh;
}
.pcard-info {
  flex: 1;
}
.pcard-nm {
  font-size: @fs-dim;
  color: @text;
  font-weight: bold;
  lines: 1;
  text-overflow: ellipsis;
}
.pcard-ct {
  font-size: @fs-mute;
  color: @text-3;
  margin-top: 1vh;
}
</style>
