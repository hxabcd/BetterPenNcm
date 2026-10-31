<template>
  <div class="cp">
    <!-- 左列：封面 + 三个子面板切换键（设计稿左列 160px、封面 152×152@(4,14)、键 48×48@y176） -->
    <div class="cp-left">
      <div class="cp-coverbox">
        <image v-if="cover" class="cp-cover" :src="cover" resize="cover" />
        <image v-else class="cp-note" :src="ICON.note" />
      </div>
      <div class="cp-switches">
        <!-- 三个切换键在设计稿里是「透明底」变体；这里给当前打开的面板补一层 #242424 底，
             否则用户看不出现在看的是哪一块（图标是白色 PNG，平台不能染色，只能靠键底表达选中） -->
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

    <!-- 右列：标题 / 歌手 / 专辑 / 进度 / 控制（设计稿右列 320px；2026-10-30 设计稿将进度条移到控制键上方）。
         ⚠ 三行文字**不可点**：详情/歌手/专辑只从左栏「歌曲详情」键进（需求：文本不做跳转入口） -->
    <div class="cp-right">
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
      <!-- 进度行：纯展示（**不挂点击**；进度控制在左列时钟键里开合）。
           2026-10-30 设计稿调整：进度条上移到控制键**上方**，并改成**单行** = 已播时间 / 进度条 / 总时长 -->
      <div class="cp-progress">
        <text class="cp-time">{{ elapsedText }}</text>
        <div class="cp-track">
          <div class="cp-fill" :style="fillStyle"></div>
        </div>
        <text class="cp-time">{{ totalText }}</text>
      </div>
      <div class="cp-controls">
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
/**
 * 播放页控制区（设计稿 PlayerPage 14:1570 的 ControlPanel 槽位，480×240；
 * 2026-10-30 按 ControlPanel 13:1335 调整右列比例与进度/控制的先后）
 *
 * 几何（设计稿 px，1vh=2.4px；宽度一律写 px —— 平台把 >100vh 的宽度静默截到 100vh）：
 *   左列 160px：封面 152×152 @ (4,14)、圆角 12px；切换键 48×48 @ y=176，x=4/56/108。
 *   右列 320px：五行按设计稿比例 Title:Artist:ExtraInfo:ProgressBar:Controls = 3:2:2:1.5:5 分配
 *     （合计 13.5 份 = 100vh=240px，每份 17.78px）：
 *     标题行   3 份 = 53.33px（22.222vh） 标题字 28px；
 *     歌手行   2 份 = 35.56px（14.815vh） 图标 24px@x8、文字 20px@x40；
 *     专辑行   同上；
 *     进度行   1.5 份 = 26.67px（11.111vh） **单行**：已播时间 + 进度条（吃剩余宽）+ 总时长，
 *              行左右 padding 8px，条高 4px、圆角 2px、垂直居中；
 *     控制行   5 份 = 88.89px（37.037vh） 键宽高不变（4×48 圆键 + 80×48 胶囊），
 *              **间距自动拉伸**（justify-content: space-between）+ 水平居中，padding 6px，
 *              即整行铺满 320、内容宽 308 → 4 段间距各 9px（按钮尺寸保持设计稿原值，不随宽度拉伸）。
 *   ⚠ 数值与设计稿一一对应，改布局先回 docs/播放页.md 的几何表核对。
 *
 * 颜色/token：键底 TOK.btnBg(#242424)、进度槽 TOK.trackBg(#282828)、文字 TOK.text/text2/text3、
 * 主题色运行时取 accent（内联 style）。设计稿封面是灰底占位 → 无封面时用同一个 #242424 底 + 音符图标。
 *
 * 交互约定（2026-10-30 需求调整）：
 *   - 喜欢键：单击收藏/取消，长按进「添加到歌单」（原生 longpress 触发后不再发 click）；
 *   - 标题/歌手/专辑三行文字**不响应点击**（详情页只从左栏「歌曲详情」键进）；
 *   - 进度行纯展示，**不挂点击**（进度控制面板由左列时钟键开合）；
 *   - 三个切换键：时钟 = 进度控制（TimeShiftPanel）/ 评论 / 歌词；再次点击同一个键由页面关掉面板。
 */
import { TOK } from '../../utils/ui/tokens.js'
import { ICON, aIcon } from '../../assets/icons.js'
import { accentMixin } from '../../utils/theme.js'
import { fmtDur } from '../../utils/format.js'

