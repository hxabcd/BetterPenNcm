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

      <!-- 逐字歌词：服务端有 YRC 时活动行按字点亮/扫亮，无 YRC 自动回退逐行；
           关闭 = 活动行保持单文本节点，不建逐字动画 -->
      <div class="po-row">
        <text class="po-label">逐字歌词</text>
        <opt-toggle :on="lyricWord" @change="setWord" />
      </div>
      <text class="po-note" v-if="!lyricWord">无逐字数据时自动回退逐行</text>

      <!-- 歌词动画：滚动 / 字号高亮 / 逐字扫亮的过渡总开关；
           关闭 = 定位与逐字进度照常更新，但全部瞬时完成 -->
      <div class="po-row">
        <text class="po-label">歌词动画</text>
        <opt-toggle :on="lyricAnim" @change="setAnim" />
      </div>
      <text class="po-note" v-if="!lyricAnim">滚动与高亮瞬时完成</text>

      <div class="po-row">
        <text class="po-label">歌词渲染</text>
        <div class="po-chips">

          <opt-chip text="整首" :on="lyricFull" @pick="setFull(true)" />
          <opt-chip text="省性能" :on="!lyricFull" @pick="setFull(false)" />
        </div>
        <text class="po-note" v-if="!lyricFull">只跟随当前行，无法拖动</text>
      </div>

      <!-- 自动跟歌：活动行更新时平滑滚动到该行；关掉 = 只换高亮、轨道不动（手动翻看时不会被拽走）。
           手动翻看时高亮始终跟着播放进度，这条不受本开关影响 -->
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

      <!-- 两个音质档位在「音质与存储」（pages/setdl），不在这里：音质/缓存/存储放一组，本页只留「怎么放」的开关 -->

      <!-- 退出时暂停音乐：退出后音乐继续放（系统播放服务是独立进程） -->
      <div class="po-row">
        <text class="po-xlabel">退出时暂停音乐</text>
        <opt-toggle :on="pauseOnExit" @change="setPauseExit" />
      </div>
    </scroller>
  </page-shell>
</template>

<script>

import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import OptChip from '../../components/OptChip.vue'
import OptToggle from '../../components/OptToggle.vue'
import { player, RATES } from '../../services/player/player.js'
import config from '../../core/infra/config.js'
import { log } from '../../core/infra/log.js'

import { pageFrameMixin } from '../../ui/mixins/frame.js'

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

    async setWord(on) {
      this.lyricWord = on
      await config.set('lyricWord', on)
      this.hint = on ? '逐字歌词已打开' : '逐字歌词已关闭'
      log('playeropts', '逐字歌词 -> ' + on)
      this.notify()
    },

    async setAnim(on) {
      this.lyricAnim = on
      await config.set('lyricAnim', on)
      this.hint = on ? '歌词动画已打开' : '歌词动画已关闭'
      log('playeropts', '歌词动画 -> ' + on)
      this.notify()
    },

    async setFull(on) {
      this.lyricFull = on
      await config.set('lyricFull', on)
      this.hint = on ? '歌词整首渲染' : '歌词省性能渲染'
      log('playeropts', '歌词渲染 -> ' + (on ? '整首' : '省性能'))
      this.notify()
    },

    async setFollow(on) {
      this.lyricFollow = on
      await config.set('lyricFollow', on)
      this.hint = on ? '自动跟歌已打开' : '只更新高亮'
      log('playeropts', '自动跟歌 -> ' + on)
      this.notify()
    },

    async setDbl(on) {
      this.lyricDbl = on
      await config.set('lyricDbl', on)
      this.hint = on ? '双击跳转已打开' : '双击跳转已关闭'
      log('playeropts', '双击跳转 -> ' + on)
      this.notify()
    },

    // 退出时暂停音乐：即改即存；播放器在退出那一刻才读 config，无需广播
    async setPauseExit(on) {
      if (on === this.pauseOnExit) return
      this.pauseOnExit = on
      await config.set('pauseOnExit', on)
      this.hint = on ? '退出时暂停音乐' : '退出后继续播放'
      log('playeropts', '退出时暂停音乐 -> ' + on)
    },

    // 通知播放页刷新开关（跨页面事件总线，index.vue 已有同款先例）
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
   （见 settings 页的 .st-list）。上下 padding 兼作「滚到底时最后一行的留白」 */
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

.po-note {
  font-size: @fs-mute;
  color: @text-3;
  padding-left: 6vh;
  padding-right: 6vh;
  margin-top: 1.6vh;
  margin-bottom: 2.4vh;
}
</style>
