

// 列表分页的公共口径：平台一次渲染 ≤50 行（平台坑 5），长列表一律分片渲染。
// 分片是**渲染预算**，不是数据分页——本地列表本来就全量在内存，网络列表按 cursor 继续取。
import { vhPx } from '../core/platform/viewport.js'

// 歌曲行（SongRow 23vh）：首屏 50 行 = 平台单次渲染上限
export const PAGE_SONG = 50

// 较高的行（ArtistRow 32vh 等）：首屏 40 行
export const PAGE_ROW = 40

// 卡片网格（4 张一行）：首屏 40 张 = 10 行
export const PAGE_CARD = 40

// 播放队列页：50 行一段（与歌曲行同高）
export const PAGE_QUEUE = 50

// 滚到底自动续页 / 手动「加载更多」的增量：比首屏小，滚到就出、等待更短
export const AUTO_BATCH = 20

// 自动续页判定「内容底部」用的行高估算（px）：取各组件 CSS 的保守下界，
// 估算偏小只会更早预加载、不会漏触发；卡片类（PlaylistCard 36vh / AlbumCard 40vh）统一按 34vh 近似。
// ⚠ vh 换算按机型（S7 2.4px / X3S·X5 2.54px）——写死 2.4 会在 800×254 上把内容底部低估 6%，
//   滚到底的自动续批会晚一截才触发。
export const ROW_PX_SONG = 23 * vhPx()
export const ROW_PX_TALL = 32 * vhPx()
export const ROW_PX_LIB = 28 * vhPx()
export const ROW_PX_CARD = 34 * vhPx()

// 搜索结果每类取回条数。搜索结果不翻页（老端点 offset 对非单曲类不可靠）；
// 50 = 一批的渲染预算，也让单曲类一屏能翻更久。
export const SEARCH_LIMIT = 50

export function moreText(n, unit) {
  const c = Math.max(0, Number(n) || 0)
  if (!c) return '加载更多'
  return '加载更多（还有 ' + c + (unit ? ' ' + unit : '') + '）'
}
