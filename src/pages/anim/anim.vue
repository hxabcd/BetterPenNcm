<template>
  <view class="av">
    <text class="av-hd">第三轮 · 字号/颜色到底能不能平滑？（800ms 翻转；平滑=有中间态，瞬跳=没有，不动=驱动不跑）</text>

    <view class="av-col av-c1">
      <view class="av-item">
        <text class="av-lb">1 @keyframes 改 font-size</text>
        <view class="av-lane">
          <text class="r1">字号 Aa</text>
        </view>
      </view>
      <view class="av-item">
        <text class="av-lb">2 @keyframes 改 color</text>
        <view class="av-lane">
          <text class="r2">颜色 Aa</text>
        </view>
      </view>
      <view class="av-item">
        <text class="av-lb">3 @keyframes 改 background-color</text>
        <view class="av-lane">
          <view class="r3"></view>
        </view>
      </view>
      <view class="av-item">
        <text class="av-lb">4 @keyframes 改 opacity</text>
        <view class="av-lane">
          <view class="r4"></view>
        </view>
      </view>
    </view>

    <view class="av-col av-c2">
      <view class="av-item">
        <text class="av-lb">5 状态类切换 font-size</text>
        <view class="av-lane">
          <text :class="c5">字号 Aa</text>
        </view>
      </view>
      <view class="av-item">
        <text class="av-lb">6 状态类切换 color</text>
        <view class="av-lane">
          <text :class="c6">颜色 Aa</text>
        </view>
      </view>
      <view class="av-item">
        <text class="av-lb">7 状态类切换 background</text>
        <view class="av-lane">
          <view :class="c7"></view>
        </view>
      </view>
      <view class="av-item">
        <text class="av-lb">8 transition:all + 内联 font-size</text>
        <view class="av-lane">
          <text class="r8" :style="s8">字号 Aa</text>
        </view>
      </view>
    </view>

    <view class="av-col av-c3">
      <view class="av-item">
        <text class="av-lb">9 内联 transition + font-size（对照）</text>
        <view class="av-lane">
          <text class="r9" :style="s9">字号 Aa</text>
        </view>
      </view>
      <view class="av-item">
        <text class="av-lb">10 JS 补间 font-size</text>
        <view class="av-lane">
          <text class="r10" :style="s10">字号 Aa</text>
        </view>
      </view>
      <view class="av-item">
        <text class="av-lb">11 JS 补间 color</text>
        <view class="av-lane">
          <text class="r11" :style="s11">颜色 Aa</text>
        </view>
      </view>
      <view class="av-item">
        <text class="av-lb">12 JS 补间 background-color</text>
        <view class="av-lane">
          <view class="r12" :style="s12"></view>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="less" scoped>
@import '../../styles/common.less';

.av {
  width: 1020px;
  height: 240px;
  position: relative;
  background-color: @panel;
}
.av-hd {
  position: absolute;
  left: 8px;
  top: 2px;
  font-size: 12px;
  color: @text-2;
}
.av-col {
  position: absolute;
  top: 18px;
  width: 328px;
}
.av-c1 {
  left: 8px;
}
.av-c2 {
  left: 346px;
}
.av-c3 {
  left: 684px;
}
.av-item {
  height: 54px;
}
.av-lb {
  font-size: 12px;
  color: @text-3;
}
.av-lane {
  position: relative;
  height: 32px;
  margin-top: 1px;
  background-color: @panel-2;
  border-radius: 4px;
  overflow: hidden;
}

/* 1/2：keyframes 直接改字号 / 颜色。时长同样是「单程」，0.8s 与其它条同节奏 */
.r1 {
  position: absolute;
  left: 6px;
  top: 0;
  font-size: 12px;
  line-height: 32px;
  color: @text;
  animation: kfsize 0.8s linear infinite alternate;
}
.r2 {
  position: absolute;
  left: 6px;
  top: 0;
  font-size: 18px;
  line-height: 32px;
  color: @text;
  animation: kfcolor 0.8s linear infinite alternate;
}
.r3 {
  position: absolute;
  top: 6px;
  left: 4px;
  width: 80px;
  height: 20px;
  border-radius: 4px;
  background-color: @accent;
  animation: kfbg 0.8s linear infinite alternate;
}
.r4 {
  position: absolute;
  top: 6px;
  left: 4px;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background-color: @text;
  animation: kfop 0.8s linear infinite alternate;
}
/* 5~7：两个状态类，各自带 transition 与目标值（不写内联） */
.s5a {
  position: absolute;
  left: 6px;
  top: 0;
  font-size: 12px;
  line-height: 32px;
  color: @text;
  transition: font-size 700ms linear;
}
.s5b {
  position: absolute;
  left: 6px;
  top: 0;
  font-size: 28px;
  line-height: 32px;
  color: @text;
  transition: font-size 700ms linear;
}
.s6a {
  position: absolute;
  left: 6px;
  top: 0;
  font-size: 18px;
  line-height: 32px;
  color: @text;
  transition: color 700ms linear;
}
.s6b {
  position: absolute;
  left: 6px;
  top: 0;
  font-size: 18px;
  line-height: 32px;
  color: @text-3;
  transition: color 700ms linear;
}
.s7a {
  position: absolute;
  top: 6px;
  left: 4px;
  width: 80px;
  height: 20px;
  border-radius: 4px;
  background-color: @accent;
  transition: background-color 700ms linear;
}
.s7b {
  position: absolute;
  top: 6px;
  left: 4px;
  width: 80px;
  height: 20px;
  border-radius: 4px;
  background-color: @text;
  transition: background-color 700ms linear;
}
/* 8：transition:all 在 class，内联只给 font-size */
.r8 {
  position: absolute;
  left: 6px;
  top: 0;
  font-size: 12px;
  line-height: 32px;
  color: @text-2;
  transition: all 700ms linear;
}
/* 9：内联 transition（对照） */
.r9 {
  position: absolute;
  left: 6px;
  top: 0;
  font-size: 12px;
  line-height: 32px;
  color: @text-3;
}
/* 10~12：JS 逐帧补间（内联值每 16ms 改一次） */
.r10 {
  position: absolute;
  left: 6px;
  top: 0;
  font-size: 12px;
  line-height: 32px;
  color: @text;
}
.r11 {
  position: absolute;
  left: 6px;
  top: 0;
  font-size: 18px;
  line-height: 32px;
  color: @text;
}
.r12 {
  position: absolute;
  top: 6px;
  left: 4px;
  width: 80px;
  height: 20px;
  border-radius: 4px;
  background-color: @accent;
}
@keyframes kfsize {
  0% {
    font-size: 12px;
  }
  100% {
    font-size: 28px;
  }
}
@keyframes kfcolor {
  0% {
    color: @text;
  }
  100% {
    color: @text-3;
  }
}
@keyframes kfbg {
  0% {
    background-color: @accent;
  }
  100% {
    background-color: @text;
  }
}
@keyframes kfop {
  0% {
    opacity: 1;
  }
  100% {
    opacity: 0.3;
  }
}
</style>

