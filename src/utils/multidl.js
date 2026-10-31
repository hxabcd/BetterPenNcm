/**
 * 曲目列表页「多选下载」的公共小工具（album / artist / list 三处共用）
 *
 * 三页都要「多选 → 下载选中」；状态机（选中集合、rail、两次点按确认）维护在各页自己的
 * data 里（本平台对 mixin 没有先例，不引入），这里只放**纯函数**：
 *   - 选中集合的增删查（**返回新数组**：平台不认动态 key，选中集合一律整体替换，坑 4）
 *   - 顶栏副题的「下载中 k/N · NN%」文案（取消的项也算 k，否则永远到不了 N）
 *   - 下载结果 / 开始的 toast 文案（三页口径一致）
 *   - 空间预检（估算见 download.js 的 estimateBytes；free=0 = 读不到 df，不做判断）
 */
import { estimateBytes } from './player/download.js'
import { freeBytes } from './player/cache.js'
import { currentQuality, qualityInfo } from './player/quality.js'

/* ---------------- 选中集合 ---------------- */

export function selHas(ids, id) {
  return ids.indexOf(id) >= 0
}

/** 勾选/取消（返回新数组） */
export function selToggle(ids, id) {
  const next = ids.slice()
  const i = next.indexOf(id)
  if (i >= 0) next.splice(i, 1)
  else next.push(id)
  return next
}

/** 是否全选（范围 = 当前已加载的行） */
export function selAllPicked(ids, songs) {
  const n = songs ? songs.length : 0
  return n > 0 && ids.length >= n
}

/** 全选：所有行的 id（新数组） */
export function selAllIds(songs) {
  const out = []
  const list = songs || []
  for (let i = 0; i < list.length; i++) {
    if (list[i]) out.push(list[i].id)
  }
  return out
}

/** 按**列表顺序**取出选中的歌曲对象（下载队列的顺序 = 用户看到的顺序） */
export function selPicked(ids, songs) {
  const out = []
  const list = songs || []
  for (let i = 0; i < list.length; i++) {
    if (list[i] && selHas(ids, list[i].id)) out.push(list[i])
  }
  return out
}

/* ---------------- 文案 ---------------- */

/** 顶栏副题：'下载中 3/12 · 42%'；停止中给 '正在停止下载…'；无活动给 '' */
export function dlText(d) {
  if (!d || !d.active) return ''
  if (d.stopping) return '正在停止下载…'
  const k = d.done + d.failed + (d.cancelled || 0)
  const cur = k < d.total ? k + 1 : k
  return '下载中 ' + cur + '/' + d.total + (d.pct ? ' · ' + d.pct + '%' : '')
}

/** 开始下载的 toast：「开始下载 12 首（极高）」 */
export function startText(n) {
  return '开始下载 ' + n + ' 首（' + qualityInfo(currentQuality('down')).label + '）'
}

/** 完成 toast：成功下载数与失败数分开显示 */
export function resultText(r) {
  if (!r) return '下载结束'
  if (!r.ok && !r.failed && r.cancelled) return '下载已停止'
  if (!r.ok && !r.failed && !r.skipped) return '没有可下载的内容'
  return '成功下载 ' + (r.ok || 0) + ' 首（' + (r.failed || 0) + ' 首失败）'
}

/* ---------------- 空间预检 ---------------- */

/**
 * 粗估一批歌按当前下载档的体积并与可用空间比对。
 * 返回 {est, free, tight}；free=0 = 读不到 df（exec 不可用）→ tight 恒 false（不做判断）。
 */
export async function spaceCheck(songs) {
  const est = estimateBytes(songs)
  let free = 0
  try {
    free = await freeBytes()
  } catch (e) {
    free = 0
  }
  return { est: est, free: free, tight: free > 0 && est > free }
}
