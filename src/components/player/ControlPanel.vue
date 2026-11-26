<template>
  <div class="cp" :style="{ width: wMain }">

    <div class="cp-left" :style="{ width: wLeft }">
      <div class="cp-coverbox">
        <image v-if="cover" class="cp-cover" :src="cover" resize="cover" />
        <image v-else class="cp-note" :src="ICON.note" />
      </div>
      <div class="cp-switches">

        <!-- 图标是白色 PNG、平台不能染色 → 选中只能靠键底表达：给当前打开的面板补一层 TOK.btnBg -->
        <div class="cp-sw" :style="subStyle('seek')" @click="onSub('seek')">
          <image class="cp-sw-ico" :src="ICON.clockfade" />
        </div>
        <div class="cp-sw" :style="subStyle('comment')" @click="onSub('comment')">
          <image class="cp-sw-ico" :src="ICON.messagesq" />
        </div>
        <div class="cp-sw" :style="subStyle('lyric')" @click="onSub('lyric')">
          <text class="cp-sw-t">词</text>
        </div>
      </div>
    </div>

    <div class="cp-right" :style="{ width: wRight }">
      <div class="cp-head">
        <text class="cp-title">{{ titleText }}</text>
      </div>
      <div class="cp-row">
        <image class="cp-rowico" :src="ICON.micvocal" />
        <text class="cp-rowtxt">{{ artistText }}</text>
      </div>
      <div class="cp-row">
        <image class="cp-rowico" :src="ICON.disc3" />
        <text class="cp-rowtxt">{{ extraText }}</text>
      </div>

      <!-- 进度行与三行文字都纯展示、不挂点击：详情只从左栏「歌曲详情」键进，进度面板由左列时钟键开合 -->
      <div class="cp-progress" :style="{ width: wRight }">
        <text class="cp-time">{{ elapsedText }}</text>
        <div class="cp-track">
          <div class="cp-fill" :style="fillStyle"></div>
        </div>
        <text class="cp-time">{{ totalText }}</text>
      </div>
      <div class="cp-controls" :style="controlsStyle">
        <div class="cp-key" @click="onLoop">
          <image class="cp-keyico" :src="modeIcon" />
        </div>
        <div class="cp-key" @click="onPrev">
          <image class="cp-keyico" :src="ICON.prev" />
        </div>

        <!-- 主控键：实心主题色底 80×48 胶囊；图标走 fgIcon（亮色主题色自动换深色版 PNG） -->
        <div class="cp-play" :style="{ backgroundColor: accent.c }" @click="onToggle">
          <image class="cp-playico" :src="playIcon" />
        </div>
        <div class="cp-key" @click="onNext">
          <image class="cp-keyico" :src="ICON.next" />
        </div>

        <!-- 喜欢键：单击收藏/取消，长按打开歌单选择页（原生 longpress 与 click 天然互斥） -->
        <div class="cp-keylast" @click="onLike" @longpress="onPick">
          <image class="cp-keyico" :src="likeIcon" />
        </div>
      </div>
    </div>
  </div>
</template>

<script>

// 宽度一律写 px：平台会把 >100vh 的宽度静默截到 100vh
// 平台只认单类名选择器 → 机型分支（X3S/X5 视口 800×254）只能靠内联 :style 覆盖 class 值

import { TOK } from '../../ui/tokens.js'
import { ICON, aIcon } from '../../assets/icons.js'
import { accentMixin } from '../../ui/mixins/accent.js'
import { fmtDur } from '../../core/infra/format.js'
import { isNarrow } from '../../services/player/layout.js'