<script>
/**
 * 第三轮动画探针：字号 / 颜色到底能不能平滑，以及靠哪条路径。
 *
 * 第二轮只测了「class 内 transition + 内联改值」这一条路径，看到 font-size / color 瞬跳。
 * 但「没看到中间态」不等于「平台不支持」—— 还可能是这条路径对文本属性不生效。所以这一轮换路径：
 *   1/2  @keyframes 直接改 font-size / color（关键：animation 走的是另一条插值通道）
 *   3/4  @keyframes 改 background-color / opacity（对照，transition 已知可用）
 *   5/6  两个状态类切换 font-size / color（不写内联，只换类）
 *   7    状态类切换 background-color（对照）
 *   8    transition: all + 内联 font-size（复现第二轮 8 号）
 *   9    内联 transition + font-size（复现第二轮 10 号）
 *   10~12 JS 逐帧补间 font-size / color / background-color（兜底路径：如果 JS 能平滑，
 *         高亮过渡就有实现方案，只是每帧一次 setData + 字号会重排）
 *
 * 只做展示，不上报日志（结论直接看屏幕）。
 */
import { TOK } from '../../utils/ui/tokens.js'
import { ACCENTS } from '../../utils/theme.js'

let started = false

const FLIP_MS = 800
const TWEEN_MS = 700
const FS_MIN = 12
const FS_MAX = 28
const RED = ACCENTS[0].c

function lerp(a, b, p) {
  return a + (b - a) * p
}

function hexToRgb(c) {
  const h = String(c || '').replace('#', '')
  if (h.length !== 6) return null
  const v = parseInt(h, 16)
  if (isNaN(v)) return null
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

function mix(from, to, p) {
  const a = hexToRgb(from)
  const b = hexToRgb(to)
  if (!a || !b) return to
  return 'rgb(' + Math.round(lerp(a[0], b[0], p)) + ',' +
    Math.round(lerp(a[1], b[1], p)) + ',' + Math.round(lerp(a[2], b[2], p)) + ')'
}

/** 每 16ms 推一帧，进度按墙钟算（定时器抖动不影响总时长） */
function tween(onFrame) {
  const t0 = Date.now()
  const step = function () {
    const p = Math.min(1, (Date.now() - t0) / TWEEN_MS)
    onFrame(p)
    if (p < 1) setTimeout(step, 16)
  }
  setTimeout(step, 16)
}

function startLoop(vm) {
  let atB = false
  const flip = function () {
    atB = !atB
    // 5~7：换类
    vm.c5 = atB ? 's5b' : 's5a'
    vm.c6 = atB ? 's6b' : 's6a'
    vm.c7 = atB ? 's7b' : 's7a'
    // 8/9：内联给目标值（8 靠 class 的 transition:all，9 靠自己带 transition）
    vm.s8 = 'font-size:' + (atB ? FS_MAX : FS_MIN) + 'px;'
    vm.s9 = 'font-size:' + (atB ? FS_MAX : FS_MIN) + 'px;transition:font-size 700ms linear;'
    // 10~12：JS 逐帧补间
    const toSize = atB ? FS_MAX : FS_MIN
    const toColor = atB ? TOK.text3 : TOK.text
    const toBg = atB ? TOK.text : RED
    tween(function (p) {
      vm.s10 = 'font-size:' + lerp(atB ? FS_MIN : FS_MAX, toSize, p).toFixed(1) + 'px;'
      vm.s11 = 'color:' + mix(atB ? TOK.text3 : TOK.text, toColor, p) + ';'
      vm.s12 = 'background-color:' + mix(atB ? TOK.text : RED, toBg, p) + ';'
    })
  }
  flip()
  setInterval(flip, FLIP_MS)
}

export default {
  name: 'anim',
  data() {
    return {
      c5: 's5a',
      c6: 's6a',
      c7: 's7a',
      s8: '',
      s9: '',
      s10: '',
      s11: '',
      s12: ''
    }
  },
  mounted() {
    if (started) return // 页面会挂两遍
    started = true
    startLoop(this)
  }
}
</script>
