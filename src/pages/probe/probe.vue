<template>
  <view class="probe">
    <view class="phead">
      <text class="phead-a">PROBE {{ status }}</text>
      <text class="phead-b">tick={{ tick }}</text>
    </view>

    <!-- 绝对定位：top/left、top/right、bottom+left/right 拉伸 -->
    <view class="pabs">
      <view :style="styleA"></view>
      <view :style="styleB"></view>
      <view :style="styleC"></view>
    </view>

    <!-- 含 slot 组件的 v-if 结构切换 -->
    <view class="pzone">
      <p-slot v-if="showA"><view :style="styleD"></view></p-slot>
      <view v-else :style="styleE"></view>
    </view>

    <!-- 不含 slot 组件的 v-if 结构切换 -->
    <view class="pzone2">
      <p-noslot v-if="showB"></p-noslot>
      <view v-else :style="styleF"></view>
    </view>

    <!-- CSS 能力探针（2026-11-01）：四种过渡/动画写法各占一个方块，同时右移 80px，
         监听 transitionend / animationend 判定是否真的在插值。结果看日志 `[probe] css ...`。 -->
    <view class="pcss">
      <view class="pcss-a" :style="cssA" @transitionend="cssEnd('a')"></view>
      <view class="pcss-b" :style="cssB" @transitionend="cssEnd('b')"></view>
      <view class="pcss-c" :style="cssC" @transitionend="cssEnd('c')"></view>
      <view class="pcss-d" :style="cssD" @animationend="cssEnd('d')"></view>
      <text class="pcss-t">{{ cssText }}</text>
    </view>
  </view>
</template>

<style lang="less" scoped>
@import '../../styles/common.less';

.probe {
  width: 1020px;
  height: 240px;
  position: relative;
  background-color: #101418;
}
.phead {
  position: absolute;
  top: 6px;
  left: 280px;
  display: flex;
  flex-direction: row;
}
.phead-a {
  font-size: 18px;
  color: @text;
}
.phead-b {
  font-size: 18px;
  color: #ffcc00;
  margin-left: 16px;
}
.pabs {
  position: absolute;
  top: 36px;
  left: 280px;
  width: 260px;
  height: 170px;
}
.pzone {
  position: absolute;
  top: 40px;
  left: 620px;
}
.pzone2 {
  position: absolute;
  top: 110px;
  left: 620px;
}
/* ---- CSS 能力探针：底部一排方块（从左往右移 80px） ---- */
.pcss {
  position: absolute;
  left: 4px;
  top: 212px;
  height: 24px;
  flex-direction: row;
  align-items: center;
}
.pcss-a {
  width: 18px;
  height: 18px;
  margin-right: 10px;
  background-color: #3366ff;
}
.pcss-b {
  width: 18px;
  height: 18px;
  margin-right: 10px;
  background-color: #33ff99;
}
/* 第三种：transition 写在 class 里（不在内联样式），内联只改 transform */
.pcss-c {
  width: 18px;
  height: 18px;
  margin-right: 10px;
  background-color: #ffaa33;
  transition: transform 300ms linear;
}
.pcss-d {
  width: 18px;
  height: 18px;
  margin-right: 10px;
  background-color: #cc66ff;
}
.pcss-t {
  font-size: 14px;
  color: @text;
}
@keyframes pcss-spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
</style>

<script>
/**
 * 临时能力探针页（复核用，独立 appid 构建，不随正式版发布）：
 *   1. storage.getStorageInfo 是否存在 / storage 大值写入
 *   2. fs.readdir 返回形状
 *   3. FLAC 直链 playFile 可播性（PC 端 range_server.py 提供 /probe.flac）
 *   4. position:absolute 的 top/left/right 组合（页面上色块，截图判读）
 *   5. v-if 切换含 slot / 不含 slot 组件（页面上色块，3 秒翻转）
 *   6. 导航层自测：utils/nav.js 的「逻辑页 → 实例槽位」push/pop 语义 + 两类边界
 *      （平台回退弹层后的槽位释放、15 层深度压力），日志 `[nav]` / `[navtest]`，
 *      PC 侧断言见 scripts/nav_selftest.sh；正式版不打包本页
 *
 * FLAC 直链主机取自构建时注入的 LOG_SRV（同机不同端口），避免把内网 IP 写进源码。
 * 日志走 utils/log.js：console.warn 兜底进 /data/applog/YD_PEN_APP.log。
 */
