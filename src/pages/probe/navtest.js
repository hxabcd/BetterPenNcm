// 导航层自测：验证 core/infra/nav.js 的「逻辑页 → 实例槽位」是否得到标准 push/pop，
// 以及平台「命中栈内页」回退、槽位耗尽 degrade、连点合并三类边界。
// 被导航到的页面可能未登录 / 无网络而加载失败，与导航层无关：只以 `[nav]` 日志为断言依据；
// 每步独立 try/catch，失败只记日志、不中断后续步骤。
// 页面会挂两遍：模块级 navTestStarted 防重。PC 侧断言见 scripts/nav_selftest.sh。
import { log } from '../../core/infra/log.js'
import { sleep } from '../../core/infra/util.js'
import { go, stackKeys } from '../../core/infra/nav.js'

// 页面会挂两遍：模块级 navTestStarted 防重；navTestDone 供页面判断自测是否已跑完
// （自测含深度压力，页面退出要等它，见 probe.vue 的 waitNavTestThenClose）。
let navTestStarted = false
let navTestDone = false

// 自测已开始但还没跑完 —— 页面据此推迟退出。
export function navTestPending() {
  return navTestStarted && !navTestDone
}

const NAV_STEP_MS = 650 

// 执行一步导航并在前后各记一条 [navtest]；异常只记 FAIL，不中断后续步骤。
// ms 缺省用 NAV_STEP_MS（给平台派发页面 load/unload 生命周期留时间）；
// 需要长时间保持某栈状态的步骤传更大值。
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

// 记录当前槽位栈（nav.js 的实例存活记账）
function navStack(tag) {
  log('navtest', tag + ' stack=' + JSON.stringify(stackKeys()))
}

// 深度压力段：把页面栈推到 15 层，确认 page-load 齐全、无非预期 page-unload（平台页栈上限），
// 再逐个 close 回收到 5 层且每步栈快照正确；12 层时停 7 秒供 PC 侧采样内存/截图。
// 连点合并段：同 tick 同参数只生效一次；同 tick 参数不同必须两次都生效。
// degrade 段：artist 6 个槽位压满后再 go 应复用最上层同类实例（不新增第 7 个槽位），
// 关掉最上层释放槽位后再 go 必须恢复 push。
async function runNavSelfTest() {
  if (navTestStarted) return
  navTestStarted = true
  navStack('start')

  await navStep('1 go list a', function () {
    go('list', { kind: 'search', keyword: 'a' })
  })
  await navStep('2 go list b', function () {
    go('list', { kind: 'search', keyword: 'b' })
  })
  navStack('after list2')

  await navStep('3 close list2', function () {
    /* global $falcon */
    $falcon.closePageByName('list2')
  })
  navStack('after close list2')

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

  await navStep('7 go player', function () {
    go('player', {})
  })
  await navStep('8 go player again', function () {
    go('player', {})
  })
  navStack('after player2')

  await navStep('9 go queue', function () {
    go('queue', {})
  })
  await navStep('10 go queue again', function () {
    go('queue', {})
  })
  navStack('done')

  await navStep('11 go player from deep stack', function () {
    go('player', {})
  })
  navStack('after fallback')
  await navStep('12 requeue after fallback', function () {
    go('queue', {})
  })
  navStack('after requeue')

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
  navStack('deep12') 
  await navStep('20 deep12 hold', function () {}, 7000) 
  await navStep('21 go artist2', function () {
    go('artist', {})
  })
  await navStep('22 go songinfo', function () {
    go('songinfo', {})
  })
  await navStep('23 go songinfo2', function () {
    go('songinfo', {})
  })
  navStack('deep-full') 

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

  await navStep('25 dedupe same params', function () {
    go('list', { kind: 'search', keyword: 'dedupe' })
    go('list', { kind: 'search', keyword: 'dedupe' }) 
  })
  navStack('after dedupe-same')

  await navStep('26 dedupe diff params', function () {
    go('list', { kind: 'search', keyword: 'dedupe2' })
    go('list', { kind: 'search', keyword: 'dedupe3' }) 
  })
  navStack('after dedupe-diff')

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
  navStack('after artist6') 
  await navStep('33 go artist7 expect degrade', function () {
    go('artist', { name: 'd7' })
  })
  navStack('after degrade') 
  await navStep('34 close top artist6', function () {
    /* global $falcon */
    $falcon.closePageByName('artist6')
  })
  navStack('after close artist6')
  await navStep('35 go artist recover', function () {
    go('artist', { name: 'd8' })
  })
  navStack('after recover') 

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

// 在页面 mounted 初始化之后启动（页面会挂两遍：navTestStarted 防重）
export function startNavSelfTest() {
  if (navTestStarted) return
  setTimeout(function () {
    runNavSelfTest()
  }, 600)
}
