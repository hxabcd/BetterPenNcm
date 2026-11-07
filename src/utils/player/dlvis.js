/**
 * 下载活动订阅的「可见性门控」封装 —— 给页面用的一行式订阅入口。
 *
 * 背景：`onDl(fn)` 是下载引擎的广播（进度节流 ~400ms、结构变化立即发）。页面被上层页盖住后
 * 订阅仍在跑，每个回调都会写 data 触发一次重渲染；而这些页面显示的无非是顶栏副题里的
 * 「下载中 k/N」——看不见的时候全是白花的帧预算。
 *
 * 语义（省渲染，不省数据）：
 *   - 订阅立刻建立，回调只在**页面可见**时转给页面；
 *   - 隐藏期间的事件直接丢（页面看不到），重新可见时用 `dlState()` 补一次最新快照，
 *     所以状态不会停在旧值；
 *   - 挂载时也由本函数调一次（替代页面原来手写的 `this.syncDl(dlState())`）。
 *
 * 返回取消订阅函数（callable，直接塞进 beforeDestroy）。
 * 取不到页面对象时退化为「不门控」（等同原来的裸订阅），功能不受影响。
 */
import { onDl, offDl, dlState } from './download.js'
import { bindPageVis } from '../ui/vis.js'

export function bindDl(vm, fn) {
  const call = function (s) {
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
