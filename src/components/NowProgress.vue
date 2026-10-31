<template>
  <div class="np-groove" :style="boxStyle">
    <div class="np-fill" :style="fillStyle"></div>
  </div>
</template>

<script>
/**
 * 「正在播放」卡底部的**只读进度线**（照播放页收起态那条 `.ply-pline` 做的：
 * 一条细线 = 槽 + 主题色填充，无手柄、不显示时间、不可拖动）。
 *
 * 为什么单独做成组件、而不是算进首页的 data：
 *   播放位置每 500ms 变一次，而首页那行是**横向 scroller**，整页重渲染有把用户滑走的
 *   卡片甩回最左边的风险。首页自己的 `onPlayer` 是**故意不认 positionMs** 的
 *   （签名里只有「换歌/暂停」这类肉眼可见的变化），所以进度只能由这个子组件自己订阅、
 *   自己重渲染 —— 与 NowLyric 同一个套路。
 *
 * 判重纪律（平台坑 16：同一个值会被以 500ms 频率反复回调）：
 *   ① 显示/隐藏变了才写；② 百分比量化到 **0.2% 一档**（≈0.8px）再写 —— 4 分钟的歌
 *   也就 ~500 次有效更新，而不是每 500ms 都触发一次重渲染。
 *   而且**始终不改结构**（用高度 0 收起，不上 v-if）：首页卡片里的兄弟节点结构是敏感的
 *   （实测 v-if 换结构会让 slot 插错位）。
 */
import { player } from '../utils/player/player.js'
import { accentMixin } from '../utils/theme.js'

export default {
  name: 'NowProgress',
  mixins: [accentMixin], // 填充色 = 当前主题色（与同卡的主控键、播放页那条线一致）
  data() {
    return { pct: 0, vis: false }
  },
  computed: {
    /** 收起 = 高度 0（不占位、不参与布局），不用 v-if 换结构 */
    boxStyle() {
      return { height: this.vis ? '1.4vh' : '0vh' }
    },
    fillStyle() {
      return { width: this.pct + '%', backgroundColor: this.accent.c }
    }
  },
  mounted() {
    const self = this
    this._handler = function (s) {
      self.onPlayer(s)
    }
    player.on(this._handler)
    this.onPlayer(player.state())
  },
  beforeDestroy() {
    if (this._handler) player.off(this._handler)
    this._handler = null
  },
  methods: {
    /**
     * 时长两个来源：模块级 `durationMs`（播放中回填的最准）→ 兜 `cur.durationMs`
     * （下载页来的老条目缺时长但详情接口可能补过）。都没有就不显示这条线。
     */
    onPlayer(s) {
      const dur = (s && s.durationMs) || (s && s.cur && s.cur.durationMs) || 0
      const vis = !!(s && s.cur && s.cur.id) && dur > 0
      let pct = 0
      if (vis) {
        const p = Math.min(1, Math.max(0, ((s && s.positionMs) || 0) / dur))
        pct = Math.round(p * 500) / 5 // 0.2% 一档
      }
      if (vis === this.vis && pct === this.pct) return
      this.vis = vis
      this.pct = pct
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

.np-groove {
  position: absolute;
  /* ⚠ 真机实测：`left: 5vh; right: 5vh` **两个都被忽略**，线是通栏铺满卡宽的。
     所以这里老老实实写 `left: 0 + width: 100%`（= 卡片 padding box 宽），别指望内缩。
     通栏也正好和播放页那条一致；圆角 6px 只让线的左右两端在最底那一行探出 ~1.5px，看不出来。 */
  left: 0;
  width: 100%;
  bottom: 0;
  height: 1.4vh;
  background-color: @panel-2;
  border-radius: 1.4vh;
  overflow: hidden;
}
.np-fill {
  height: 1.4vh;
  border-radius: 1.4vh;
}
</style>
