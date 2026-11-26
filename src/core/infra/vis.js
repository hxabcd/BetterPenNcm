
// 页面可见性记账。
// 可见性事实由 core/infra/nav.js 在页面生命周期里写入（load/show/hide/unload），UI 组件只是消费者；
// 放在 infra 是因为 ui 层会让 infra→ui 反向依赖（分层 R6），ui/vis.js 只保留转发导出。
// 语义：
//   - 每个平台页面对象一个条目 { page, vis, why, subs }；未知页面按可见处理（fail-open）。
//   - 页面被上层页盖住时平台不会卸载它，订阅仍在跑；隐藏期间的回调应被丢弃以省渲染。
//   - bindPageVis(vm, fn) 绑定「组件跟随所属页面可见性」，立即回调一次，之后每次变化再回调；
//     同一 vm 重复绑定会先释放上一组（页面会挂两遍）
import { log } from './log.js'

// 条目：{ page, vis, why, subs }（page 是平台给的页面对象）
const ENTRIES = []

// 诊断日志只打前几条，别刷屏
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
      // 订阅回调抛错不能影响页面生命周期分发
      diag('可见性回调异常: ' + ((err && err.message) || String(err)))
    }
  }
}

// 页面退栈：摘掉条目（订阅者随组件销毁自己取消，这里只释放引用）
export function dropPage(page) {
  const i = page ? ENTRIES.indexOf(findEntry(page)) : -1
  if (i >= 0) ENTRIES.splice(i, 1)
}

// 页面当前是否可见；未知页面按可见处理（fail-open）
export function isVisible(page) {
  if (!page) return true
  const e = findEntry(page)
  return !e || e.vis
}

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

// 组件实例 → 它所属的页面对象。
// 页面根实例自己有 `$page`；页面内的子组件要靠 `$root`（每个页面是独立的 Vue 实例，
// 子组件的 $root 就是页面根实例）。取不到就返回 null，由调用方按「可见」处理
export function pageOf(vm) {
  try {
    const root = vm && vm.$root
    if (root && root.$page) return root.$page
    if (vm && vm.$page) return vm.$page
  } catch (e) {}
  return null
}

// 绑定「组件跟随其页面可见性」：立即回调一次当前值，之后每次变化再回调；返回取消订阅函数
// （可以直接塞进 beforeDestroy）。解析不到页面时不订阅、只回调一次 true ——
// 功能不因可见性通道缺失而失效
export function bindPageVis(vm, fn) {
  // 页面会挂两遍：mounted 再跑一次时 `this._visOff = bindPageVis(...)` 只覆盖字段，
  // 上一组订阅就成了没人释放的孤儿（每次可见性变化还在调旧回调）。这里先释放同一 vm 上的
  // 上一组，让 bindPageVis 自己幂等，不依赖每个调用点去写守卫（漏一个就泄漏一份）
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
