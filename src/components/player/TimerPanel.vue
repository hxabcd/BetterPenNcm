<template>
  <div class="tm">
    <!-- 顶栏 h48（底边 1px 分割线，左右 12px）：左「返回」；右侧「播完整首」复选框 -->
    <div class="tm-top">
      <div class="tm-back" @click="onBack">
        <image class="tm-back-ico" :src="ICON.arrowleft" />
        <text class="tm-back-t">返回</text>
      </div>
      <!-- 设计稿：选时长态顶栏只有返回键；倒计时态/自定义态才有「播完整首」 -->
      <div class="tm-keep" v-if="pane !== 'presets'" @click="onKeep">
        <div class="tm-chk" :style="chkStyle">
          <image v-if="keepTrack" class="tm-chk-ico" :src="checkIcon" />
        </div>
        <text class="tm-keep-t">播完整首</text>
      </div>
    </div>

    <!-- 一、选时长：3 列 × 2 行，按钮 144×78，列/行距 12px（用 margin，平台不认 gap） -->
    <div class="tm-body" v-if="pane === 'presets'">
      <div class="tm-presets">
        <div class="tm-prow">
          <div class="tm-pbtn" @click="pickMin(10)"><text class="tm-pbtn-t">10min</text></div>
          <div class="tm-pbtn" @click="pickMin(20)"><text class="tm-pbtn-t">20min</text></div>
          <div class="tm-pbtn-end" @click="pickMin(30)"><text class="tm-pbtn-t">30min</text></div>
        </div>
        <div class="tm-prow2">
          <div class="tm-pbtn" @click="pickMin(60)"><text class="tm-pbtn-t">1h</text></div>
          <div class="tm-pbtn" @click="pickMin(120)"><text class="tm-pbtn-t">2h</text></div>
          <div class="tm-pbtn-end" @click="openCustom"><text class="tm-pbtn-t">自定义</text></div>
        </div>
      </div>
    </div>

    <!-- 二、倒计时：H:MM:SS 每秒刷新 + 播放至 HH:MM + 取消键 96×36 -->
    <div class="tm-body" v-else-if="pane === 'running'">
      <div class="tm-timer">
        <div class="tm-status">
          <text class="tm-count">{{ countText }}</text>
          <text class="tm-until">播放至 {{ until }}</text>
        </div>
        <div class="tm-ctl">
          <div class="tm-stop" @click="onCancel">
            <image class="tm-stop-ico" :src="ICON.stop" />
          </div>
        </div>
      </div>
    </div>

    <!-- 三、自定义分钟数：左状态 201×168（大数字 + min + 播放至）｜右键盘 245×168 -->
    <div class="tm-body" v-else>
      <div class="tm-custom">
        <div class="tm-cstatus">
          <div class="tm-ctime">
            <text class="tm-cnum">{{ inputText }}</text>
            <text class="tm-cmin">min</text>
          </div>
          <text class="tm-cuntil">播放至 {{ customUntil }}</text>
        </div>
        <div class="tm-kb">
          <div class="tm-krow" v-for="(row, ri) in keyRows" :key="ri">
            <div class="tm-key" v-for="(k, ki) in row" :key="ki" :style="keyStyle(ki)" @click="onDigit(k)">
              <text class="tm-keyt">{{ k }}</text>
            </div>
          </div>
          <div class="tm-krow-end">
            <div class="tm-key" :style="keyStyle(0)" @click="onDel">
              <image class="tm-keyico" :src="ICON.del" />
            </div>
            <div class="tm-key" :style="keyStyle(1)" @click="onDigit('0')">
              <text class="tm-keyt">0</text>
            </div>
            <div class="tm-key" :style="keyStyle(2)" @click="onConfirm">
              <image class="tm-keyico" :src="ICON.check" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
