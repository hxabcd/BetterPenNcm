/**
 * 下载活动订阅 mixin —— bindDl + 可见性门控的页面侧接线（S3 从 services/player/dlvis.js
 * 改造而来：UI 订阅职责归 ui 层，services 只发布事件流，不再感知 UI）。
 *
 * 背景：`onDl(fn)` 是下载引擎的广播（进度节流 ~400ms、结构变化立即发）。页面被上层页盖住后
 * 订阅仍在跑，每个回调都会写 data 触发一次重渲染；而这些页面显示的无非是顶栏副题里的
 * 「下载中 k/N」——看不见的时候全是白花的帧预算。
 *
 * 用法（页面）：
 *   mixins: [..., dlSubscriberMixin]        // 依赖 pageFrameMixin 的 beforeDestroy 时序
 *   this._dlOff = bindDl(this, function (s) { self.syncDl(s) })
 *   beforeDestroy() { if (this._dlOff) this._dlOff() }
 *
 * 语义（省渲染，不省数据）：
 *   - 订阅立刻建立，回调只在**页面可见**时转给页面；
 *   - 隐藏期间的事件直接丢（页面看不到），重新可见时用 `dlState()` 补一次最新快照，
 *     所以状态不会停在旧值；
 *   - 挂载时也由 bindDl 调一次（替代页面原来手写的 `this.syncDl(dlState())`）。
 *
 * bindDl 返回取消订阅函数（callable，直接塞进 beforeDestroy）。
 * 取不到页面对象时退化为「不门控」（等同裸订阅），功能不受影响。
 */
import { onDl, offDl, dlState } from '../services/player/download.js'
import { log } from '../../core/infra/log.js'

/* ---- 页面可见性（原 ui/vis.js 全文并入，见文件尾）---- */

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


export function bindDl(vm, fn) {
  /* 页面会挂两遍（平台坑 6）：mounted 再跑一次时，`this._dlOff = bindDl(...)` 只会覆盖字段，
     上一组的 onDl 订阅与可见性订阅就成了没人释放的孤儿 —— 每次 400ms 广播都还在往这个
     vm 的旧回调里灌数据。这里先释放同一 vm 上的上一组，让 bindDl 自己幂等，
     不依赖每个调用点去写守卫（漏一个就泄漏一份）。 */
  if (vm && typeof vm._dlOff === 'function') {
    try {
      vm._dlOff()
    } catch (e) {}
    vm._dlOff = null
  }
  const call = function (s) {
    if (!fn) return
    try {
      fn(s)
    } catch (e) {}
  }
  let visible = true
  const off = onDl(function (s) {
    if (!visible) return
    call(s)
  })
  const visOff = bindPageVis(vm, function (on) {
    const was = visible
    visible = on
    // 露出时补一次最新快照（隐藏期间的事件已丢弃）
    if (on && !was) call(dlState())
  })
  // 挂载时的首帧（等价于各页原来的 this.syncDl(dlState())）
  call(dlState())
  return function () {
    try {
      offDl(off)
    } catch (e) {}
    visOff()
    fn = null
  }
}

export const dlSubscriberMixin = {
  beforeDestroy() {
    // bindDl 的订阅不随 mixin 自动退（页面 mounted 里自己拿 _dlOff）——
    // 这里兜一层：页面忘了写 if (this._dlOff) this._dlOff() 也不泄漏
    if (this._dlOff) {
      try {
        this._dlOff()
      } catch (e) {}
      this._dlOff = null
    }
  }
}
