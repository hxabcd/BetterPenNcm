<template>
  <div class="arow" @click="onOpen">
    <div class="arow-av">
      <image v-if="shownCover" class="arow-img" :src="shownCover" resize="cover" />
      <image v-else class="arow-ico" :src="ICON.user" />
    </div>
    <text class="arow-nm">{{ item.name || '未知歌手' }}</text>
    <text class="arow-ct">{{ item.count }} 首</text>
    <image class="arow-cue" :src="ICON.chevright" />
  </div>
</template>

<script>
/**
 * 本地下载-歌手的行：圆形头像 + 名称 + 歌曲数量 + 可进入提示。
 *
 * 行高 32vh（≈77px），比歌曲行 23vh 高——需求明确「行高更高，单行含头像、名称、歌曲数量」。
 *
 * 头像顺序（与歌手详情共用同一套来源，避免同一歌手两处不同图）：
 *   1) 真头像：artistavatar.resolveArtistPortrait → arp<id>@60（有 meta 或在线取轻量接口）
 *   2) 兜底：代表专辑封面 al<albumId>@60（下载完成时已预热，离线可命中）
 *   3) 都没有：人形图标
 * 先立刻铺兜底图，真头像就绪后覆盖；真头像拿不到就保留兜底图。
 */
import { resolveArtistPortrait, PORTRAIT_SIZE } from '../utils/artistavatar.js'
import { ensureCover, cachedCover } from '../utils/cover.js'
import { ICON } from '../assets/icons.js'

export default {
  name: 'ArtistRow',
  props: {
    /** {id, name, count, cover, albumId} */
    item: { type: Object, required: true }
  },
  data() {
    return { localCover: '', ICON: ICON }
  },
  computed: {
    shownCover() {
      return this.localCover
    },
    /** watch 的目标用 computed，避免依赖模板/预编译器对 `item.cover` 路径 watch 的支持差异 */
    coverSrc() {
      return this.item.cover
    },
    artistId() {
      return this.item.id
    }
  },
  watch: {
    coverSrc: function () {
      this.loadCover()
    },
    artistId: function () {
      this.loadCover()
    }
  },
  mounted() {
    this._alive = true
    // 挂载前若被 watch 先算过一次（组件复用/初始化顺序），这里强制重来，避免 _alive 尚未置位
    this._coverSig = ''
    this.loadCover()
  },
  beforeDestroy() {
    this._alive = false
  },
  methods: {
    fallbackKey() {
      const albumId = Number(this.item.albumId) || 0
      if (albumId) return 'al' + albumId
      return 'arf' + (Number(this.item.id) || this.item.id)
    },
    loadCover() {
      const item = this.item || {}
      const id = Number(item.id) || 0
      const sig = id + '|' + (item.cover || '') + '|' + (Number(item.albumId) || 0)
      if (sig === this._coverSig) return
      this._coverSig = sig
      this._portrait = false
      const fk = this.fallbackKey()
      this.localCover = cachedCover('arp' + id, PORTRAIT_SIZE) || cachedCover(fk, PORTRAIT_SIZE) || ''
      this.loadFallback(fk)
      if (!id) return
      const self = this
      resolveArtistPortrait(id, PORTRAIT_SIZE, true).then(function (url) {
        if (!self._alive || !url) return
        if ((Number((self.item || {}).id) || 0) !== id) return
        self._portrait = true
        self.localCover = url
      }).catch(function () {})
    },
    loadFallback(fk) {
      const item = this.item || {}
      if (!item.cover) return
      const id = Number(item.id) || 0
      const self = this
      ensureCover({ id: fk, cover: item.cover }, function (cid, path) {
        if (!path || !self._alive || self._portrait) return
        if ((Number((self.item || {}).id) || 0) !== id) return
        self.localCover = path
      }, PORTRAIT_SIZE)
    },
    onOpen() {
      this.$emit('open')
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

.arow {
  height: 32vh;
  flex-direction: row;
  align-items: center;
  padding-left: 4vh;
  padding-right: 4vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
/* 圆形头像：直径 26vh → 圆角半值 13vh（平台不认 50%） */
.arow-av {
  width: 26vh;
  height: 26vh;
  flex: none;
  border-radius: 13vh;
  background-color: @panel-2;
  overflow: hidden;
  align-items: center;
  justify-content: center;
  margin-right: 4vh;
}
.arow-img {
  width: 26vh;
  height: 26vh;
}
.arow-ico {
  width: 13vh;
  height: 13vh;
}
.arow-nm {
  flex: 1;
  min-width: 0;
  font-size: @fs-strong;
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
.arow-ct {
  flex: none;
  font-size: @fs-mute;
  color: @text-3;
  margin-left: 3vh;
}
.arow-cue {
  width: 11vh;
  height: 11vh;
  flex: none;
  margin-left: 2vh;
}
</style>
