/**
 * 下载活动订阅 mixin —— bindDl + 可见性门控的页面侧接线。
 *
 * 分层：本文件在 ui 轴，**不直接 import services**（R6：ui → services 禁止），下载服务的事件流
 * 由页面注入 `dlApi = { onDl, offDl, dlState }`（download.js 已导出的门面对象）。
 *
 * 语义（省渲染，不省数据）：订阅立刻建立，但回调只在**页面可见**时转给页面；隐藏期间的事件
 * 直接丢，重新可见时用 `dlState()` 补一次最新快照，所以状态不会停在旧值。挂载时也由 bindDl
 * 调一次。bindDl 返回取消订阅函数（直接塞进 beforeDestroy）；取不到页面对象时退化为不门控。
 */
import { bindPageVis } from '../../core/infra/vis.js'

/**
 * @param vm 页面组件实例
 * @param dlApi { onDl, offDl, dlState } —— services/player/download.js 的 `dlApi` 门面
 * @param fn 可见时接收下载活动快照的回调
 */
export function bindDl(vm, dlApi, fn) {
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
  if (!dlApi || typeof dlApi.onDl !== 'function' || typeof dlApi.offDl !== 'function' ||
      typeof dlApi.dlState !== 'function') {
    return function () {}
  }
  const call = function (s) {
    if (!fn) return
    try {
      fn(s)
    } catch (e) {}
  }
  let visible = true
  const off = dlApi.onDl(function (s) {
    if (!visible) return
    call(s)
  })
  const visOff = bindPageVis(vm, function (on) {
    const was = visible
    visible = on
    // 露出时补一次最新快照（隐藏期间的事件已丢弃）
    if (on && !was) call(dlApi.dlState())
  })
  // 挂载时的首帧（等价于各页原来的 this.syncDl(dlState())）
  call(dlApi.dlState())
  return function () {
    try {
      dlApi.offDl(off)
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
