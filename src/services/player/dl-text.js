// 媒体源层（拆分自 download.js）：下载相关的文案、签名与空间预检（纯函数）。
import { currentQuality, qualityInfo, nominalBr } from './quality.js'
import { touchPlayMeta } from './cache.js'

// 粗估一批歌按「下载档」的总体积（列表页/专辑页的空间预检用）：Σ 档位名义码率/8 × 时长（时长缺失按 4 分钟估）。
// ⚠ 纯估算：无损档名义 999k、Hi-Res 名义 2400k，都高于真实码率 → 偏大，宁可多提醒一次
export function estimateBytes(songs, qualityKey) {
  const br = nominalBr(qualityKey || currentQuality('down'))
  let ms = 0
  const list = songs || []
  for (let i = 0; i < list.length; i++) ms += (list[i] && list[i].durationMs) || 240000
  return Math.round((br / 8) * (ms / 1000))
}
// 记一次「这首歌被播放了」——「缓存上限」LRU 的排序键，满了先淘汰最久没播的。只更新**已存在**的缓存条目
// （还没缓存完的等写入时给初值），写盘 400ms 合并。下载目录（music/）的歌曲不进这张表，
// 所以**手动下载的不受缓存滚动影响**
export const touchPlayCache = touchPlayMeta

export function dlText(d) {
  if (!d || !d.active) return ''
  if (d.stopping) return '正在停止下载…'
  const k = d.done + d.failed + (d.cancelled || 0)
  const cur = k < d.total ? k + 1 : k
  return '下载中 ' + cur + '/' + d.total + (d.pct ? ' · ' + d.pct + '%' : '')
}

export function startText(n) {
  return '开始下载 ' + n + ' 首（' + qualityInfo(currentQuality('down')).label + '）'
}

export function resultText(r) {
  if (!r) return '下载结束'
  if (!r.ok && !r.failed && r.cancelled) return '下载已停止'
  if (!r.ok && !r.failed && !r.skipped) return '没有可下载的内容'
  return '成功下载 ' + (r.ok || 0) + ' 首（' + (r.failed || 0) + ' 首失败）'
}

// 粗估一批歌按当前下载档的体积并与可用空间比对。free=0 = 读不到 df（exec 不可用）→ tight 恒 false（不做判断）
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

// 下载活动快照的签名（判重用）：快照 ~400ms 一发，页面不判重就是持续重渲染（平台坑）；
// 字段口径 = 页面显示的全部来源：active/total/三态计数/stopping/pct
export function dlSig(d) {
  d = d || {}
  return (d.active ? 1 : 0) + '|' + d.total + '|' +
    (d.done + d.failed + (d.cancelled || 0)) + '|' + (d.stopping ? 1 : 0) + '|' + d.pct
}
