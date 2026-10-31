<template>
  <div class="dlrow" @click="onOpen">
    <div class="dlrow-cv">
      <image v-if="shownCover" class="dlrow-cvi" :src="shownCover" resize="cover" />
      <image v-else class="dlrow-ico" :src="item.icon || ICON.music" />
    </div>
    <div class="dlrow-main">
      <text class="dlrow-nm">{{ item.name }}</text>
      <text class="dlrow-sub">{{ item.sub }}</text>
    </div>
    <text class="dlrow-flag" v-if="item.flag" :style="flagStyle">{{ item.flag }}</text>
    <image class="dlrow-cue" :src="ICON.chevright" />
  </div>
</template>

<script>
/**
 * 本地下载-歌单索引页的行：封面/图标 + 歌单名 + 副行 + 可进入提示。
 *
 * 与 SongRow / EntryRow 的区别：这一页是「歌单条目」不是歌曲，行高更大，
 * 支持两种视觉——有封面的歌单（cover + coverId）与无封面的特殊入口
 * （全部下载 / 单曲下载 / 遗留歌曲，显示一个图标）。
 *
 * 封面由行自己 mounted 时取（cover.js 队列），回调里写组件自己的普通属性，
 * 绕开「页面 data 动态 key + $set 不触发重渲染」的平台坑。
 */
import { ensureCover } from '../utils/cover.js'
import { ICON } from '../assets/icons.js'
import { TOK } from '../utils/ui/tokens.js'

export default {
  name: 'LibraryRow',
  props: {
    /** {name, sub, cover, coverId, icon, flag} */
    item: { type: Object, required: true }
  },
  data() {
    return { localCover: '', ICON: ICON }
  },
  computed: {
    shownCover() {
      return this.localCover
    },
    flagStyle() {
      const f = this.item.flag || ''
      return { color: f === 'D' ? TOK.dangerSoft : TOK.ok }
    }
  },
  mounted() {
    const self = this
    const cid = this.item.coverId || this.item.id
    if (!this.item.cover || !cid) return
    ensureCover({ id: cid, cover: this.item.cover }, function (id, path) {
      if (path) self.localCover = path
    })
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

/* 行高 28vh（≈67px）：比歌曲行 23vh 高，放封面 + 两行文字。 */
.dlrow {
  height: 28vh;
  flex-direction: row;
  align-items: center;
  padding-left: 4vh;
  padding-right: 4vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.dlrow-cv {
  width: 22vh;
  height: 22vh;
  flex: none;
  border-radius: 1.4vh;
  background-color: @panel-2;
  overflow: hidden;
  margin-right: 3vh;
  align-items: center;
  justify-content: center;
}
.dlrow-cvi {
  width: 22vh;
  height: 22vh;
}
/* 特殊入口的图标：封面盒里居中，11vh ≈ 26px */
.dlrow-ico {
  width: 11vh;
  height: 11vh;
}
.dlrow-main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
  justify-content: center;
}
.dlrow-nm {
  font-size: @fs-strong;
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
.dlrow-sub {
  font-size: @fs-mute;
  color: @text-3;
  lines: 1;
  text-overflow: ellipsis;
  margin-top: 1.2vh;
}
/* A/D 等状态标记（歌单索引行用；普通行没有） */
.dlrow-flag {
  font-size: @fs-dim;
  font-weight: bold;
  color: @ok;
  flex: none;
  margin-left: 2vh;
}
/* 可进入提示：灰色 chevron（同 CueRow） */
.dlrow-cue {
  width: 11vh;
  height: 11vh;
  flex: none;
  margin-left: 2vh;
}
</style>
