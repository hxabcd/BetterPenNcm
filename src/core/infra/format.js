/** 字节 → 人类可读（存储管理页用；<1KB 不打小数、GB 一位小数） */
export function fmtSize(bytes) {
  const b = Number(bytes) || 0
  if (b < 1024) return b + ' B'
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'
  return (b / 1073741824).toFixed(1) + ' GB'
}

/**
 * 文本截断（超长补 …）—— 顶栏这类「单行不换行」的位置用。
 * 平台对 flex 子项的 text-overflow 约束不可靠，所以在 JS 侧直接裁。
 */
export function clipText(s, max) {
  const t = String(s == null ? '' : s)
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * 名称比较（列表排序用）：优先 localeCompare（快速 JS 引擎里退化为码位序，
 * 中文不是拼音序，够用），引擎异常时退回手写比较。升降序是各页的配置，由调用方乘方向。
 */
export function cmpText(a, b) {
  const x = String(a || '')
  const y = String(b || '')
  try {
    return x.localeCompare(y)
  } catch (e) {
    return x < y ? -1 : x > y ? 1 : 0
  }
}

/** 缓存上限（MB）→ 文案：0/非法 = 不限；整 GB 用 'G'、其余用 'M'（= 设置页 chip 的写法） */
export function limitLabel(mb) {
  const n = Number(mb)
  if (!n || isNaN(n) || n < 0) return '不限'
  return n % 1024 === 0 ? n / 1024 + 'G' : n + 'M'
}

/** 毫秒 → m:ss */
export function fmtDur(ms) {
  if (!ms) return '0:00'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const ss = s % 60
  return m + ':' + (ss < 10 ? '0' : '') + ss
}

/** 秒/毫秒混用的时间戳归一到毫秒（部分接口回秒级，如歌手 top/song）；空值与非法值给 0 */
export function toMs(v) {
  const n = Number(v)
  if (!n || isNaN(n)) return 0
  return n < 100000000000 ? n * 1000 : n
}

/** 时间戳 → YYYY-MM-DD（专辑发行时间等）；秒/毫秒的归一交给 toMs */
export function fmtDate(ms) {
  const v = toMs(ms)
  if (!v) return '未知'
  const d = new Date(v)
  const y = d.getFullYear()
  if (!y || y < 1900) return '未知'
  const m = d.getMonth() + 1
  const day = d.getDate()
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day
}

/** 曲目是否 VIP（网易云 fee：1 = VIP 曲目，4 = 需付费专辑） */
export function isVipFee(fee) {
  return fee === 1 || fee === 4
}

/** 别名列表 → `(a/b)`；无别名给空串（SongRow 与 songinfo 共用；前导空格各自排版） */
export function aliasSuffix(list) {
  if (!list || !list.length) return ''
  return '(' + list.join('/') + ')'
}
