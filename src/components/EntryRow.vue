<template>
  <div class="erow" @click="onClick">
    <div class="erow-cv">
      <image v-if="shownCover" class="erow-cvi" :src="shownCover" resize="cover" />
    </div>
    <div class="erow-main">
      <text class="erow-nm">{{ item.name }}</text>
      <text class="erow-sub">{{ item.sub }}</text>
    </div>
  </div>
</template>

<script>
/**
 * 条目行：封面 / 标题 / 副行 —— 搜索结果里**不是歌曲**的那三类（歌手 / 歌单 / 专辑）共用。
 *
 * 为什么不复用 SongRow：那三类没有歌手名/时长这两列，行结构是「封面 + 上下两行文字」，
 * 硬套 SongRow 会空出右半屏。反过来也一样：本组件不接多选（那三类没有「下载选中」的语义）。
 *
 * 封面用 item.kid 当缓存键（'arp'+id / 'al'+id / 'pl'+id）：歌手/专辑/歌单的 id 与歌曲 id
 * 是**各自独立编号**的，不前缀就会在 cover.js 的缓存里互相顶掉（封面张冠李戴）。
 * 歌手用 arp 前缀与本地下载-歌手/歌手详情共用同一个真头像缓存。
 * 行内自己取封面（mounted → ensureCover → 组件自己的 localCover），
 * 与 SongRow 同款写法：绕开「页面 data 动态 key 不触发重渲染」那条平台坑。
 */
import { ensureCover } from '../utils/cover.js'

export default {
  name: 'EntryRow',
  props: {
    /** {id, kid, name, sub, cover} —— 由 utils/ncm/api.js 的 searchByType 归一 */
    item: { type: Object, required: true }
  },
  data() {
    return { localCover: '' }
  },
  computed: {
    shownCover() {
      return this.localCover
    }
  },
  mounted() {
    const self = this
    ensureCover({ id: this.item.kid, cover: this.item.cover }, function (id, path) {
      if (path) self.localCover = path
    })
  },
  methods: {
    onClick() {
      this.$emit('open')
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

/* 行高/留白与 SongRow 对齐（@row-h + 左右 4vh）：同一列表里两种行混排时不跳行距 */
.erow {
  height: @row-h;
  flex-direction: row;
  align-items: center;
  padding-left: 4vh;
  padding-right: 4vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
/* 封面盒与 .srow-cv 同尺寸（17vh）：歌手头像/专辑/歌单封面都是方图，一律圆角方，
   不做正圆 —— 正圆在 2.4px/vh 的小屏上会把方图裁掉四角（专辑名看不全的错觉来源） */
.erow-cv {
  width: 17vh;
  height: 17vh;
  border-radius: 1.4vh;
  background-color: @panel-2;
  overflow: hidden;
  margin-right: 2.6vh;
}
.erow-cvi {
  width: 17vh;
  height: 17vh;
}
/* 文字区：标题在上、副行在下，两行都单行截断（不写 lines 会整段折行，行高就撑爆了） */
.erow-main {
  flex: 1;
  flex-direction: column;
  justify-content: center;
  overflow: hidden;
}
.erow-nm {
  font-size: @fs-strong;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
.erow-sub {
  font-size: @fs-dim;
  color: @text-2;
  lines: 1;
  text-overflow: ellipsis;
  margin-top: 0.6vh;
}
</style>