/**
 * 定时播放子页（设计稿 PlayerPage 14:1570 的 SetTimerPanel 14:1756 / TimerPanel 14:1758 /
 * SetCustomTimerPanel 14:1757，三态合一个组件）
 *
 * 它是「进度控制」（TimeShiftPanel / SeekPanel）内部的子页：由进度控制右上「定时播放」进入，
 * 顶栏「返回」在自定义键盘里回选时长、在选时长/倒计时里抛 `back` 回进度控制面板。
 * 打开/关闭整个子面板由播放页负责（本组件只 emit `back`/`toast`）。
 *
 * 尺寸：父级给 480×240 的底（TOK.subBg + 左侧 12px 圆角），本组件铺满、**自己不上底色**。
 * 几何一律设计稿 px（1vh=2.4px；480 这类 >240px 的宽度必须写 px）。内部仍是「内容区 456×168」：
 *   顶栏 48px（底边 TOK.line）：左「返回」= 图标 24 + 文字 20px；右「播完整首」= 24×24 圆角 8px
 *     复选框（未选底 TOK.cardBg；选中实心主题色 + fgIcon('check') 16px）+ 文字 20px，均 padding 6px。
 *   一、选时长：3 列 × 2 行，键 144×78、圆角 10px、底 TOK.cardBg、文字 24px，列/行距 12px。
 *   二、倒计时：H:MM:SS 48px 粗体居中 + 「播放至 HH:MM」16px TOK.text2 居中；
 *      下方 96×36 键（圆角 10px、底 TOK.cardBg、stop 图标 24px）= 取消。
 *   三、自定义：左 201×168（大数字 48px 白 + min 16px TOK.text3 + 播放至 16px TOK.text2）；
 *      右 245×168 键盘 3 列 × 4 行（键 79×39、间距 4px、圆角 10px、底 TOK.cardBg；数字 24px、
 *      第 10 键 del 图标、第 12 键 check 图标，均 24px）。输入 1~999（最多 3 位，初值 90）。
 *
 * 三态来源（以定时模块为准，本组件不自己算到期）：
 *   - mount 时 sleepTimer.state().active ? running : presets；
 *   - 订阅 sleepTimer（每秒一次）：running 态里看到 active 变 false = 定时到点 → 自动回 presets，
 *     并 emit('toast') 说明结果（播完整首 / 直接暂停两种文案）。
 *   - 取消：先把 pane 切回 presets 再 cancel —— cancel 是同步广播，若面板还停在 running
 *     会被上面的订阅回调当成「到点」再弹一次提示（会双 toast）。
 *
 * 平台注意：
 *   - 模板裸绑定只来自 props/computed/data（本组件无 props；数据全在 data，图标/颜色走 computed）；
 *   - fgIcon 是 accentMixin 的方法，只能包进 computed（checkIcon）再绑，不能裸绑定；
 *   - 样式只用单类名；动态色（复选框选中底）内联 :style；间距用 margin（不认 gap）；
 *     border-radius:50% 不生效 → 全部写 px；
 *   - 页面会挂两遍 → mounted 订阅自带判重（this._sub），beforeDestroy 里注销。
 */
import { sleepTimer } from '../../utils/player/sleeptimer.js'
import { TOK } from '../../utils/ui/tokens.js'
import { ICON } from '../../assets/icons.js'
import { accentMixin } from '../../utils/theme.js'

const MAX_DIGITS = 3 // 自定义分钟数最多 3 位（1~999）
const INPUT_INIT = '90' // 设计稿自定义态的初值
const CUSTOM_PRESET_MS = 60000

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