import { log, brief } from '../../utils/log.js'
import { sleep } from '../../utils/util.js'
import { readNames } from '../../utils/fsutil.js'
import { getStorage, setStorage, removeStorage } from '../../utils/store.js'
import { LOG_SRV } from '../../utils/logconfig.generated.js'
import { go, stackKeys } from '../../utils/nav.js'
import ProbeSlot from '../../components/ProbeSlot.vue'
import ProbeNoSlot from '../../components/ProbeNoSlot.vue'

let started = false
let navTestStarted = false
let navTestDone = false

function flacUrl() {
  const host = LOG_SRV ? LOG_SRV.replace(/^https?:\/\//, '').split('/')[0].split(':')[0] : ''
  return host ? 'http://' + host + ':8889/probe.flac' : ''
}

export default {
  name: 'probe',
  components: { 'p-slot': ProbeSlot, 'p-noslot': ProbeNoSlot },
  data() {
    return {
      status: 'INIT',
      tick: 0,
      showA: true,
      showB: true,
      styleA:
        'position:absolute;top:0px;left:0px;width:20px;height:20px;background-color:#ff3333;',
      styleB:
        'position:absolute;top:0px;right:0px;width:20px;height:20px;background-color:#33ff33;',
      styleC:
        'position:absolute;bottom:0px;left:0px;right:0px;height:12px;background-color:#3388ff;',
      styleD: 'width:16px;height:16px;background-color:#ff00ff;',
      styleE: 'width:16px;height:16px;background-color:#00ffff;',
      styleF: 'width:16px;height:16px;background-color:#ffff00;',
      // CSS 能力探针：四种写法的内联样式（初始 transform 0，稍后改成 80px）
      cssA: '',
      cssB: '',
      cssC: '',
      cssD: '',
      cssText: '',
      cssCounts: { a: 0, b: 0, c: 0, d: 0 }
    }
  },
  mounted() {
    this.bootOnce()
  },
  methods: {
    bootOnce() {
      if (started) return // 页面会挂两遍
      started = true
      const vm = this
      setInterval(function () {
        vm.tick = vm.tick + 1
      }, 1000)
      setInterval(function () {
        vm.showA = !vm.showA
        vm.showB = !vm.showB
      }, 3000)
      runTests(vm)
      runCssProbe(vm)
      // 导航层自测与本页原有探针流程并行：原有流程耗时较长（FLAC 播放），
      // 自测只依赖 mounted 后能调 $falcon.navTo，尽早开始以便在原有流程
      // 「DONE 后 10 秒 closeApp」之前跑完（步骤见 runNavSelfTest）。
      startNavSelfTest()
    },
    /** 过渡/动画结束事件（平台若不支持这些事件，计数会一直是 0） */
    cssEnd(k) {
      this.cssCounts[k] = (this.cssCounts[k] || 0) + 1
      this.cssText =
        'a=' + this.cssCounts.a + ' b=' + this.cssCounts.b +
        ' c=' + this.cssCounts.c + ' d=' + this.cssCounts.d
    }
  }
}

/* ==================== CSS 能力探针（2026-11-01 加） ==================== */

const BOX = 'width:18px;height:18px;background-color:#3366ff;'

/** rAF：500ms 内回调几次。0 = 完全不调度（歌词面板拖动/换行卡住就是这个原因） */
function probeRaf() {
  return new Promise(function (done) {
    if (typeof requestAnimationFrame !== 'function') {
      log('probe', 'css rAF 不存在')
      return done()
    }
    const t0 = Date.now()
    let n = 0
    let shown = false
    const finish = function () {
      if (shown) return
      shown = true
      log('probe', 'css rAF 500ms 帧数=' + n)
      done()
    }
    const loop = function () {
      n++
      if (Date.now() - t0 < 500) requestAnimationFrame(loop)
      else finish()
    }
    requestAnimationFrame(loop)
    setTimeout(finish, 900) // 一帧都不来也要收尾
  })
}

/** setTimeout 链：8 次 16ms 的真实间隔（判断定时器精度够不够做帧驱动） */
function probeTimers() {
  return new Promise(function (done) {
    const gaps = []
    let last = Date.now()
    let i = 0
    const step = function () {
      const now = Date.now()
      gaps.push(now - last)
      last = now
      if (++i < 8) setTimeout(step, 16)
      else {
        log('probe', 'css setTimeout16 间隔=' + gaps.join('/'))
        done()
      }
    }
    setTimeout(step, 16)
  })
}

/** 过渡/动画：把四个方块右移 80px，看 transitionend / animationend 是否在 700ms 内到达 */
function probeTransitions(vm) {
  return new Promise(function (done) {
    vm.cssA = BOX + 'transform:translateX(0px);transition:transform 300ms linear;'
    vm.cssB = BOX + 'transform:translateX(0px);transition-property:transform;transition-duration:300ms;transition-timing-function:linear;'
    vm.cssC = BOX + 'transform:translateX(0px);'
    vm.cssD = BOX + 'animation:pcss-spin 400ms linear;'
    setTimeout(function () {
      vm.cssA = BOX + 'transform:translateX(80px);transition:transform 300ms linear;'
      vm.cssB = BOX + 'transform:translateX(80px);transition-property:transform;transition-duration:300ms;transition-timing-function:linear;'
      vm.cssC = BOX + 'transform:translateX(80px);'
      setTimeout(function () {
        const c = vm.cssCounts
        log('probe', 'css 过渡事件 简写=' + c.a + ' 分开三属性=' + c.b +
          ' class内=' + c.c + ' 动画=' + c.d)
        done()
      }, 700)
    }, 120)
  })
}

async function runCssProbe(vm) {
  await new Promise(function (r) { setTimeout(r, 900) }) // 等首帧
  log('probe', 'css 探针开始')
  await probeRaf()
  await probeTimers()
  await probeTransitions(vm)
  log('probe', 'css 探针结束')
}

/* ==================== 测试流程 ==================== */

async function runTests(vm) {
  log('probe', 'BOOT page=probe')
  vm.status = 'STORAGE'
  await testStorage()
  vm.status = 'FS'
  await testReaddir()
  vm.status = 'FLAC'
  await testFlac()
  vm.status = 'DONE'
  log('probe', 'DONE')
  // 留 10 秒供截图/切后台，再自行退出
  setTimeout(waitNavTestThenClose, 10000)
}

/** 原有流程 DONE 后 10 秒退出；若导航自测（含深度压力）还没跑完则顺延，避免退出截断自测。
 *  自测跑完后再留 10 秒：PC 侧要在这段时间里停止 logserver，避免应用退出时的页面卸载事件
 *  混进 nav_selftest.sh 的「无非预期 page-unload」断言。探针原有退出行为不变，只推迟时机。 */
function waitNavTestThenClose() {
  if (navTestStarted && !navTestDone) {
    setTimeout(waitNavTestThenClose, 500)
    return
  }
  setTimeout(function () {
    try {
      $falcon.closeApp()
    } catch (e) {}
  }, 10000)
}

async function testStorage() {
  try {
    const m = await import('storage')
    const S = (m && m.default) || m
    log('probe', 'storage keys=' + brief(Object.keys(S)))
    log('probe', 'getStorageInfo=' + typeof S.getStorageInfo)
    if (typeof S.getStorageInfo === 'function') {
      try {
        const info = await S.getStorageInfo()
        log('probe', 'storageInfo=' + brief(info))
      } catch (e) {
        log('probe', 'storageInfo FAIL ' + (e && e.message))
      }
    }
  } catch (e) {
    log('probe', 'storage import FAIL ' + (e && e.message))
  }

  try {
    const big = new Array(512 * 1024 + 1).join('x')
    const t0 = Date.now()
    const okW = await setStorage('__probe_big', big)
    const t1 = Date.now()
    const back = await getStorage('__probe_big')
    log(
      'probe',
      'storeBig ok=' + okW + ' readLen=' + (back ? back.length : -1) + ' writeMs=' + (t1 - t0)
    )
    await removeStorage('__probe_big')
  } catch (e) {
    log('probe', 'storeBig FAIL ' + (e && e.message))
  }
}

async function testReaddir() {
  try {
    /* global $dataDir */
    const m = await import('fs')
    const F = (m && m.default) || m
    const arr = await F.readdir($dataDir)
    const first = arr && arr.length ? arr[0] : null
    log(
      'probe',
      'readdir len=' + (arr && arr.length) + ' firstType=' + typeof first + ' first=' + brief(first)
    )
  } catch (e) {
    log('probe', 'readdir FAIL ' + (e && e.message))
  }
  try {
    /* global $dataDir */
    const names = await readNames($dataDir)
    log('probe', 'readNames len=' + names.length + ' first=' + brief(names[0]))
  } catch (e) {
    log('probe', 'readNames FAIL ' + (e && e.message))
  }
}

async function testFlac() {
  const url = flacUrl()
  log('probe', 'flacUrl=' + (url ? 'set' : 'EMPTY (LOG_SRV 未注入)'))
  if (!url) return

  let SP = null
  try {
    const m = await import('soundPlayer')
    const M = (m && m.default) || m
    SP = M.SoundPlayer || M
  } catch (e) {
    log('probe', 'SP import FAIL ' + (e && e.message))
    return
  }
  if (typeof SP !== 'function') return

  let sp = null
  try {
    sp = new SP()
  } catch (e) {
    log('probe', 'SP new FAIL ' + (e && e.message))
    return
  }

  const counts = {}
  const lastArgs = {}
  const names = [
    'mediaPlayerPositionChanged',
    'mediaPlayerDurationChanged',
    'mediaPlayerEndChanged',
    'mediaPlayerEndWithErrorChanged',
    'mediaPlayerProgressChanged'
  ]
  for (let i = 0; i < names.length; i++) {
    const n = names[i]
    try {
      const sig = sp[n]
      if (!sig || typeof sig.on !== 'function') {
        log('probe', 'sig missing ' + n)
        continue
      }
      sig.on(function () {
        const a = []
        for (let k = 0; k < arguments.length; k++) a.push(arguments[k])
        counts[n] = (counts[n] || 0) + 1
        if (counts[n] <= 3) log('probe', 'ev ' + n + '#' + counts[n] + ' args=' + brief(a, 200))
        lastArgs[n] = a
      })
    } catch (e) {
      log('probe', 'sig bind FAIL ' + n + ' ' + (e && e.message))
    }
  }

  function snap() {
    const o = {}
    for (const k in counts) o[k] = counts[k]
    return o
  }
  function delta(before) {
    const o = {}
    for (const k in counts) {
      const d = counts[k] - (before[k] || 0)
      if (d > 0) o[k] = d
    }
    return o
  }
  async function step(tag, pos, rate, ms) {
    const before = snap()
    let uuid = null
    try {
      uuid = sp.playFile(url, pos, rate, true, true)
    } catch (e) {
      log('probe', tag + ' play FAIL ' + (e && e.message))
      return
    }
    log('probe', tag + ' uuid=' + brief(uuid))
    await sleep(ms)
    log('probe', tag + ' delta=' + brief(delta(before)))
    log('probe', tag + ' lastPos=' + brief(lastArgs['mediaPlayerPositionChanged'], 120))
    log('probe', tag + ' lastDur=' + brief(lastArgs['mediaPlayerDurationChanged'], 120))
    try {
      sp.stop()
    } catch (e) {}
    await sleep(800)
  }

  await step('flac-p0', 0, 1.0, 6000)
  await step('flac-seek5', 5000, 1.0, 4000)
}

/* ==================== 导航层自测 ====================
 * 验证 utils/nav.js 的「逻辑页 → 实例槽位」是否得到标准 push/pop：
 *   - 同一逻辑页连续 go 两次 → 分别拿到 <base> / <base>2 两个槽位（都是 push，不销毁下层）；
 *   - go(player) 走 reuse（全局目的地页，不叠第二层）；
 *   - $falcon.closePageByName(槽位) 只关当前一层，下层页面仍存活 → 日志里有对应 page-unload。
 * 另有两类边界（task-3）：
 *   A. 平台「命中栈内页」回退会销毁它上面的页面（真实用户流：深层页面点播放）——
 *      销毁后的槽位必须被生命周期记账释放，后续同逻辑页 go 要能重新 push，不能 degrade；
 *   B. 深度压力：把栈推到 15 层，确认 page-load 齐全、无非预期 page-unload（平台页栈上限）、
 *      再逐个 close 回收到 5 层且每步栈快照正确；12 层时停一下供 PC 侧采样内存/截图。
 * 再加两类新边界（task-4，导航层按审计意见改动后）：
 *   C. 连点合并：同一 tick 连发两次「同逻辑页 + 同参数」只生效一次（第二次 dup-ignore）；
 *      同 tick 但参数不同则必须两次都生效（不能误伤）。
 *   D. degrade 路径：artist 6 个槽位压满后再 go('artist') 应复用**最上层**同类实例
 *      （不新增第 7 个槽位/实例，日志 degrade）；关掉最上层释放槽位后再 go 必须恢复 push。
 * 被导航到的页面可能未登录 / 无网络而加载失败，与导航层无关：只以 `[nav]` 日志为断言依据，
 * 每步独立 try/catch，失败只记日志、不中断后续步骤。
 * 页面会挂两遍：模块级 navTestStarted 防重（bootOnce 的 started 已是第一道）。
 * PC 侧断言见 scripts/nav_selftest.sh（grep device_log.txt）。
 */
const NAV_STEP_MS = 650 // 给平台派发页面 load / unload 生命周期留时间

/** 执行一步导航并在前后各记一条 [navtest]；异常只记 FAIL，不中断后续步骤。
 *  ms 缺省用 NAV_STEP_MS（给平台派发页面 load/unload 生命周期留时间）；需要长时间保持某栈状态的步骤传更大值。 */
async function navStep(tag, fn, ms) {
  log('navtest', tag + ' begin')
  try {
    await fn()
    log('navtest', tag + ' ok')
  } catch (e) {
    log('navtest', tag + ' FAIL ' + ((e && e.message) || e))
  }
  await sleep(ms === undefined ? NAV_STEP_MS : ms)
}

/** 记录当前槽位栈（nav.js 的实例存活记账） */
function navStack(tag) {
  log('navtest', tag + ' stack=' + JSON.stringify(stackKeys()))
}

async function runNavSelfTest() {
  if (navTestStarted) return
  navTestStarted = true
  navStack('start')

  // 1) 同一逻辑页连续两层：list / list2
  await navStep('1 go list a', function () {
    go('list', { kind: 'search', keyword: 'a' })
  })
  await navStep('2 go list b', function () {
    go('list', { kind: 'search', keyword: 'b' })
  })
  navStack('after list2')

  // 2) 关掉上层（模拟返回）：list2 卸载，但下层 list 必须还在（旧语义会连环销毁）
  await navStep('3 close list2', function () {
    /* global $falcon */
    $falcon.closePageByName('list2')
  })
  navStack('after close list2')

  // 3) 另一逻辑页两连开：playlists / playlists2，再关上层
  await navStep('4 go playlists', function () {
    go('playlists', {})
  })
  await navStep('5 go playlists pick', function () {
    go('playlists', { pick: '1,2' })
  })
  navStack('after playlists2')
  await navStep('6 close playlists2', function () {
    $falcon.closePageByName('playlists2')
  })
  navStack('after close playlists2')

  // 4) player 是全局目的地页：连续两次 go 都应为 reuse（第二次平台原地补发 options，不叠层）
  await navStep('7 go player', function () {
    go('player', {})
  })
  await navStep('8 go player again', function () {
    go('player', {})
  })
  navStack('after player2')

  // 5) queue 两连开：queue / queue2（第二层必须是 queue2）
  await navStep('9 go queue', function () {
    go('queue', {})
  })
  await navStep('10 go queue again', function () {
    go('queue', {})
  })
  navStack('done')

  /* ---------- A. 平台回退弹层后的槽位释放 ----------
   * 当前栈 [index,list,playlists,player,queue,queue2]。player 是全局目的地页（reuse）：
   * 再 go('player') 时平台按「命中栈内页」语义销毁它上面的 queue2 / queue，把 player 挪回栈顶；
   * 导航层靠页面卸载生命周期把这两个槽位释放 → 随后 go('queue') 必须重新 push 到 queue 槽位，
   * 不能因为槽位仍被已销毁的实例占着而 degrade（这正是真实用户流：深层页面点「播放」再进队列）。
   */
  await navStep('11 go player from deep stack', function () {
    go('player', {})
  })
  navStack('after fallback')
  await navStep('12 requeue after fallback', function () {
    go('queue', {})
  })
  navStack('after requeue')

  /* ---------- B. 深度压力：把页面栈推到 15 层 ----------
   * 槽位规划（nav.js PAGES 表）：list 共 6（基础 + list2..list6，本段用 5 层）、album 2 层、
   * artist 2 层、songinfo 2 层；从 [index,list,playlists,player,queue] 继续往上压 → 共 15 层。
   * 12 层时停 7 秒：PC 侧要在稳定状态跑 miniapp_cli memoryApp + 截屏（锚点 = deep12 栈快照）。
   * 之后逐个 close 回收到 [index,list,playlists,player,queue]，每关一层记一次栈快照。
   */
  await navStep('13 go list2', function () {
    go('list', { kind: 'search', keyword: 'deep2' })
  })
  await navStep('14 go list3', function () {
    go('list', { kind: 'search', keyword: 'deep3' })
  })
  await navStep('15 go list4', function () {
    go('list', { kind: 'search', keyword: 'deep4' })
  })
  await navStep('16 go list5', function () {
    go('list', { kind: 'search', keyword: 'deep5' })
  })
  await navStep('17 go album', function () {
    go('album', {})
  })
  await navStep('18 go album2', function () {
    go('album', {})
  })
  await navStep('19 go artist', function () {
    go('artist', {})
  })
  navStack('deep12') // 12 层（index,list,playlists,player,queue,list2..list5,album,album2,artist）
  await navStep('20 deep12 hold', function () {}, 7000) // 保持 12 层：给 PC 侧截屏/内存采样留足 7 秒（日志 POST 有延迟）
  await navStep('21 go artist2', function () {
    go('artist', {})
  })
  await navStep('22 go songinfo', function () {
    go('songinfo', {})
  })
  await navStep('23 go songinfo2', function () {
    go('songinfo', {})
  })
  navStack('deep-full') // 15 层

  // 逐个 close 回收到 5 层；每次关的都是当前栈顶，关完记一次栈快照（PC 侧逐条断言）
  const DEEP_CLOSE = [
    'songinfo2',
    'songinfo',
    'artist2',
    'artist',
    'album2',
    'album',
    'list5',
    'list4',
    'list3',
    'list2'
  ]
  for (let i = 0; i < DEEP_CLOSE.length; i++) {
    const key = DEEP_CLOSE[i]
    log('navtest', '24 deep-close ' + key + ' begin')
    try {
      /* global $falcon */
      $falcon.closePageByName(key)
      log('navtest', '24 deep-close ' + key + ' ok')
    } catch (e) {
      log('navtest', '24 deep-close ' + key + ' FAIL ' + ((e && e.message) || e))
    }
    await sleep(NAV_STEP_MS)
    navStack('deep-close ' + key)
  }
  navStack('deep-done')

  /* ---------- C. 连点合并（500ms 内同逻辑页 + 同参数只生效一次） ----------
   * C1：同一个 tick 连发两次完全相同的 go()（用户「点一下没反应再点」）→ 第二发应被合并
   *     （dup-ignore 日志），只压一层：push 计数只 +1、page-load 只 +1。
   * C2：同一个 tick 连发两次但参数不同 → 不能误伤，两发都要 push（各占一个槽位）。
   * 说明：本自测各步骤间隔 650ms > DEDUPE_MS(500ms)，其它阶段不会误触发合并。
   */
  await navStep('25 dedupe same params', function () {
    go('list', { kind: 'search', keyword: 'dedupe' })
    go('list', { kind: 'search', keyword: 'dedupe' }) // 同 tick 同参数 → 应被合并
  })
  navStack('after dedupe-same')

  await navStep('26 dedupe diff params', function () {
    go('list', { kind: 'search', keyword: 'dedupe2' })
    go('list', { kind: 'search', keyword: 'dedupe3' }) // 同 tick 但参数不同 → 不能被合并
  })
  navStack('after dedupe-diff')

  /* ---------- D. degrade 路径：槽位耗尽复用最上层同类实例 ----------
   * artist 现 6 槽（artist..artist6）：从当前栈连续 go 7 次（参数各不相同，避免连点合并），
   * 第 7 次应 degrade —— 复用栈里最上层的 artist6（平台即「当前页原地补发 options」，
   * 不销毁任何层），不得出现第 7 个 artist 槽位/实例。
   * 随后 close 最上层 artist6 释放槽位，再 go('artist') 必须恢复 push（artist6 重新入栈）。
   * 最后把本阶段压的 artist 6 层与 C 阶段压的 3 层 list 逐个 close，回到 5 层。
   */
  await navStep('27 go artist1', function () {
    go('artist', { name: 'd1' })
  })
  await navStep('28 go artist2', function () {
    go('artist', { name: 'd2' })
  })
  await navStep('29 go artist3', function () {
    go('artist', { name: 'd3' })
  })
  await navStep('30 go artist4', function () {
    go('artist', { name: 'd4' })
  })
  await navStep('31 go artist5', function () {
    go('artist', { name: 'd5' })
  })
  await navStep('32 go artist6', function () {
    go('artist', { name: 'd6' })
  })
  navStack('after artist6') // 14 层：artist 槽位全满（6 个）
  await navStep('33 go artist7 expect degrade', function () {
    go('artist', { name: 'd7' })
  })
  navStack('after degrade') // 仍 14 层：degrade 复用当前栈顶 artist6，不弹层/不加层
  await navStep('34 close top artist6', function () {
    /* global $falcon */
    $falcon.closePageByName('artist6')
  })
  navStack('after close artist6')
  await navStep('35 go artist recover', function () {
    go('artist', { name: 'd8' })
  })
  navStack('after recover') // artist6 槽位释放后恢复 push

  // 清理：关掉 artist 6 层 + C 阶段 3 层 list，回到 [index,list,playlists,player,queue]
  const TASK4_CLOSE = [
    'artist6',
    'artist5',
    'artist4',
    'artist3',
    'artist2',
    'artist',
    'list4',
    'list3',
    'list2'
  ]
  for (let i = 0; i < TASK4_CLOSE.length; i++) {
    const key = TASK4_CLOSE[i]
    log('navtest', '36 task4-close ' + key + ' begin')
    try {
      /* global $falcon */
      $falcon.closePageByName(key)
      log('navtest', '36 task4-close ' + key + ' ok')
    } catch (e) {
      log('navtest', '36 task4-close ' + key + ' FAIL ' + ((e && e.message) || e))
    }
    await sleep(NAV_STEP_MS)
    navStack('task4-close ' + key)
  }
  navStack('task4-done')
  navTestDone = true
}

/** 在页面 mounted 初始化之后启动（页面会挂两遍：navTestStarted 防重） */
function startNavSelfTest() {
  if (navTestStarted) return
  setTimeout(function () {
    runNavSelfTest()
  }, 600)
}
</script>
