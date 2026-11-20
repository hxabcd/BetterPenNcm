/**
 * 页面可见性——「这个页面当前有没有被上层页面盖住」的唯一真源。
 *
 * 为什么需要：页面被 navTo 压栈后**不会卸载**（平台只销毁被弹掉的页），组件树、播放器订阅、
 * 下载订阅、歌词时钟都还在跑。播放页与队列页每个 500ms 的 tick 都会触发一次整页重渲染，
 * 主页还有歌词/进度子组件与下载进度订阅 —— 这些开销在页面看不见时全是白花的帧预算。
 *
 * 信号从哪来：`App.onPageLifeCycle` 的 `{ page, lifeCycle }`（见 utils/nav.js 的记账），
 * 真实派发序列是 `load → show`，被上层页盖住时 `hide`，重新露出 `show`，退栈 `unload`。
 *
 * 失效策略（重要）：**默认可见（fail-open）**。
 *   - 只有明确收到 `hide` 才置为不可见；未知页面一律当可见。
 *   - 平台若在某些路径上只派发 `hide` 不派发对应的 `show`，退栈时 nav.js 会把新的栈顶页
 *     重新标为可见（why = 'top'）—— 可见性只用来**省渲染**，用错方向的代价必须是
 *     「少省一点」，不能是「页面卡住不刷新」。
 *
 * 存储用数组而不是 WeakMap：本工程运行在 QuickJS 上，全仓库没有用过 WeakMap/Map 这套
 * 容器（能力未在真机验证）；页面对象本身随平台销毁，这里在 unload 时顺手摘掉条目即可。
 *
 * 用法（页面与页面内组件都适用，组件里 `this.$page` 不可靠，统一从 `$root` 取）：
 *   import { bindPageVis } from '../../utils/ui/vis.js'
 *   mounted() { this._visOff = bindPageVis(this, function (on) { ... }) }
 *   beforeDestroy() { if (this._visOff) this._visOff() }
 * 回调会被**立即调用一次**（当前真值），之后每次可见性变化再调。
 */
import { log } from '../core/infra/log.js'

/** 条目：{ page, vis, why, subs }（page 是平台给的页面对象） */
const ENTRIES = []

/** 诊断日志只打前几条，别刷屏 */
let logBudget = 4

function diag(msg) {
  if (logBudget <= 0) return
  logBudget--
  log('vis', msg)
}

function findEntry(page) {
  if (!page) return null
  for (let i = 0; i < ENTRIES.length; i++) if (ENTRIES[i].page === page) return ENTRIES[i]
  return null
}

function entryOf(page) {
  let e = findEntry(page)
  if (!e) {
    e = { page: page, vis: true, why: 'init', subs: [] }
    ENTRIES.push(e)
  }
  return e
}

/** 记录一次可见性变化（由 utils/nav.js 的生命周期记账调用） */
export function markVisible(page, vis, why) {
  if (!page) return
  const e = entryOf(page)
  const next = !!vis
  const changed = e.vis !== next
  e.vis = next
  e.why = why
  if (!changed) return
  diag('可见性 ' + String(page.$pageName || '?') + ' -> ' + (next ? '可见' : '隐藏') + '（' + why + '）')
  const subs = e.subs.slice()
  for (let i = 0; i < subs.length; i++) {
    try {
      subs[i](next)
    } catch (err) {
      // 订阅回调抛错不能影响页面生命周期分发（同 app.js 的异常转日志口径）
      diag('可见性回调异常: ' + ((err && err.message) || String(err)))
    }
  }
}

/** 页面退栈：摘掉条目（订阅者随组件销毁自己取消，这里只释放引用） */
export function dropPage(page) {
  const i = page ? ENTRIES.indexOf(findEntry(page)) : -1
  if (i >= 0) ENTRIES.splice(i, 1)
}

/** 页面当前是否可见；未知页面按可见处理（fail-open） */
export function isVisible(page) {
  if (!page) return true
  const e = findEntry(page)
  return !e || e.vis
}

/** 订阅某个页面的可见性变化；返回取消订阅函数 */
export function onVisChange(page, fn) {
  if (!page) {
    try {
      fn(true)
    } catch (e) {}
    return function () {}
  }
  const e = entryOf(page)
  e.subs.push(fn)
  return function () {
    const cur = findEntry(page)
    if (!cur) return
    const i = cur.subs.indexOf(fn)
    if (i >= 0) cur.subs.splice(i, 1)
  }
}

/**
 * 组件实例 → 它所属的页面对象。
 * 页面根实例自己有 `$page`；页面内的子组件要靠 `$root`（每个页面是独立的 Vue 实例，
 * 子组件的 $root 就是页面根实例）。取不到就返回 null，由调用方按「可见」处理。
 */
export function pageOf(vm) {
  try {
    const root = vm && vm.$root
    if (root && root.$page) return root.$page
    if (vm && vm.$page) return vm.$page
  } catch (e) {}
  return null
}

/**
 * 绑定「组件跟随其页面可见性」：立即回调一次当前值，之后每次变化再回调。
 * 返回取消订阅函数（可以直接塞进 beforeDestroy）。
 * 解析不到页面时不订阅、只回调一次 true —— 功能不因可见性通道缺失而失效。
 */
export function bindPageVis(vm, fn) {
  /* 页面会挂两遍（平台坑 6）：mounted 再跑一次时 `this._visOff = bindPageVis(...)` 只会覆盖字段，
     上一组订阅就成了没人释放的孤儿 —— 每次可见性变化都还在调旧回调。这里先释放同一 vm 上的
     上一组，让 bindPageVis 自己幂等，不依赖每个调用点去写守卫（漏一个就泄漏一份）。 */
  if (vm && typeof vm._visOff === 'function') {
    try {
      vm._visOff()
    } catch (e) {}
    vm._visOff = null
  }
  const page = pageOf(vm)
  if (!page) {
    diag('取不到页面对象（按可见处理）：' +
      String((vm && vm.$options && vm.$options.name) || '?'))
    try {
      fn(true)
    } catch (e) {}
    return function () {}
  }
  const off = onVisChange(page, fn)
  try {
    fn(isVisible(page))
  } catch (e) {}
  return off
}
