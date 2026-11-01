<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="播放设置" :sub="hint" />
    <!-- 行数远超一屏，必须 scroller（同 settings/queue 页） -->
    <scroller class="po-body">
      <div class="po-row">
        <text class="po-label">倍速</text>
        <div class="po-chips">
          <opt-chip v-for="r in rates" :key="'r' + r" :text="rateLabel(r)" :on="r === rate" @pick="pickRate(r)" />
        </div>
      </div>

      <div class="po-row">
        <text class="po-label">歌词</text>
        <opt-toggle :on="lyricOn" @change="setLyric" />
      </div>

      <div class="po-row">
        <text class="po-label">歌词翻译</text>
        <opt-toggle :on="showTrans" @change="setTrans" />
      </div>
      <text class="po-note" v-if="!lyricOn">歌词已关闭，翻译不生效</text>

      <!-- 逐字歌词（config.lyricWord，默认开）：服务端有 YRC 时活动行按字点亮/扫亮；
           无 YRC 自动回退逐行。关闭 = 活动行也保持单文本节点，不建逐字动画。 -->
      <div class="po-row">
        <text class="po-label">逐字歌词</text>
        <opt-toggle :on="lyricWord" @change="setWord" />
      </div>
      <text class="po-note" v-if="!lyricWord">无逐字数据时自动回退逐行</text>

      <!-- 歌词动画（config.lyricAnim，默认开）：滚动/字号高亮/逐字扫亮的过渡总开关；
           关闭 = 定位与逐字进度照常更新，但全部瞬时完成。 -->
      <div class="po-row">
        <text class="po-label">歌词动画</text>
        <opt-toggle :on="lyricAnim" @change="setAnim" />
      </div>
      <text class="po-note" v-if="!lyricAnim">滚动与高亮瞬时完成</text>

      <div class="po-row">
        <text class="po-label">歌词渲染</text>
        <div class="po-chips">
          <!-- 「整首 / 省性能」不是开/关文案，用两枚 opt-chip 而不是 opt-toggle -->
          <opt-chip text="整首" :on="lyricFull" @pick="setFull(true)" />
          <opt-chip text="省性能" :on="!lyricFull" @pick="setFull(false)" />
        </div>
        <text class="po-note" v-if="!lyricFull">只跟随当前行，无法拖动</text>
      </div>

      <!-- 自动跟歌（config.lyricFollow，默认开）：活动行更新时平滑滚动到该行；
           关掉 = 只换高亮、轨道不动（手动翻看时不会被拽走）。
           注意：手动翻看时高亮**始终**跟着播放进度，这条不受本开关影响。 -->
      <div class="po-row">
        <text class="po-label">自动跟歌</text>
        <opt-toggle :on="lyricFollow" @change="setFollow" />
      </div>
      <text class="po-note" v-if="!lyricFollow">只更新高亮，不自动滚动</text>

      <div class="po-row">
        <text class="po-label">双击跳转</text>
        <opt-toggle :on="lyricDbl" @change="setDbl" />
        <text class="po-note" v-if="!lyricOn">歌词已关闭</text>
      </div>

      <!-- 两个音质档位在「音质与存储」（pages/setdl），不在这里 ——            音质与缓存、存储放一组，播放页只留「怎么放」的开关 -->

      <!-- 退出时暂停音乐（config.pauseOnExit，默认开）：退出前调 player.pauseForExit()；
           关掉 = 退出后音乐继续放（系统播放服务是独立进程） -->
      <div class="po-row">
        <text class="po-xlabel">退出时暂停音乐</text>
        <opt-toggle :on="pauseOnExit" @change="setPauseExit" />
      </div>
    </scroller>
  </page-shell>
</template>

