/**
 * 游标加载引擎（列表页「加载更多」的三路形态收口）。
 *
 * 一次 loadMore 调用的分派顺序（list.vue 等列表页共用）：
 *   1. 渲染分片还有余量（shown < 全量视图长度）→ 纯本地展开，不发请求；
 *   2. 全量已在内存（allLoaded）→ 无事可做；
 *   3. kind 有自己的 loadMore handler → 交给 services 层取数（offset / trackIds 两路）。
 *
 * 并发与生命周期守卫在这里统一做：
 *   - loadingMore / _loadingFull 双闸（全量加载与追页不能并发写 songs/shown）；
 *   - loadToken 对不上 = 期间切了列表，回调丢弃；
 *   - _dead = 页面已销毁，一律停。
 */
import { KINDS } from './listkinds.js'

/**
 * list.vue 的 loadMore 主体。返回 true 表示有推进（供 infinite mixin 判断）。
 *
 * @param {*} vm   页面实例（须有 kind/shown/viewAll/allLoaded/loadingMore/_loadToken/_dead）
 * @param {*} ctx  list.vue 传入的上下文（ensureAllSongs 等页面能力，见页面侧组装）
 */
export async function loadMore(vm) {
  if (vm.loadingMore || vm._loadingFull || !vm.hasMore) return false
  // ① 已取回的还有没渲染的：纯本地展开（历史 / 全量排序后的分片），不发请求
  //    步长用页面给的 autoBatch（= ui/paging.js 的 AUTO_BATCH；UI 常量不进 services）
  const batch = vm.autoBatch || 20
  if (vm.shown < vm.viewAll.length) {
    vm.shown = Math.min(vm.shown + batch, vm.viewAll.length)
    return true
  }
  // ② 全量已在内存：没有更多
  if (vm.allLoaded) return false
  const def = KINDS[vm.kind]
  if (!def || !def.loadMore) return false // 搜索/历史/推荐不翻页
  const loadToken = vm._loadToken
  vm.loadingMore = true
  try {
    await def.loadMore(vm)
    return true
  } catch (e) {
    if (vm.showToast) vm.showToast('加载更多失败：' + ((e && e.message) || e))
    if (vm.log) vm.log('list', '加载更多失败 ' + ((e && e.message) || e))
    return false
  } finally {
    vm.loadingMore = false
  }
}
