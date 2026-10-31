<template>
  <div class="nl-box" :style="boxStyle">
    <text class="nl-line">{{ text }}</text>
  </div>
</template>

<script>
/**
 * 当前歌词行（**只原文、单行**）—— 首页「正在播放」卡片的第三行。
 *
 * 为什么单独做成组件、而不是算在首页的 data 里：
 *   歌词每几秒换一行，而本平台一次 data 变更就是一次整页重渲染；首页那行是横向
 *   scroller，整页重渲染有把用户滑走的卡片甩回最左边的风险。圈进子组件后，
 *   重渲染只落在这一个 text 节点上，首页自身的重渲染频率仍是原来的「换歌/暂停才动」。
 *
 * 判重纪律与播放页一致（平台坑 16：同一个值会被以 500ms 频率反复回调）：
 *   「换歌」按 id 判重、显示内容按「算出来的结果是否变了」判重，都不依赖框架的去重语义。
 * 歌词数据走 utils/player/lyric.js 的会话缓存，与播放页共用，不额外发请求。
 *
 * 受**播放选项**里的「歌词开关」管辖（`bpncm:playeropts` 事件即时生效）：
 *   关掉 = 这一行整条收起，标题·歌手回到卡内居中，和「这首歌没歌词」一个样子。
 *   仅原文——翻译是播放页的显示选项，卡片只有一行，不掺进来。
 */
import { player } from '../utils/player/player.js'
import { loadLyrics, findLyricIndex } from '../utils/player/lyric.js'
import config from '../utils/config.js'
import { log } from '../utils/log.js'

export default {
  name: 'NowLyric',
  data() {
    return { text: '', boxOn: false }
  },
  computed: {
    /**
     * 行盒高度走**内联 style**（平台不支持复合类名做状态）：
     *   - 显示歌词（开关开着**且**整首有词）→ 固定 10vh。行盒不跟着「当前行有没有内容」
     *     塌掉，换行/前奏空档时上面两行纹丝不动（每句歌词都让标题抖一下是最难受的）。
     *   - 不显示（无歌词数据 / 纯音乐 / 未在播放 / 播放选项里关掉了歌词）→ 行盒 0 高、
     *     不占位，标题·歌手照旧按原样在卡内垂直居中（无歌词时不要上移）。
     */
    boxStyle() {
      return this.boxOn
        ? { height: '10vh', marginTop: '5vh' } // 5vh：作者与歌词之间的间距要比「标题·作者」那对（1.6vh）明显更松
        : { height: '0vh', marginTop: '0vh' }
    }
  },
  mounted() {
    const self = this
    this._key = '' // 已处理的曲目 id
    this._lines = []
    this._lyricOn = config.get('lyricOn') !== false
    this._handler = function (s) {
      self.onPlayer(s)
    }
    player.on(this._handler)
    // 播放选项页改「歌词开关」→ 这里即时生效（与播放页同一个订阅方式）
    this._optsEvt = function () {
      self.readOpts()
    }
    try {
      /* global $falcon */
      $falcon.on('bpncm:playeropts', this._optsEvt)
    } catch (e) {}
    this.onPlayer(player.state())
  },
  beforeDestroy() {
    if (this._handler) player.off(this._handler)
    this._handler = null
    try {
      /* global $falcon */
      if (this._optsEvt) $falcon.off('bpncm:playeropts', this._optsEvt)
    } catch (e) {}
    this._optsEvt = null
  },
  methods: {
    onPlayer(s) {
      const id = (s && s.cur && s.cur.id) || 0
      if (String(id) !== this._key) {
        this._key = String(id)
        this.load(id)
      }
      this.sync(s)
    },
    /** 播放选项里的「歌词开关」变了：重算一遍（关掉 → 行盒塌掉、标题回到居中） */
    readOpts() {
      const on = config.get('lyricOn') !== false
      if (on === this._lyricOn) return
      this._lyricOn = on
      this.sync(player.state())
    },
    /**
     * 按「开关 + 已取到的歌词 + 当前位置」决定显示什么，**算出来的结果没变就什么都不做**
     * （订阅每 500ms 来一次，平台坑 16）。有歌词但当刻还没到某一句（前奏/间奏空档）
     * 显示 `-`——行盒仍在，标题不会因为「这一句有没有内容」上下跳。
     */
    sync(s) {
      const boxOn = this._lyricOn && this._lines.length > 0
      const i = boxOn ? findLyricIndex(this._lines, (s && s.positionMs) || 0) : -1
      const l = boxOn ? this._lines[i] : null
      const t = boxOn ? ((l && l.text) || '-') : ''
      if (boxOn === this.boxOn && t === this.text) return
      this.boxOn = boxOn
      this.text = t
    },
    async load(id) {
      this._lines = []
      this.sync(player.state()) // 换歌瞬间先把上一首的行清掉
      if (!id) return
      const r = await loadLyrics(id)
      if (String(id) !== this._key) return // 期间换歌了，丢弃这次结果
      this._lines = r.lines
      this.sync(player.state())
      log('nowlyric', 'id=' + id + ' 行数=' + r.lines.length)
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

/* 行盒**高度与上边距走内联 style**（boxStyle，见 script）：有无歌词两种状态不用复合类名。
   这里只放不随状态变的几何 —— 10vh ≈ 一个 @fs-dim 行高。 */
.nl-box {
  overflow: hidden;
  flex-direction: row;
  align-items: center;
}
.nl-line {
  font-size: @fs-dim;
  color: @text-3;
  lines: 1;
  text-overflow: ellipsis;
}
</style>