<script>
/**
 * 播放设置页（不是浮窗；升级为**设置 → 播放**的二级页）
 *
 * 落点有两个（同一份页面，别再拆成两份）：
 *   ① 设置页「播放」分组；② 播放页左栏的「选项」键（go('playeropts')）。
 * 内容：倍速 / 歌词开关 / 歌词翻译 / 逐字歌词 / 歌词动画 / 歌词渲染（整首 ↔ 省性能）/ 自动跟歌 / 双击跳转 / 退出时暂停音乐。
 * **音质不在这里**：播放音质 + 下载音质 + 缓存上限 + 存储管理
 *   统一归「音质与存储」（pages/setdl）—— 本页只留「怎么放」的开关。
 * 改动即时生效并持久化（config），播放页/歌词组件订阅 `bpncm:playeropts` 事件刷新自身开关。
 *
 * 尺寸（放大，屏幕物理高仅 2.5cm）：行高 26vh ≈ 62px、chip 高 18vh ≈ 43px
 * （原 20vh / 14vh）、chip 字 @fs-dim（原 @fs-mute）。
 * chip 的 border-width 恒为 1px（未选中时颜色透明）：边框参与盒宽，选中态切换时整排不抖。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import OptChip from '../../components/OptChip.vue'
import OptToggle from '../../components/OptToggle.vue'
import { player, RATES } from '../../utils/player/player.js'
import config from '../../utils/config.js'
import { log } from '../../utils/log.js'

import { pageFrameMixin } from '../../utils/ui/frame.js'

export default {
  name: 'playeropts',
  mixins: [pageFrameMixin],
  components: { 'page-shell': PageShell, 'page-topbar': PageTopbar, 'opt-chip': OptChip, 'opt-toggle': OptToggle },
  data() {
    return {
      rates: RATES,
      rate: 1,
      lyricOn: true,
      showTrans: true,
      lyricWord: true,
      lyricAnim: true,
      lyricFull: true,
      lyricFollow: true,
      lyricDbl: true,
      pauseOnExit: true,
      hint: ''
    }
  },
  computed: {
  },
  async mounted() {
    await config.load()
    const st = player.state()
    this.rate = st.rate || config.get('rate') || 1
    this.lyricOn = config.get('lyricOn') !== false
    this.showTrans = config.get('showTrans') !== false
    this.lyricWord = config.get('lyricWord') !== false
    this.lyricAnim = config.get('lyricAnim') !== false
    this.lyricFull = config.get('lyricFull') !== false
    this.lyricFollow = config.get('lyricFollow') !== false
    this.lyricDbl = config.get('lyricDbl') !== false
    this.pauseOnExit = !!config.get('pauseOnExit')
    log('playeropts', '播放设置挂载 rate=' + this.rate + ' 歌词=' + this.lyricOn + ' 翻译=' + this.showTrans +
      ' 逐字=' + this.lyricWord + ' 动画=' + this.lyricAnim +
      ' 渲染=' + (this.lyricFull ? '整首' : '省性能') + ' 跟歌=' + this.lyricFollow +
      ' 双击=' + this.lyricDbl + ' 退出暂停=' + this.pauseOnExit)
  },
  methods: {
    rateLabel(r) {
      // 1 -> "1x"，1.25 -> "1.25x"
      return String(r).replace(/\.0+$/, '') + 'x'
    },
    async pickRate(r) {
      this.rate = r
      this.hint = '倍速 ' + this.rateLabel(r)
      await player.setRate(r)
      this.notify()
    },
    async setLyric(on) {
      this.lyricOn = on
      await config.set('lyricOn', on)
      this.hint = on ? '歌词已打开' : '歌词已关闭'
      log('playeropts', '歌词 -> ' + on)
      this.notify()
    },
    async setTrans(on) {
      if (!this.lyricOn) {
        this.hint = '歌词关闭时翻译不生效'
        return
      }
      this.showTrans = on
      await config.set('showTrans', on)
      this.hint = on ? '翻译已打开' : '翻译已关闭'
      log('playeropts', '翻译 -> ' + on)
      this.notify()
    },
    /**
     * 逐字歌词（config.lyricWord）：开启后有 YRC 的曲目会按字点亮/扫亮；
     * 无逐字数据自动回退逐行。关闭 = 不建逐字节点，省一点渲染与样式开销。
     */
    async setWord(on) {
      this.lyricWord = on
      await config.set('lyricWord', on)
      this.hint = on ? '逐字歌词已打开' : '逐字歌词已关闭'
      log('playeropts', '逐字歌词 -> ' + on)
      this.notify()
    },
    /** 歌词动画（config.lyricAnim）：滚动 / 字号高亮 / 逐字扫亮的过渡总开关 */
    async setAnim(on) {
      this.lyricAnim = on
      await config.set('lyricAnim', on)
      this.hint = on ? '歌词动画已打开' : '歌词动画已关闭'
      log('playeropts', '歌词动画 -> ' + on)
      this.notify()
    },
    /** 歌词渲染：可拖动翻看整首 / 省性能（禁用拖动，只跟随当前行） */
    async setFull(on) {
      this.lyricFull = on
      await config.set('lyricFull', on)
      this.hint = on ? '歌词整首渲染' : '歌词省性能渲染'
      log('playeropts', '歌词渲染 -> ' + (on ? '整首' : '省性能'))
      this.notify()
    },
    /** 歌词自动跟歌：活动行更新时是否平滑滚动到该行（关掉 = 只换高亮，方便手动翻看） */
    async setFollow(on) {
      this.lyricFollow = on
      await config.set('lyricFollow', on)
      this.hint = on ? '自动跟歌已打开' : '只更新高亮'
      log('playeropts', '自动跟歌 -> ' + on)
      this.notify()
    },
    /** 双击歌词跳转到该行 */
    async setDbl(on) {
      this.lyricDbl = on
      await config.set('lyricDbl', on)
      this.hint = on ? '双击跳转已打开' : '双击跳转已关闭'
      log('playeropts', '双击跳转 -> ' + on)
      this.notify()
    },
    /** 退出时暂停音乐：即改即存；播放器在退出那一刻才读 config，无需广播 */
    async setPauseExit(on) {
      if (on === this.pauseOnExit) return
      this.pauseOnExit = on
      await config.set('pauseOnExit', on)
      this.hint = on ? '退出时暂停音乐' : '退出后继续播放'
      log('playeropts', '退出时暂停音乐 -> ' + on)
    },
    /** 通知播放页刷新开关（跨页面事件总线，index.vue 已有同款先例） */
    notify() {
      try {
        /* global $falcon */
        $falcon.trigger('bpncm:playeropts')
      } catch (e) {}
    },
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* scroller（竖向）：flex:1 吃掉 topbar 以下的高度，内容超出即可上下滚。
   不要写 flex-direction: column —— 竖向 scroller 的内容层本来就是自上而下排的
   （见 settings 页的 .st-list）。上下 padding 兼作「滚到底时最后一行的留白」。 */
