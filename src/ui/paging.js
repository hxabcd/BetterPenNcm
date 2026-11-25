/**
 * 列表分页的公共口径 —— 平台一次渲染 ≤50 行（平台坑 5），长列表一律「分片渲染」。
 *
 * 为什么要有这个文件：曲目列表 / 本地歌手 / 本地专辑 / 歌单索引 / 队列各页原来
 * 各自写一份 `const PAGE = 50` 与「加载更多（还有 N 首）」文案，批大小和句式容易漂移。
 * PAGE_* 是**首屏**批量（快速绘制）；AUTO_BATCH 是滚到底自动续页（ui/mixins/infinite.js）
 * 与手动点「加载更多」的**增量** —— 增量比首屏小，滚到就出、等待更短。
 *
 * ⚠ 分页是**渲染分片**，不是数据分页：本地列表本来就是全量在内存里，
 *   网络列表则按 cursor 继续取（见 list.vue 的 cursor / loadMore）。
 */
import { vhPx } from '../core/platform/viewport.js'


/** 歌曲行（SongRow，23vh）：首屏 50 行 */
export const PAGE_SONG = 50

/** 较高的行（ArtistRow 32vh / 索引类行）：首屏 40 行 */
export const PAGE_ROW = 40

/** 卡片网格（4 张一行）：首屏 40 张 = 10 行 */
export const PAGE_CARD = 40

/** 播放队列页：50 行一段（与歌曲行同高） */
export const PAGE_QUEUE = 50

/** 滚到底自动续页 / 手动「加载更多」每次新增的行数（比首屏小，减少等待） */
export const AUTO_BATCH = 20

/* 自动续页判定「内容底部」用的行高估算（px）。取各组件 CSS 的保守下界：
   估算偏小只会更早预加载，不会漏触发；各页用 infiniteBottomPx 乘已渲染行数。
   对应实现：SongRow 23vh、ArtistRow 32vh、LibraryRow 28vh；卡片类 PlaylistCard 36vh /
   AlbumCard 40vh 用统一 34vh 近似（偏小、安全）。

   ⚠ 按**本机型**的 vh 换算（S7 2.4px / X3S·X5 2.54px）——写死 2.4 会在 800×254 上
   把「内容底部」低估 6%，滚到底的自动续批会晚一截才触发。 */
export const ROW_PX_SONG = 23 * vhPx()
export const ROW_PX_TALL = 32 * vhPx()
export const ROW_PX_LIB = 28 * vhPx()
export const ROW_PX_CARD = 34 * vhPx()

/**
 * 搜索结果每类取回条数。搜索结果**不翻页**（老端点 offset 对非单曲类不可靠，
 * 见 list.vue 的说明）；50 = 一批的渲染预算，也让单曲类一屏能翻更久。
 */
export const SEARCH_LIMIT = 50

/**
 * 「加载更多」统一文案：还有剩余就带上数量，没有就只写「加载更多」。
 * 例：moreText(12, '首') → '加载更多（还有 12 首）'；moreText(0, '首') → '加载更多'
 */
export function moreText(n, unit) {
  const c = Math.max(0, Number(n) || 0)
  if (!c) return '加载更多'
  return '加载更多（还有 ' + c + (unit ? ' ' + unit : '') + '）'
}