export default {
  name: 'ControlPanel',
  mixins: [accentMixin],
  props: {

    // player.state() 快照（player.js 的 snapshot()）
    st: { type: Object, default: function () { return {} } },

    // 封面本地路径（services/cover/cover.js 的 ensureCover 回调，带 file:// 前缀）
    cover: { type: String, default: '' },

    likeOn: { type: Boolean, default: false },

    // 当前子面板 key：''（空面板）/ lyric / comment / seek；seek 内含定时子页
    sub: { type: String, default: '' }
  },
  data() {

    return { ICON: ICON, narrow: isNarrow() }
  },
  computed: {
    cur() {
      return this.st.cur || {}
    },

    wMain() {
      return this.narrow ? '736px' : '480px'
    },

    // 左列要装下 63.33vh 的封面（X3S 1vh=2.54px 时约 161px）
    wLeft() {
      return this.narrow ? '172px' : '160px'
    },

    // 窄屏不跟着 736 铺开：铺到 564 会把标题行、进度条、控制键拉得很散（真机反馈「空间要聚集在中间」），
    // 封顶 400px，由 .cp 的 justify-content:center 整组居中
    wRight() {
      return this.narrow ? '400px' : '320px'
    },

    // 五个键是一组紧凑控件，恒按设计稿 320px 排（不跟右列拉宽）：320 − 12 padding − 272 键宽 → 4 段 9px 间距
    controlsStyle() {
      return { width: '320px', alignSelf: 'center' }
    },
    titleText() {
      return this.cur.name || '未在播放'
    },
    artistText() {
      return this.cur.artist || '—'
    },

    // 第三行：专辑名；没有专辑名时退回别名（接口侧有些歌只有 tns/alia）
    extraText() {
      if (this.cur.album) return this.cur.album
      const a = this.cur.aliases
      return (a && a.length && a[0]) || '—'
    },

    // 循环模式图标（与 player.js 的 MODES 一一对应）
    modeIcon() {
      const m = this.st.loopMode
      if (m === 'single') return ICON.loop1
      if (m === 'shuffle') return ICON.shuffle
      if (m === 'list_seq') return ICON.order
      return ICON.loop
    },

    // 主控键图标：暂停/未在播 = ▶，播放中 = ⏸；走 fgIcon（亮色主题色上换深色版 PNG，平台不能染色）
    playIcon() {
      const playing = this.st.isPlaying && !this.st.paused
      return this.fgIcon(playing ? 'pause' : 'play')
    },

    likeIcon() {
      return this.likeOn ? aIcon('liked', this.accent.key) : ICON.like
    },

    pct() {
      const d = this.st.durationMs
      if (!d) return 0
      const p = this.st.positionMs / d
      return p < 0 ? 0 : p > 1 ? 1 : p
    },

    // 已播/状态文本：有短状态（缓冲中/受限…）时优先显示状态
    elapsedText() {
      return this.st.status ? this.st.status : fmtDur(this.st.positionMs)
    },
    totalText() {
      return fmtDur(this.st.durationMs)
    },

    // 进度条填充：单行布局下 .cp-track 是 flex:1（宽是动态值），没法用固定 px 反推 → 写百分比，
    // 并量化到 0.1% 减少高频重渲染的抖动
    fillStyle() {
      const p = Math.round(this.pct * 1000) / 10
      return {
        width: p + '%',
        backgroundColor: this.accent.c
      }
    }
  },
  methods: {

    subStyle(key) {
      const on = this.sub === key
      return { backgroundColor: on ? TOK.btnBg : TOK.none, borderWidth: '0px', borderStyle: 'solid', borderColor: 'transparent' }
    },
    onSub(key) {
      this.$emit('sub', key)
    },
    onToggle() {
      this.$emit('toggle')
    },
    onPrev() {
      this.$emit('prev')
    },
    onNext() {
      this.$emit('next')
    },
    onLoop() {
      this.$emit('loop')
    },
    onLike() {
      this.$emit('like')
    },
    onPick() {
      this.$emit('pick')
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.cp {
  width: 480px; 
  height: 100vh;
  flex: none;
  flex-direction: row;

  justify-content: center;
}

.cp-left {
  width: 160px;
  height: 100vh;
  flex: none;
  flex-direction: column;
  align-items: flex-start;
}

.cp-coverbox {
  width: 63.33vh; 
  height: 63.33vh;
  flex: none;
  margin-top: 5.83vh; 
  margin-left: 1.67vh; 
  border-radius: 5vh; 
  background-color: @btn-bg;
  overflow: hidden;
  align-items: center;
  justify-content: center;
}
.cp-cover {
  width: 63.33vh;
  height: 63.33vh;
}

.cp-note {
  width: 26vh;
  height: 26vh;
}

.cp-switches {
  flex: none;
  flex-direction: row;
  height: 20vh;
  margin-top: 4.17vh; 
  margin-left: 1.67vh; 
}
.cp-sw {
  width: 20vh; 
  height: 20vh;
  border-radius: 5vh; 
  align-items: center;
  justify-content: center;
  margin-right: 1.67vh; 
}
.cp-sw-ico {
  width: 10vh; 
  height: 10vh;
}
.cp-sw-t {
  font-size: 8.33vh; 
  color: @text;
}

.cp-right {
  width: 320px;
  height: 100vh;
  flex: none;
  flex-direction: column;
}

.cp-head {
  height: 22.222vh;
  flex: none;
  flex-direction: row;
  align-items: center;
  padding-left: 1.67vh;
  overflow: hidden;
}
.cp-title {
  font-size: 11.67vh; 
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.cp-row {
  height: 14.815vh;
  flex: none;
  flex-direction: row;
  align-items: center;
  padding-left: 3.33vh; 
  overflow: hidden;
}
.cp-rowico {
  width: 10vh; 
  height: 10vh;
  margin-right: 3.33vh; 
}
.cp-rowtxt {
  font-size: 8.33vh; 
  color: @text-2;
  lines: 1;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

/* 控制行整行铺满 320px（显式 width，不依赖父列 column flex 的隐式 stretch；平台按 border-box 算，已含 padding）；
   间距来自 space-between，不要再写 margin —— 两者叠加会把整组挤歪 */
.cp-controls {
  width: 320px;
  height: 37.037vh;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 2.5vh; 
}
.cp-key {
  width: 20vh; 
  height: 20vh;
  border-radius: 10vh;
  background-color: @btn-bg;
  align-items: center;
  justify-content: center;
}

/* 末键独立类名（平台不支持 :last-child） */
.cp-keylast {
  width: 20vh;
  height: 20vh;
  border-radius: 10vh;
  background-color: @btn-bg;
  align-items: center;
  justify-content: center;
}

.cp-play {
  width: 33.33vh; 
  height: 20vh;
  border-radius: 10vh;
  background-color: @accent;
  align-items: center;
  justify-content: center;
}
.cp-keyico {
  width: 10vh; 
  height: 10vh;
}
.cp-playico {
  width: 10vh;
  height: 10vh;
}

.cp-progress {
  width: 320px; 
  height: 11.111vh;
  flex: none;
  flex-direction: row;
  align-items: center;
  padding-left: 3.33vh; 
  padding-right: 3.33vh;
}
.cp-time {
  font-size: 5.83vh; 
  line-height: 7.08vh; 
  color: @text-3;
  lines: 1;
}

.cp-track {
  flex: 1;
  height: 1.67vh; 
  margin-left: 3.33vh; 
  margin-right: 3.33vh;
  border-radius: 0.83vh; 
  background-color: @track-bg;
  overflow: hidden;
}
.cp-fill {
  height: 1.67vh; 
  border-radius: 0.83vh;
  background-color: @accent;
}
</style>
