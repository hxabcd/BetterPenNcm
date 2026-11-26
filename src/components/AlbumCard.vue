<template>
  <div :class="cardClass" :style="widthStyle" @click="onOpen">
    <div class="alb-cv">
      <image v-if="shownCover" class="alb-img" :src="shownCover" resize="cover" />
      <image v-else class="alb-note" :src="ICON.note" />
    </div>
    <div class="alb-info">
      <text class="alb-nm">{{ item.name || '未知专辑' }}</text>
      <text class="alb-ar">{{ item.artist || '未知歌手' }}</text>
      <text class="alb-meta">{{ meta }}</text>
    </div>
  </div>
</template>

<script>

/**
 * 列数 2/3/4 由父页面 `cols` 传入，卡片宽度用三个独立完整类名切换。
 * ⚠ 默认百分比只是 S7 兜底，窄屏（X3S/X5 800 宽）由父页面按内容区宽度实算后走 widthPx 覆盖：
 * 百分比基准是列表内容宽，机型一变末列就溢出被裁；也不能用 >100vh 的 vh 宽度（平台静默截到 100vh）。
 * 封面取自专辑内歌曲的封面（localmeta.localAlbumList 的 cover），自己走 cover.js 队列，离线命中磁盘缓存。
 */
import { ensureCover, coverKey } from '../services/cover/cover.js'
import { ICON } from '../assets/icons.js'

export default {
  name: 'AlbumCard',
  props: {

    /** {id, name, artist, count, year, cover, coverId} */

    item: { type: Object, required: true },
    cols: { type: Number, default: 4 },

    /** 定宽（px）；0 = 用 LESS 里的百分比默认值。网格按列数自适应时由父页面给（fitColumns） */

    widthPx: { type: Number, default: 0 }
  },
  data() {
    return { localCover: '', ICON: ICON }
  },
  computed: {
    widthStyle() {
      return this.widthPx > 0 ? { width: this.widthPx + 'px' } : {}
    },
    shownCover() {
      return this.localCover
    },
    cardClass() {
      const n = this.cols === 2 ? 2 : this.cols === 3 ? 3 : 4
      return 'alb-card alb-' + n
    },
    meta() {
      const y = this.item.year
      return (this.item.count || 0) + ' 首' + (y ? ' · ' + y : '')
    }
  },
  mounted() {
    const self = this
    const cid = this.item.coverId || coverKey('album', this.item.id)
    if (!this.item.cover || !cid) return
    ensureCover({ id: cid, cover: this.item.cover }, function (id, path) {
      if (path) self.localCover = path
    }, 120)
  },
  methods: {
    onOpen() {
      this.$emit('open')
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

.alb-card {
  height: 40vh;
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
/* 列数的三个完整类名：平台只认单类名，.alb.alb-2 这种复合选择器不生效 */
.alb-4 {
  width: 23%;
}
.alb-3 {
  width: 31%;
}
.alb-2 {
  width: 47%;
}
.alb-cv {
  width: 30vh;
  height: 30vh;
  flex: none;
  border-radius: 1.4vh;
  background-color: @panel-2;
  overflow: hidden;
  margin-right: 3vh;
  align-items: center;
  justify-content: center;
}
.alb-img {
  width: 30vh;
  height: 30vh;
}
.alb-note {
  width: 14vh;
  height: 14vh;
}
.alb-info {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
  justify-content: center;
}
.alb-nm {
  font-size: @fs-dim;
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
.alb-ar {
  font-size: @fs-mute;
  color: @text-2;
  lines: 1;
  text-overflow: ellipsis;
  margin-top: 1vh;
}
.alb-meta {
  font-size: @fs-mute;
  color: @text-3;
  lines: 1;
  text-overflow: ellipsis;
  margin-top: 0.8vh;
}
</style>
