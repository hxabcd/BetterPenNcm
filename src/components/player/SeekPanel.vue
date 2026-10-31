<template>
  <div class="skp">
    <!-- 顶栏：左「进度控制」点击 = 返回上一个子面板（emit close）；右「定时播放」= emit timer。
         两个点击区各自挂 handler（平台没有 stopPropagation，互斥区不能挂在共同父节点上） -->
    <div class="skp-bar">
      <div class="skp-head" @click="onClose">
        <text class="skp-title">进度控制</text>
      </div>
      <div class="skp-gap"></div>
      <div class="skp-timer" @click="onTimer">
        <image class="skp-timer-ico" :src="ICON.timer" />
        <text class="skp-timer-t">定时播放</text>
      </div>
    </div>

    <!-- 内容区：padding 12；时间行 64 + 间距 10 + 进度条行 28 + 间距 10 + 4 键行 56 = 168 -->
    <div class="skp-body">
      <!-- 时间行：拖动中显示拖动位置，否则显示真实进度 -->
      <div class="skp-time">
        <text class="skp-time-num">{{ posText }}</text>
        <text class="skp-time-slash">/</text>
        <text class="skp-time-num">{{ durText }}</text>
      </div>

      <!-- 进度条行：外框 456×28（上下 padding 4）→ 可拖线 456×20。
           触摸事件挂在可拖线上：按下只记起点、不跳；移动按两点 x 差算比例（见 onDown / onMove） -->
      <div class="skp-prog">
        <div
          class="skp-line"
          @touchstart="onDown"
          @touchmove="onMove"
          @touchend="onUp"
          @touchcancel="onUp"
        >
          <div class="skp-groove"></div>
          <div class="skp-fill" :style="fillStyle"></div>
          <div class="skp-knob" :style="knobStyle"></div>
        </div>
      </div>

      <!-- ±秒键：拖动之外的另一条定位通道。夹紧 0..duration 由本组件做；无时长（duration 为 0）不发 -->
      <div class="skp-keys">
        <div class="skp-key" @click="jump(-30000)">
          <text class="skp-key-t">-30s</text>
        </div>
        <div class="skp-key" @click="jump(-5000)">
          <text class="skp-key-t">-5s</text>
        </div>
        <div class="skp-key" @click="jump(5000)">
          <text class="skp-key-t">+5s</text>
        </div>
        <div class="skp-keylast" @click="jump(30000)">
          <text class="skp-key-t">+30s</text>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
/**
 * 播放页「进度控制」子面板（设计稿 TimeShiftPanel 14:1755，480×240）
 *
 * 布局（设计稿 px 与设备 px 1:1；宽度超 100vh 的值一律写 px —— 平台会把 vh 宽度静默截到 100vh）：
 *   顶栏 48px、底边 1px 分割线：左「进度控制」24px 粗体白（点击 = 回到上一个子面板，emit close）；
 *   右「定时播放」（timer 图标 24px + 20px 白字，padding 6px、右 12px，emit timer）。
 *   内容区 padding 12：时间行 64 + 间距 10 + 进度条行 28 + 间距 10 + 4 键行 56 = 168，
 *   加上下 padding 24 正好 192（= 240 − 48），与设计稿 Container 一致。
 *
 * 为什么拖动只认「两点 x 之差」：触摸坐标字段因固件而异（见 utils/touch.js 头注释的实测：
 *   本固件的 pageX 是「相对触发节点」的坐标，screenX 才是屏幕绝对的）。本组件**不做点哪跳哪**：
 *   按下只记起点、不跳，移动时按 (x − 起点x) / 456 折算比例 —— 只要按下与移动取到的是同一个
 *   字段，坐标原点在哪都相互抵消，不需要知道进度条在屏幕上的绝对起点。
 *
 * 组件自己不上底色/圆角：480×240 的深底与左侧圆角由播放页的子面板容器给。
 * 静态色走 common.less 的生成令牌段（@line / @card-bg / @track-bg / @text / @text-2，
 * 源头是 utils/ui/tokens.js）；主题色运行时可换，只能内联（平台样式只认单类名选择器）。
 *
 * 页面可能挂两遍：本面板没有 mounted 副作用（不订阅播放器、不拉数据，st 全部由父级传入），
 * 重复挂载天然幂等。
 */
import { touchAxis } from '../../utils/touch.js'
import { fmtDur } from '../../utils/format.js'
import { accentMixin } from '../../utils/theme.js'
import { ICON } from '../../assets/icons.js'

