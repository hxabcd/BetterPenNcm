/**
 * 列表分页的公共口径 —— 平台一次渲染 ≤50 行（平台坑 5），长列表一律「分片渲染」。
 *
 * 为什么要有这个文件：曲目列表 / 本地歌手 / 本地专辑 / 歌单索引 / 队列各页原来
 * 各自写一份 `const PAGE = 50` 与「加载更多（还有 N 首）」文案，批大小和句式容易漂移。
 * 批大小按**行高**取不同值（歌曲行 23vh、ArtistRow 32vh、卡片网格 4 张一行），
 * 但都从这里取，改口径只改这一处。
 *
 * ⚠ 分页是**渲染分片**，不是数据分页：本地列表本来就是全量在内存里，
 *   网络列表则按 cursor 继续取（见 list.vue 的 cursor / loadMore）。
 */

/** 歌曲行（SongRow，23vh）：首屏与每次「加载更多」各 50 行 */
export const PAGE_SONG = 50

/** 较高的行（ArtistRow 32vh / 索引类行）：40 行 */
export const PAGE_ROW = 40

/** 卡片网格（4 张一行）：40 张 = 10 行 */
export const PAGE_CARD = 40

/** 播放队列页：50 行一段（与歌曲行同高） */
export const PAGE_QUEUE = 50

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
