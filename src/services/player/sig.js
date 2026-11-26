

// 播放器每 500ms 广播一次完整快照（player.js 的 emit），把 500ms 一次的广播压成「界面真的变了才渲染」。
// 判重口径：签名必须覆盖页面渲染用到的一切，否则界面会停在旧值；所以进度类页面必须把 position 的
// 显示值按显示精度取整后带进签名。平台 watcher 不去重，判重只能由订阅方在入口自己做，本模块不做订阅。
// 不改成 JSON.stringify / 深度比较：快照里带整个队列（几百上千首）与曲目对象，每 500ms 序列化一次比渲染还贵；
// 这里只拼界面真正消费的那几列，成本是几十个字符的加法
import { fmtDur } from '../../core/infra/format.js'

// 会显示在界面上的曲目字段：换歌的一切可见差异
export function trackSig(s) {
  const c = (s && s.cur) || {}
  return (c.id || 0) + '|' + (c.name || '') + '|' + (c.artist || '') +
    '|' + (c.album || '') + '|' + (c.cover || '') + '|' + (c.durationMs || 0)
}

// 播放控制态：播放/暂停/循环模式/倍速/是否已在本地（图标与状态行都会变）
export function playSig(s) {
  return (s && s.isPlaying ? 1 : 0) + '' + (s && s.paused ? 1 : 0) +
    '|' + ((s && s.loopMode) || '') +
    '|' + ((s && s.rate) || 0) +
    '|' + (s && s.cached ? 1 : 0)
}

// 「控制区 / 进度面板」视角的完整签名：曲目 + 控制态 + 进度 + 状态文案。
// 进度按显示精度取整而不是原值：时间是 m:ss（1s 一档），进度条是 0.1% 一档
// （ControlPanel.fillStyle 自己的 Math.round(pct * 1000) / 10）；两者取整后相同 = 这一 tick 界面上什么都没变。
// pct 的分子分母必须与 ControlPanel 一致（durationMs 为 0 时 pct 记 0）
export function viewSig(s) {
  const pos = Number((s && s.positionMs) || 0)
  const dur = Number((s && s.durationMs) || 0)
  const p = dur ? Math.round((pos / dur) * 1000) / 10 : 0
  return trackSig(s) + '#' + playSig(s) +
    '#' + (s && s.status ? 'S' + s.status : fmtDur(pos)) +
    '#' + fmtDur(dur) + '#' + p
}

// 队列列表签名：长度 + 首尾采样。队列可能上千首（「播放全部」整张歌单），逐首拼 id 会变成每 tick 一次
// O(n) 字符串构造；长度 + 首尾各若干 id 能覆盖增删与重排，且是常数成本。
// 极端情况（只改了采样窗口之外的顺序）漏判的代价是该页沿用旧列表，队列页的 show 事件与多选/删除操作会再刷一次兜底
export function queueSig(list, sample) {
  const a = list || []
  const n = a.length
  if (!n) return '0'
  const k = sample || 8
  let s = n + ':'
  for (let i = 0; i < n && i < k; i++) s += ((a[i] && a[i].id) || 0) + ','
  for (let i = Math.max(k, n - k); i < n; i++) s += ((a[i] && a[i].id) || 0) + ','
  return s
}

// 队列页视角：队列列表 + 当前曲 + 循环模式（决定高亮行与副题）
export function queueViewSig(s) {
  return queueSig(s && s.queue) + '#' + trackSig(s) + '#' +
    ((s && s.index) == null ? -1 : s.index) + '#' + ((s && s.loopMode) || '') +
    '#' + (s && s.paused ? 1 : 0) + (s && s.isPlaying ? 1 : 0)
}

export function sigFeed(fn) {
  let last = null
  return function (s) {
    const k = '~' + fn(s)
    if (k === last) return false
    last = k
    return true
  }
}
