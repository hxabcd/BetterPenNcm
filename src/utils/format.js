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

/** 毫秒 → m:ss */
export function fmtDur(ms) {
  if (!ms) return '0:00'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const ss = s % 60
  return m + ':' + (ss < 10 ? '0' : '') + ss
}

/**
 * 时间戳 → YYYY-MM-DD（专辑发行时间等）。
 * 网易云这两个字段的秒/毫秒混用（歌手 top/song 里出现过秒），
 * 所以先按位数判断量级再补零到毫秒。
 */
export function fmtDate(ms) {
  if (!ms) return '未知'
  let v = Number(ms)
  if (!v) return '未知'
  if (v < 100000000000) v = v * 1000 // 秒 → 毫秒
  const d = new Date(v)
  const y = d.getFullYear()
  if (!y || y < 1900) return '未知'
  const m = d.getMonth() + 1
  const day = d.getDate()
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day
}
