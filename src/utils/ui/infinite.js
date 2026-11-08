/**
 * 长列表「滚到底自动续页」。
 *
 * 平台一次渲染 ≤50 行（平台坑 5），各长列表页因此都把内存里的全量数据切成
 * 「前 N 行」渲染，底部留一行「加载更多」。本 mixin 把「滚到接近底部」也接到
 * 同一个 loadMore() 上：用户不用再找按钮点，往下滚就继续出内容。
 *
 * 判定只用队列页实测过的滚动位移 e.contentOffset.y（原生 px、往下滚递增，
 * 见 queue.vue / docs/运行时API参考.md）。「内容底部」优先取页面自己算的
 * infiniteBottomPx（已渲染行数 × 行高，代码可确定），事件若带 contentSize
 * 则用它兜底增强；两者都拿不到就**不自动触发**（fail-open），底部「加载更多」
 * 按钮仍是完整兜底 —— 自动加载是增强，不是依赖。
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
 *   // 页面须有 computed hasMore 与 methods loadMore（各页本来就有）；
 *   // 须提供 computed infiniteBottomPx：已渲染内容的估算底部 px；
 *   // 可选覆盖 infiniteViewportPx（内容区视口高，默认 200）。
 */

/** 自动触发后的冷却：scroll 事件高频，挡住同一波滚动里重复触发（不用 Date.now） */
const COOL_MS = 300
/** 距底部多少 px 开始预加载，让下一批在滚到尽头前就铺好 */
const NEAR_PX = 160
/** 内容区视口高的兜底值（设备 240 高，去掉顶栏约 40）；页面可用 infiniteViewportPx 覆盖 */
const DEFAULT_VIEWPORT = 200

/**
 * 取当前滚动内容的底部像素位置。页面估算优先、事件字段兜底，都取不到返回 null。
 * 单独导出便于 perf_selftest 对降级逻辑做约束测试。
 */
export function contentBottom(e, vm) {
  const est = Number(vm && vm.infiniteBottomPx)
  if (est === est && est > 0) return est
  const cs = e && e.contentSize
  let h = cs ? Number(cs.height != null ? cs.height : cs.h) : NaN
  if (!(h === h) || h <= 0) h = Number(e && e.contentHeight)
  if (h === h && h > 0) return h
  return null
}

/** 纯判定：这一帧滚动是否应触发一次续页。导出供自检脚本直接用。 */
export function shouldLoad(e, vm, hasMore) {
  if (!hasMore) return false
  const c = e && e.contentOffset
  const y = c ? Number(c.y != null ? c.y : c.top) : NaN
  if (!(y >= 0)) return false // 拿不到滚动位移（字段形态不符）→ 不自动触发
  const bottom = contentBottom(e, vm)
  if (bottom == null) return false // 无法估算内容底部 → 退回按钮翻页
  const vp = Number(vm && vm.infiniteViewportPx) || DEFAULT_VIEWPORT
  return y + vp + NEAR_PX >= bottom // 接近底部
}

export const infiniteScrollMixin = {
  data() {
    return { _infCool: false }
  },
  methods: {
    /** <scroller> 的 @scroll 入口；页面不要实现同名方法 */
    onInfiniteScroll(e) {
      if (this._infCool) return
      if (!shouldLoad(e, this, this.hasMore)) return
      this._infCool = true
      const self = this
      setTimeout(function () { self._infCool = false }, COOL_MS)
      // loadMore 后内容变长（infiniteBottomPx 随之增大），y 不变时判定自然不再成立，
      // 只有用户继续往下滚才会再次触发 —— 不会因一次触底连加好几批。
      this.loadMore()
    }
  }
}