/** 本地墙钟 HH:MM（自定义态的「播放至」预览：按输入分钟数从现在算） */
function clockText(ms) {
  const d = new Date(ms)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

export default {
  name: 'TimerPanel',
  mixins: [accentMixin],
  data() {
    return {
      ICON: ICON,
      // 当前态：presets（选时长）/ running（倒计时）/ custom（自定义键盘）
      pane: 'presets',
      timerActive: false, // sleepTimer.state().active 的镜像（用来判「active 变 false」）
      keepTrack: false, // 「播完整首」开关的镜像（模块是唯一真值）
      remainMs: 0, // 定时剩余毫秒（模块每秒广播）
      until: '', // 运行态的「播放至 HH:MM」（模块按 endsAt 算好下发）
      input: INPUT_INIT, // 自定义分钟数（空串显示为 0）
      // 数字键盘前三行（第 9 键后是退格/0/确认，单独写在模板里，结构更直白）
      keyRows: [
        ['1', '2', '3'],
        ['4', '5', '6'],
        ['7', '8', '9']
      ]
    }
  },
  computed: {
    /** 复选框底：勾选 = 实心主题色（内联，运行时可换）；未选 = 卡片底 */
    chkStyle() {
      return { backgroundColor: this.keepTrack ? this.accent.c : TOK.cardBg }
    },
    /** 勾选图标：压在实心主题色上 → 亮色主题自动换深色版 PNG（平台不能给 image 染色） */
    checkIcon() {
      return this.fgIcon('check')
    },
    /** 倒计时文本 H:MM:SS（如 1:29:59）；remainMs 由模块每秒下发，这里只做格式化 */
    countText() {
      let sec = Math.floor(Math.max(0, this.remainMs) / 1000)
      const h = Math.floor(sec / 3600)
      sec -= h * 3600
      const m = Math.floor(sec / 60)
      const s = sec - m * 60
      return h + ':' + pad2(m) + ':' + pad2(s)
    },
    /** 自定义态的大数字：输入为空时显示 0（设计稿没给空态，但空着更奇怪） */
    inputText() {
      return this.input ? this.input : '0'
    },
    /** 自定义态的「播放至」预览：按当前输入分钟数从现在算；无效输入给占位 */
    customUntil() {
      const m = parseInt(this.input, 10)
      if (!(m > 0)) return '--:--'
      return clockText(Date.now() + m * CUSTOM_PRESET_MS)
    }
  },
  mounted() {
    // 页面可能挂两遍：同一个实例只订阅一次（模块单例自己按回调判重，这里再兜一道）
    if (this._sub) return
    const st = sleepTimer.state()
    this.timerActive = !!st.active
    this.keepTrack = !!st.keepTrack
    this.remainMs = st.remainMs || 0
    this.until = st.untilText || ''
    this.pane = st.active ? 'running' : 'presets'
    this.input = INPUT_INIT
    const self = this
    this._sub = function (s) {
      self.onTimer(s)
    }
    sleepTimer.on(this._sub)
  },
  beforeDestroy() {
    // 只注销自己的订阅；**不要 cancel** —— 模块跨页面存活，离开播放页定时还得继续跑
    if (this._sub) sleepTimer.off(this._sub)
    this._sub = null
  },
  methods: {
    /** 定时模块每秒（以及每次状态变化）广播一次 */
    onTimer(s) {
      if (!s) return
      const was = this.timerActive
      const wasKeep = this.keepTrack
      this.timerActive = !!s.active
      this.keepTrack = !!s.keepTrack
      this.remainMs = s.remainMs || 0
      this.until = s.untilText || ''
      // running 态里 active 变 false = 定时到点（取消路径已先切 pane，不会走到这里）
      if (was && !s.active && this.pane === 'running') {
        this.pane = 'presets'
        this.$emit('toast', wasKeep ? '已播完整首，定时结束' : '定时已到，已暂停播放')
      }
    },
    /* ---- 顶栏 ---- */
    /**
     * 返回：自定义键盘 → 回选时长；选时长/倒计时 → 抛出给页面（回到进度控制面板）。
     * 本面板是进度控制（TimeShiftPanel）的子页，不负责关闭整个子面板。
     */
    onBack() {
      if (this.pane === 'custom') {
        this.pane = 'presets'
        return
      }
      this.$emit('back')
    },
    /** 切「播完整首」：模块是唯一真值，它广播回来后 this.keepTrack 才更新 */
    onKeep() {
      sleepTimer.setKeepTrack(!this.keepTrack)
    },
    /* ---- 选时长 ---- */
    pickMin(m) {
      if (!sleepTimer.start(m)) {
        this.$emit('toast', '请输入分钟数')
        return
      }
      this.pane = 'running'
    },
    openCustom() {
      this.input = INPUT_INIT
      this.pane = 'custom'
    },
    /* ---- 倒计时 ---- */
    onCancel() {
      // 先切态再 cancel：cancel 会同步广播 active=false，面板若还停在 running 会被
      // onTimer 当成「到点」再弹一次提示（双 toast）
      this.pane = 'presets'
      sleepTimer.cancel()
      this.$emit('toast', '已取消定时')
    },
    /* ---- 自定义键盘 ---- */
    onDigit(d) {
      if (this.input.length >= MAX_DIGITS) return
      this.input = this.input + d
    },
    onDel() {
      // 退格删末位（可删到空，空时大数字显示 0）
      this.input = this.input.length ? this.input.substring(0, this.input.length - 1) : ''
    },
    onConfirm() {
      const m = parseInt(this.input, 10)
      if (!(m > 0) || !sleepTimer.start(m)) {
        this.$emit('toast', '请输入分钟数')
        return
      }
      this.pane = 'running'
    },
    /** 键盘键间距：行内第 3 键不留右边距（平台不支持 :last-child，用列号算） */
    keyStyle(ki) {
      return { marginRight: ki === 2 ? '0px' : '4px' }
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 面板根：铺满父级的 480×240（父级给 TOK.subBg 底 + 左侧圆角），自己不上底色。
   overflow:hidden 兜住子元素的 1px 渲染误差，不让它溢到隔壁控制区。 */
.tm {
  width: 100%;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
}
/* ---- 顶栏 48px ---- */
.tm-top {
  height: 48px;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-left: 12px;
  padding-right: 12px;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
/* 返回键：图标 24 + 文字 20，padding 6（设计稿 IconButton） */
.tm-back {
  flex-direction: row;
  align-items: center;
  padding: 6px;
}
.tm-back-ico {
  width: 24px;
  height: 24px;
  margin-right: 4px;
}
.tm-back-t {
  font-size: 20px;
  color: @text;
}
/* 「播完整首」：24×24 圆角 8px 复选框 + 文字 20，padding 6 */
.tm-keep {
  flex-direction: row;
  align-items: center;
  padding: 6px;
}
.tm-chk {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  align-items: center;
  justify-content: center;
}
.tm-chk-ico {
  width: 16px;
  height: 16px;
}
.tm-keep-t {
  font-size: 20px;
  color: @text;
  margin-left: 4px;
}
/* ---- 内容区：顶栏之外 192px；三态各自摆一块 456×168 的内容盒（四边 margin 12） ---- */
.tm-body {
  flex: 1;
  flex-direction: column;
}
/* 一、选时长：两行 78 + 行距 12，列上用 margin-right 12（平台不认 gap） */
.tm-presets {
  width: 456px;
  height: 168px;
  margin-top: 12px;
  margin-left: 12px;
  flex-direction: column;
}
.tm-prow {
  height: 78px;
  flex-direction: row;
}
.tm-prow2 {
  height: 78px;
  flex-direction: row;
  margin-top: 12px;
}
.tm-pbtn {
  width: 144px;
  height: 78px;
  border-radius: 10px;
  background-color: @card-bg;
  align-items: center;
  justify-content: center;
  margin-right: 12px;
}
/* 行尾键独立类名（末尾不留 margin，否则整行左偏；平台不支持 :last-child） */
.tm-pbtn-end {
  width: 144px;
  height: 78px;
  border-radius: 10px;
  background-color: @card-bg;
  align-items: center;
  justify-content: center;
}
.tm-pbtn-t {
  font-size: 24px;
  color: @text;
}
/* 二、倒计时：状态区 132（文字组 77 垂直居中）+ 操作区 36 */
.tm-timer {
  width: 456px;
  height: 168px;
  margin-top: 12px;
  margin-left: 12px;
  flex-direction: column;
}
.tm-status {
  width: 456px;
  height: 132px;
  flex: none;
  align-items: center;
  justify-content: center;
}
.tm-count {
  font-size: 48px;
  font-weight: bold;
  color: @text;
  /* 行高 58px：设计稿倒计时文字框 h58（时间轴 27.5 → 85.5 由状态区垂直居中得） */
  line-height: 58px;
}
.tm-until {
  font-size: 16px;
  color: @text-2;
  line-height: 19px;
}
.tm-ctl {
  width: 456px;
  height: 36px;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}
.tm-stop {
  width: 96px;
  height: 36px;
  border-radius: 10px;
  background-color: @card-bg;
  align-items: center;
  justify-content: center;
}
.tm-stop-ico {
  width: 24px;
  height: 24px;
}
/* 三、自定义：左状态 201×168（Time 137 + 播放至 19，整体垂直居中）+ 右键盘 245×168，间距 10 */
.tm-custom {
  width: 456px;
  height: 168px;
  margin-top: 12px;
  margin-left: 12px;
  flex-direction: row;
}
.tm-cstatus {
  width: 201px;
  height: 168px;
  flex: none;
  align-items: center;
  justify-content: center;
}
.tm-ctime {
  width: 201px;
  height: 137px;
  flex: none;
  align-items: center;
  justify-content: center;
}
.tm-cnum {
  font-size: 48px;
  font-weight: bold;
  color: @text;
  line-height: 58px;
}
.tm-cmin {
  font-size: 16px;
  color: @text-3;
  line-height: 19px;
}
.tm-cuntil {
  font-size: 16px;
  color: @text-2;
  line-height: 19px;
}
.tm-kb {
  width: 245px;
  height: 168px;
  flex: none;
  margin-left: 10px;
  flex-direction: column;
}
/* 前 3 行各留 4px 行距；最后一行（退格/0/确认）用不带 margin 的类 */
.tm-krow {
  height: 39px;
  flex: none;
  flex-direction: row;
  margin-bottom: 4px;
}
.tm-krow-end {
  height: 39px;
  flex: none;
  flex-direction: row;
}
/* 键 79×39；行内间距由模板的 keyStyle 给 margin-right（4px） */
.tm-key {
  width: 79px;
  height: 39px;
  border-radius: 10px;
  background-color: @card-bg;
  align-items: center;
  justify-content: center;
}
.tm-keyt {
  font-size: 24px;
  color: @text;
}
.tm-keyico {
  width: 24px;
  height: 24px;
}
</style>