/* 可拖线宽（px）：与样式 .skp-line 的 width:456px 成对维护。填充宽与手柄位置都用它做 px 反推
   （百分比宽度在这个渲染器上没把握，见 CONTRACT §4.6）。 */
const TRACK_W = 456

/* 拖动看门狗（ms）：部分固件可能不发 touchend（LyricPanel.vue 踩过同一坑，那里也是 60s 兜底）。
   拖动状态不复位的话，进度显示会冻在拖到的位置、不再跟歌走 —— 超时按一次「松手」收尾。
   60s 足够长，正常操作（哪怕按住仔细对位置）绝不会被它打断。 */
const WATCHDOG_MS = 60000

export default {
  name: 'SeekPanel',
  mixins: [accentMixin], // accent.c = 当前主题色（已播部分 / 手柄不用它，手柄是白圆）
  props: {
    /** player.state() 快照（positionMs / durationMs / cur / status 等） */
    st: { type: Object, default: function () { return {} } }
  },
  data() {
    return {
      ICON: ICON,
      /* 拖动比例 0~1；-1 = 未在拖动（不能拿 0 当哨兵 —— 0 是合法播放位置） */
      dragPct: -1
    }
  },
  computed: {
    /** 总时长 ms（0 = 无曲目 / 时长未知） */
    durMs() {
      const d = Number(this.st.durationMs) || 0
      return d > 0 ? d : 0
    },
    /** 真实播放进度 0~1（无时长按 0） */
    pct() {
      const d = this.durMs
      if (!d) return 0
      const p = (Number(this.st.positionMs) || 0) / d
      return p < 0 ? 0 : p > 1 ? 1 : p
    },
    /** 显示用进度：拖动中显示拖动位置，否则跟播放器 */
    shownPct() {
      return this.dragPct >= 0 ? this.dragPct : this.pct
    },
    /** 已播时间：拖动中显示拖动位置 */
    posText() {
      const d = this.durMs
      if (!d) return fmtDur(0)
      return fmtDur(this.dragPct >= 0 ? this.dragPct * d : this.st.positionMs)
    },
    durText() {
      return fmtDur(this.durMs)
    },
    /** 已播部分：宽度 px 反推（百分比宽度不可靠），底色走主题色 */
    fillStyle() {
      return {
        width: Math.round(TRACK_W * this.shownPct) + 'px',
        backgroundColor: this.accent.c
      }
    },
    /** 手柄位置：left 用 px；左右各探出半个手柄，靠样式里的负 margin 居中（已实测可用） */
    knobStyle() {
      return { left: Math.round(TRACK_W * this.shownPct) + 'px' }
    }
  },
  methods: {
    /* ---- 顶栏 ---- */
    onClose() {
      this.$emit('close')
    },
    onTimer() {
      this.$emit('timer')
    },
    /* ---- ±秒键 ---- */
    /**
     * 相对当前位置跳 deltaMs。
     * 夹紧到 0..duration（把「超出范围的意图」落成终点，而不是拒发）；
     * duration 为 0 = 没有可定位的曲目，直接不发（避免把无效 seek 丢给页面）。
     */
    jump(deltaMs) {
      const d = this.durMs
      if (!d) return
      let pos = (Number(this.st.positionMs) || 0) + deltaMs
      if (pos < 0) pos = 0
      if (pos > d) pos = d
      this.$emit('seek', pos)
    },
    /* ---- 拖动：只认两点 x 差，不依赖坐标系绝对性 ---- */
    onDown(e) {
      const x = touchAxis(e, 'x')
      if (!isFinite(x)) return // 取不到坐标就当没按（别让进度条莫名跳走）
      if (!this.durMs) return // 没有可定位的曲目：拖了也没意义
      this._sx = x
      this._sp = this.pct // 从当前进度起拖：按下时不跳
      this.dragPct = this.pct
      // 看门狗：万一这轮收不到 touchend，60s 后按「松手」收尾（见 WATCHDOG_MS 注释）
      this.clearWatchdog()
      const self = this
      this._wd = setTimeout(function () {
        self.onUp()
      }, WATCHDOG_MS)
    },
    onMove(e) {
      if (this.dragPct < 0) return
      const x = touchAxis(e, 'x')
      if (!isFinite(x)) return
      let p = this._sp + (x - this._sx) / TRACK_W
      if (p < 0) p = 0
      if (p > 1) p = 1
      this.dragPct = p
    },
    onUp() {
      this.clearWatchdog()
      if (this.dragPct < 0) return
      const p = this.dragPct
      this.dragPct = -1 // 先复位：一次拖动只发一次 seek
      const d = this.durMs
      if (!d) return // 拖的过程中时长丢了（换曲 / 停播）→ 不发明知无效的跳转
      this.$emit('seek', Math.round(p * d)) // 页面负责再夹紧 0..duration
    },
    clearWatchdog() {
      if (this._wd) {
        clearTimeout(this._wd)
        this._wd = null
      }
    }
  },
  beforeDestroy() {
    // 组件随子面板 v-if 卸载：别让看门狗在已销毁的实例上继续跑
    this.clearWatchdog()
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 根节点铺满 480×240 子面板；底色与左侧圆角由父级容器给，这里不上底 */
.skp {
  width: 100%;
  height: 100%;
  flex-direction: column;
}

/* ---- 顶栏 h48：底边 1px 分割线；左标题可点、右定时播放入口 ---- */
.skp-bar {
  width: 100%;
  height: 48px;
  flex: none;
  flex-direction: row;
  align-items: center;
  padding-left: 12px;
  padding-right: 12px;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
/* 标题包裹层：只负责水平排 + 垂直居中（点击区 = 文字自身，够点） */
.skp-head {
  flex: none;
  flex-direction: row;
  align-items: center;
}
.skp-title {
  font-size: 24px;
  font-weight: bold;
  color: @text;
}
/* 撑开：把「定时播放」推到右端（比 space-between 更保险，同 PageTopbar 的 fill 做法） */
.skp-gap {
  flex: 1;
}
.skp-timer {
  flex: none;
  flex-direction: row;
  align-items: center;
  padding: 6px;
}
.skp-timer-ico {
  width: 24px;
  height: 24px;
}
.skp-timer-t {
  font-size: 20px;
  color: @text;
  margin-left: 4px;
}

/* ---- 内容区 456×168（480 − 左右 12，192 − 上下 12） ---- */
.skp-body {
  width: 100%;
  flex: 1;
  flex-direction: column;
  padding: 12px;
}
/* 时间行 h64：40px 粗体白 / 40px 灰斜杠 / 40px 粗体白，水平居中，间距 8px（斜杠两侧各 8） */
.skp-time {
  width: 456px;
  height: 64px;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}
.skp-time-num {
  font-size: 40px;
  font-weight: bold;
  color: @text;
}
.skp-time-slash {
  font-size: 40px;
  color: @text-2;
  margin-left: 8px;
  margin-right: 8px;
}
/* 进度条行 h28：上下 padding 4 → 可拖线 456×20 */
.skp-prog {
  width: 456px;
  height: 28px;
  flex: none;
  flex-direction: column;
  padding-top: 4px;
  padding-bottom: 4px;
  margin-top: 10px;
}
/* 可拖线：456px 与 JS 的 TRACK_W 成对维护；20px 高 = 手柄直径 */
.skp-line {
  width: 456px;
  height: 20px;
  flex: none;
  position: relative;
}
/* 进度槽：8px 高、圆角 4px，在 20px 高的线里垂直居中（top 6 = (20 − 8) / 2） */
.skp-groove {
  position: absolute;
  left: 0;
  right: 0;
  top: 6px;
  height: 8px;
  border-radius: 4px;
  background-color: @track-bg;
}
/* 已播部分：宽度由 fillStyle 给 px；底色书面值 @accent，运行时内联覆盖成主题色 */
.skp-fill {
  position: absolute;
  left: 0;
  top: 6px;
  height: 8px;
  border-radius: 4px;
  background-color: @accent;
}
/* 手柄 20px 白圆：压线居中靠负 margin（负的绝对偏移会被当成 0，负 margin 已实测可用） */
.skp-knob {
  position: absolute;
  top: 0;
  width: 20px;
  height: 20px;
  margin-left: -10px;
  border-radius: 10px;
  background-color: @text;
}
/* 4 键行 h56：按钮 106.5×56、间距 10px（用 margin 不用 gap —— 本渲染器对 flex gap 无把握） */
.skp-keys {
  width: 456px;
  height: 56px;
  flex: none;
  flex-direction: row;
  margin-top: 10px;
}
.skp-key {
  width: 106.5px;
  height: 56px;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background-color: @card-bg;
  margin-right: 10px;
}
/* 末键独立类名：末尾不留 margin（平台不支持 :last-child），否则整组偏移 */
.skp-keylast {
  width: 106.5px;
  height: 56px;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background-color: @card-bg;
}
.skp-key-t {
  font-size: 24px;
  color: @text;
}
</style>