/* 左右不给 padding：分隔线**通栏**（与设置索引页一致）；行自己带 6vh 内边距 */
.po-body {
  flex: 1;
  padding-top: 3vh;
  padding-bottom: 3vh;
}
.po-row {
  height: 26vh;
  flex-direction: row;
  align-items: center;
  padding-left: 6vh;
  padding-right: 6vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.po-chips {
  flex-direction: row;
  align-items: center;
}
/* 4 字标签（「歌词翻译」「播放音质」）：4 × 7vh = 28vh，宽给 36vh 留余量（CJK 折行坑） */
.po-label {
  width: 36vh;
  flex: none;
  font-size: @fs-dim;
  color: @text-2;
}
/* 7 字标签（「退出时暂停音乐」）：7 × 7vh = 49vh，宽给 58vh */
.po-xlabel {
  width: 58vh;
  flex: none;
  font-size: @fs-dim;
  color: @text-2;
}
/* 高 18vh ≈ 43px：屏幕物理高只有 2.5cm，点击区给大；
   border-width 恒 1px（未选中透明）→ 选中态切换时盒宽不变，整排不抖 */
.po-note {
  font-size: @fs-mute;
  color: @text-3;
  padding-left: 6vh;
  padding-right: 6vh;
  margin-top: 1.6vh;
  margin-bottom: 2.4vh;
}
</style>
