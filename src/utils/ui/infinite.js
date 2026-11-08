/**
 * 长列表「滚到底自动续页」。
 *
 * 平台一次渲染 ≤50 行（平台坑 5），各长列表页因此都把内存里的全量数据切成
 * 「前 N 行」渲染，底部留一行「加载更多」。本 mixin 把「滚到接近底部」也接到
 * 同一个 loadMore() 上：用户不用再找按钮点，往下滚就继续出内容。
 *
 * 判定只用队列页实测过的滚动位移 e.contentOffset.y（原生 px、往下滚递增，
 * 见 queue.vue / docs/运行时API参考.md）。「内容底部」取页面自己算的
 * infiniteBottomPx（已渲染行数 × 行高，代码可确定）；事件若带 contentSize
 * 且更大则取较大者（估算漏算了 hero 等固定内容）。取不到位移/底部就
 * **不自动触发**（fail-closed 降级），底部「加载更多」按钮仍是完整兜底 ——
 * 自动加载是增强，不是依赖。
 *
 * 两道门槛防「短列表自动乱续」：内容必须超过一屏（bottom > 视口高）、
 * 且用户确实往下滚了（y > 0）。否则 hasMore 可能因「服务端还有更多」为真，
 * 而当前内容根本没到能滚的底部 —— 那应由用户点按钮决定，不该自动拉。
 *
 * 自动与手动共用页面已有的 loadMore()。纯本地渲染分片的增量步长由 paging.js
 * 的 AUTO_BATCH 控制（20 行，比首屏 PAGE 小），滚到就出、等待更短；网络页的
 * 取数批量保持不变（游标 / trackIds 不变量见 list.vue）。
 *
 * 不接入的页：queue（以当前曲为锚定窗口、前向展开要滚动补偿）、dlqueue
 * （随下载活动变化的多段列表）、artist（热门固定 10 首、离线分片是次要路径且
 * 方法命名不同）—— 自动续页会与它们的窗口/锚定逻辑打架，保留手动翻页。
 *
 * 用法：
 *   <scroller class="..." @scroll="onInfiniteScroll">
 *   import { infiniteScrollMixin } from '../../utils/ui/infinite.js'
 *   mixins: [..., infiniteScrollMixin]
 *   // 页面须有 computed/data hasMore 与 methods loadMore（各页本来就有）；
 *   // 须提供 computed infiniteBottomPx：已渲染内容的估算底部 px；
 *   // 可选覆盖 infiniteViewportPx（内容区视口高，默认 200）。
 */

/** 距底部多少 px 开始预加载，让下一批在滚到尽头前就铺好 */
const NEAR_PX = 160
/** 内容区视口高的兜底值（设备 240 高，去掉顶栏约 40）；页面可用 infiniteViewportPx 覆盖 */
const DEFAULT_VIEWPORT = 200
/** loadMore 完成（或页面判定无需加载）后解锁的冷却：挡住同一波滚动的重复事件 */
const COOL_MS = 300

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