export default {
  name: 'ControlPanel',
  mixins: [accentMixin],
  props: {
    /** player.state() 快照（player.js 的 snapshot()） */
    st: { type: Object, default: function () { return {} } },
    /** 封面本地路径（utils/cover.js 的 ensureCover 回调，带 file:// 前缀） */
    cover: { type: String, default: '' },
    /** 当前曲目是否已喜欢（页面查缓存/接口） */
    likeOn: { type: Boolean, default: false },
    /** 当前子面板 key：''（空面板）/ lyric / comment / seek；seek 内含定时子页 */
    sub: { type: String, default: '' }
  },
  data() {
    return { ICON: ICON }
  },
  computed: {
    cur() {
      return this.st.cur || {}
    },
    titleText() {
      return this.cur.name || '未在播放'
    },
    artistText() {
      return this.cur.artist || '—'
    },
    /** 第三行：专辑名；没有专辑名时退回别名（有些歌只有 tns/alia） */
    extraText() {
      if (this.cur.album) return this.cur.album
      const a = this.cur.aliases
      return (a && a.length && a[0]) || '—'
    },
    /** 循环模式图标（与 player.js 的 MODES 一一对应） */
    modeIcon() {
      const m = this.st.loopMode
      if (m === 'single') return ICON.loop1
      if (m === 'shuffle') return ICON.shuffle
      if (m === 'list_seq') return ICON.order
      return ICON.loop
    },
    /** 主控键图标：暂停/未在播 = ▶；播放中 = ⏸。走 fgIcon（亮色主题色上换深色版） */
    playIcon() {
      const playing = this.st.isPlaying && !this.st.paused
      return this.fgIcon(playing ? 'pause' : 'play')
    },
    /** 喜欢态红心：主题色的实心版（每个主题色各一张 PNG，平台不能染色） */
    likeIcon() {
      return this.likeOn ? aIcon('liked', this.accent.key) : ICON.like
    },
    /** 播放进度 0~1（无总长时 0） */
    pct() {
      const d = this.st.durationMs
      if (!d) return 0
      const p = this.st.positionMs / d
      return p < 0 ? 0 : p > 1 ? 1 : p
    },
    /** 已播/状态文本：有短状态（缓冲中/受限…）时优先显示状态（与旧播放页一致） */
    elapsedText() {
      return this.st.status ? this.st.status : fmtDur(this.st.positionMs)
    },
    totalText() {
      return fmtDur(this.st.durationMs)
    },
    /** 进度条填充：单行布局下轨道宽是「行宽 − 两个时间 − 两段 8px」的动态值（.cp-track 是 flex:1），
        没法再用固定 px 反推 → 改写成百分比宽度，并量化到 0.1% 减少高频重渲染的抖动 */
    fillStyle() {
      const p = Math.round(this.pct * 1000) / 10
      return {
        width: p + '%',
        backgroundColor: this.accent.c
      }
    }
  },
  methods: {
    /** 子面板切换键的选中态：当前打开的面板反白键底（空面板时三键都透明） */
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
  width: 480px; /* 200vh：>100vh 的宽度必须写 px，否则被平台截到 240px */
  height: 100vh;
  flex: none;
  flex-direction: row;
}
/* ---- 左列 160px ---- */
.cp-left {
  width: 160px;
  height: 100vh;
  flex: none;
  flex-direction: column;
  align-items: flex-start;
}
/* 封面 152×152：设计稿 Cover 框 160×160 @y10，圆角矩形内缩 4px */
.cp-coverbox {
  width: 63.33vh; /* 152px */
  height: 63.33vh;
  flex: none;
  margin-top: 5.83vh; /* 14px（框 y10 + 内缩 4） */
  margin-left: 1.67vh; /* 4px */
  border-radius: 5vh; /* 12px */
  background-color: @btn-bg;
  overflow: hidden;
  align-items: center;
  justify-content: center;
}
.cp-cover {
  width: 63.33vh;
  height: 63.33vh;
}
/* 无封面占位音符（同首页卡片做法） */
.cp-note {
  width: 26vh;
  height: 26vh;
}
/* 切换键行：设计稿 Controls 框 y170、键 y176（封面下 10px） */
.cp-switches {
  flex: none;
  flex-direction: row;
  height: 20vh;
  margin-top: 4.17vh; /* 10px：封面底 166 → 键顶 176 */
  margin-left: 1.67vh; /* 4px */
}
.cp-sw {
  width: 20vh; /* 48px */
  height: 20vh;
  border-radius: 5vh; /* 12px */
  align-items: center;
  justify-content: center;
  margin-right: 1.67vh; /* 键间距 4px */
}
.cp-sw-ico {
  width: 10vh; /* 24px */
  height: 10vh;
}
.cp-sw-t {
  font-size: 8.33vh; /* 20px：第三个键是「词」字（设计稿就是文字） */
  color: @text;
}
/* ---- 右列 320px ---- */
.cp-right {
  width: 320px;
  height: 100vh;
  flex: none;
  flex-direction: column;
}
/* 五行按设计稿 3:2:2:1.5:5 分配 100vh（每份 17.78px）：
   标题 53.33px（22.222vh）/ 歌手 35.56px（14.815vh）/ 专辑 35.56px /
   进度 26.67px（11.111vh）/ 控制 88.89px（37.037vh）。文字左缩进按 320 宽计。 */
.cp-head {
  height: 22.222vh;
  flex: none;
  flex-direction: row;
  align-items: center;
  padding-left: 1.67vh;
  overflow: hidden;
}
.cp-title {
  font-size: 11.67vh; /* 28px */
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
/* 歌手/专辑行：图标 24px@x8、文字 20px@x40（行高 35.56px = 14.815vh） */
.cp-row {
  height: 14.815vh;
  flex: none;
  flex-direction: row;
  align-items: center;
  padding-left: 3.33vh; /* 8px */
  overflow: hidden;
}
.cp-rowico {
  width: 10vh; /* 24px */
  height: 10vh;
  margin-right: 3.33vh; /* 图标右缘 32 → 文字 40，间距 8px */
}
.cp-rowtxt {
  font-size: 8.33vh; /* 20px */
  color: @text-2;
  lines: 1;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
/* 控制行 88.89px（37.037vh）：整行铺满 320px 宽（显式 width，不依赖父列 column flex 的隐式 stretch；
   平台按 border-box 算，320 已含左右 padding），上下左右 padding 6px（2.5vh），
   键在行内垂直居中；水平方向**间距自动拉伸**（space-between）——按钮尺寸保持设计稿原值不变，
   内容宽 320-12=308，减去 4×48+80=272 后剩下 36px 均分为 4 段间距（各 9px）。
   ⚠ 不要写 margin：间距来自 space-between，两者叠加会把整组挤歪。 */
.cp-controls {
  width: 320px;
  height: 37.037vh;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 2.5vh; /* 6px */
}
.cp-key {
  width: 20vh; /* 48px 圆形键（圆角 = 半径 24px=10vh） */
  height: 20vh;
  border-radius: 10vh;
  background-color: @btn-bg;
  align-items: center;
  justify-content: center;
}
/* 末键独立类名（平台不支持 :last-child；间距由 space-between 给，无需末尾特判） */
.cp-keylast {
  width: 20vh;
  height: 20vh;
  border-radius: 10vh;
  background-color: @btn-bg;
  align-items: center;
  justify-content: center;
}
/* 主控键 80×48 胶囊（底色运行时主题色，模板内联） */
.cp-play {
  width: 33.33vh; /* 80px */
  height: 20vh;
  border-radius: 10vh;
  background-color: @accent;
  align-items: center;
  justify-content: center;
}
.cp-keyico {
  width: 10vh; /* 24px */
  height: 10vh;
}
.cp-playico {
  width: 10vh;
  height: 10vh;
}
/* 进度行 26.67px（11.111vh）：**单行** = 已播时间 + 进度条（剩余宽）+ 总时长，垂直居中。
   设计稿给的 padding 8px 落在行的左右（上下 8 会装不下 14px 文字，行高按比例已经固定 26.67）；
   条高 4px、圆角 2px（槽与填充都圆角，overflow:hidden 兜住右端）。 */
.cp-progress {
  width: 320px; /* 显式宽度：不依赖父列隐式 stretch，条用 flex:1 才有确定的可分配宽 */
  height: 11.111vh;
  flex: none;
  flex-direction: row;
  align-items: center;
  padding-left: 3.33vh; /* 8px */
  padding-right: 3.33vh;
}
.cp-time {
  font-size: 5.83vh; /* 14px */
  line-height: 7.08vh; /* 17px */
  color: @text-3;
  lines: 1;
}
/* 进度条吃掉中间的剩余宽度；左右各 8px 与时间分开 */
.cp-track {
  flex: 1;
  height: 1.67vh; /* 4px */
  margin-left: 3.33vh; /* 8px */
  margin-right: 3.33vh;
  border-radius: 0.83vh; /* 2px */
  background-color: @track-bg;
  overflow: hidden;
}
.cp-fill {
  height: 1.67vh; /* 4px */
  border-radius: 0.83vh;
  background-color: @accent;
}
</style>
