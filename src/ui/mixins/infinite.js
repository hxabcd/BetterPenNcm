/**
 * 长列表「滚到底自动续页」：把「滚到接近底部」接到页面已有的 loadMore() 上。
 *
 * 判据：滚动位移 e.contentOffset.y（原生 px、往下滚递增，队列页实测）与页面自己算的
 * infiniteBottomPx（已渲染行数 × 行高）；取不到位移/底部就**不自动触发**（fail-closed），
 * 底部「加载更多」按钮仍是完整兜底 —— 自动加载是增强，不是依赖。内容未超过一屏、
 * 或用户没真的往下滚，也不触发（服务端「还有更多」不代表当前已滚到底）。
 * 本地分片的增量步长由 paging.js 的 AUTO_BATCH 控制，与网络取数批量无关。
 *
 * 不接入的页：queue（以当前曲为锚定窗口）、dlqueue（随下载活动变化的多段列表）、
 * artist（热门固定 10 首、方法命名不同）—— 自动续页会与它们的窗口/锚定逻辑打架。
 */

/** 距底部多少 px 开始预加载，让下一批在滚到尽头前就铺好 */
const NEAR_PX = 160
/** 内容区视口高的兜底值（设备 240 高，去掉顶栏约 40）；页面可用 infiniteViewportPx 覆盖 */
const DEFAULT_VIEWPORT = 200
/** loadMore 完成（或页面判定无需加载）后解锁的冷却：挡住同一波滚动的重复事件 */
const COOL_MS = 300
/** 最长锁定：网络 Promise 挂起不 settle 时也要兜底解锁，避免自动续页永久失效 */
const MAX_LOCK_MS = 5000

/**
 * 取当前滚动内容的底部像素位置：页面估算与事件 contentSize 取较大者，
 * 都取不到返回 null。单独导出便于 perf_selftest 对降级逻辑做约束测试。
 */
export function contentBottom(e, vm) {
  const est = Number(vm && vm.infiniteBottomPx)
  const a = est === est && est > 0 ? est : 0
  const cs = e && e.contentSize
  let h = cs ? Number(cs.height != null ? cs.height : cs.h) : NaN
  if (!(h === h) || h <= 0) h = Number(e && e.contentHeight)
  const b = h === h && h > 0 ? h : 0
  const m = Math.max(a, b)
  return m > 0 ? m : null
}

/** 页面视口高（0/非法值退回默认，避免静默吞掉 0 后除零） */
function viewport(vm) {
  const v = Number(vm && vm.infiniteViewportPx)
  return v === v && v > 0 ? v : DEFAULT_VIEWPORT
}

/**
 * 纯判定：这一帧滚动是否应触发一次续页。导出供自检脚本直接用。
 * 门槛顺序：hasMore → 滚动位移合法且 y>0 → 内容底部可估 → 内容超过一屏 → 接近底部。
 */
export function shouldLoad(e, vm, hasMore) {
  if (!hasMore) return false
  const c = e && e.contentOffset
  const y = c ? Number(c.y != null ? c.y : c.top) : NaN
  if (!(y > 0)) return false // 拿不到位移、或在顶部/回弹 → 不自动触发
  const bottom = contentBottom(e, vm)
  if (bottom == null) return false // 无法估算内容底部 → 退回按钮翻页
  const vp = viewport(vm)
  if (bottom <= vp) return false // 内容不足一屏：没有「滚到底」这回事，交给按钮
  return y + vp + NEAR_PX >= bottom // 接近底部
}

export const infiniteScrollMixin = {
  // 实例普通属性，不进 data：_ 前缀在 Vue2 不被代理，且冷却标志不需要响应式。
  // 页面会挂两遍（平台坑 6），这里的 created/beforeDestroy 均幂等。
  created() {
    this._infCool = false
    this._infTimer = null
  },
  beforeDestroy() {
    if (this._infTimer) { clearTimeout(this._infTimer); this._infTimer = null }
  },
  methods: {
    /** <scroller> 的 @scroll 入口；页面不要实现同名方法 */
    onInfiniteScroll(e) {
      if (this._infCool) return
      if (!shouldLoad(e, this, this.hasMore)) return
      this._infCool = true
      const self = this
      // 最长锁定兜底：网络 Promise 永不 settle 时也要解锁，否则自动续页永久失效
      //（此期间底部「加载更多」按钮仍可用）。unlock 幂等，先到者生效。
      if (self._infTimer) clearTimeout(self._infTimer)
      self._infTimer = setTimeout(function () {
        self._infTimer = null
        self._infCool = false
      }, MAX_LOCK_MS)
      // 解锁挂在 loadMore 走完这一轮之后（同步或 Promise 均可），冷却只是兜底，
      // 防止网络在飞/小增量续批时同一 y 反复触发。
      const unlock = function () {
        if (self._infTimer) clearTimeout(self._infTimer)
        self._infTimer = setTimeout(function () {
          self._infTimer = null
          self._infCool = false
        }, COOL_MS)
      }
      let r
      try {
        r = this.loadMore()
      } catch (e2) {
        unlock()
        return
      }
      // loadMore 返回 Promise（网络页）时等它落地再解锁；同步页下一微任务解锁。
      if (r && typeof r.then === 'function') r.then(unlock, unlock)
      else unlock()
    }
  }
}
