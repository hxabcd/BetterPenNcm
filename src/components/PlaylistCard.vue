<template>
  <div class="pcard" :style="widthStyle" @click="$emit('select')">
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
import { ensureCover } from '../services/cover/cover.js'

/**
 * 横向封面卡：封面 + 名称 + 曲目数
 *
 * 通用卡：歌单页（网格，一行 4 张）与歌手页的专辑行（横向滑动）共用。
 * 所以 prop 叫 `item` 而不是 `playlist` —— 专辑按 {id: coverKey('album', 专辑id), name,
 * count: 曲目数, cover} 映射进来即可；id 带前缀是为了不和歌曲 id 在 cover 缓存里撞车。
 * 封面由卡片自己 mounted 时按需取（同 SongRow 的理由）。
 */
export default {
  name: 'PlaylistCard',
  props: {
    item: { type: Object, required: true },
    /** 封面缩略图边长；卡片封面 28vh ≈ 67px，默认 60 略糊，专辑行传 120 */
    coverSize: { type: Number, default: 60 },
    /** 定宽（px）；0 = 用 LESS 里的 92.5vh 默认值。
     *  网格按列数自适应时由父页面给（见 core/platform/viewport.js 的 fitColumns）：
     *  X3S 800 宽下 4 列放不下、3 列也要略收窄，百分比/固定 vh 都会溢出。 */
    widthPx: { type: Number, default: 0 }
  },
  data() {
    return { localCover: '' }
  },
  computed: {
    widthStyle() {
      return this.widthPx > 0 ? { width: this.widthPx + 'px' } : {}
    }
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

/* 默认 92.5vh（S7 上一行 4 张的定宽）。
   ⚠ 窄屏（X3S/X5 800 宽）上 4 张放不下：列数与每张宽度由页面的 fitColumns 实算后
   走 widthPx prop 内联覆盖（见 pages/playlists/playlists.vue），这里只是 S7 兜底。
   宽度**不能用百分比**：百分比基准是列表内容宽，随机型漂移会让末卡溢出被裁。 */
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
