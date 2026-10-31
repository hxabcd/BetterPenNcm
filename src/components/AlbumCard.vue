<template>
  <div :class="cardClass" @click="onOpen">
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
 * 本地下载-专辑的卡：封面 + 专辑名(L1) + 专辑艺术家(L2) + 歌曲数量/年份(L3)。
 *
 * 列数 2/3/4 由父页面通过 `cols` 传入，卡片宽度用三个独立完整类名切换
 * （平台只认单类名，不能写 .alb.alb-2 这种复合选择器）。
 * ⚠ 宽度**不能用 >100vh 的 vh**：平台会把任何 >100vh 的宽度静默截到 100vh
 * （AGENTS 坑 18）。2 列 47% / 3 列 31% / 4 列 23%，加 5vh 右间距后
 * 2/3/4 列总宽分别约 94%+24px / 93%+36px / 92%+48px，都在内容区内。
 *
 * 封面取专辑内歌曲的封面（localmeta.localAlbumList 的 cover），
 * 行内自己走 cover.js 队列，离线命中磁盘缓存。
 */
import { ensureCover } from '../utils/cover.js'
import { ICON } from '../assets/icons.js'

export default {
  name: 'AlbumCard',
  props: {
    /** {id, name, artist, count, year, cover, coverId} */
    item: { type: Object, required: true },
    cols: { type: Number, default: 4 }
  },
  data() {
    return { localCover: '', ICON: ICON }
  },
  computed: {
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
    const cid = this.item.coverId || ('al' + this.item.id)
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

/* 列数切换的三个完整类名。宽高按 4 列基准，2/3 列只加宽不改高。 */
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
