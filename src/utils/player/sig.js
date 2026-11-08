/**
 * 播放器订阅的「签名判重」—— 把 500ms 一次的广播压成「界面真的变了才渲染」。
 *
 * 背景：播放器每 500ms 广播一次完整快照（`player.on`，见 utils/player/player.js 的 emit）。
 * 页面把快照直接赋给 data 就是一次整页重渲染，可绝大多数 tick 里**界面上没有一个像素会变**
 * （没换歌、没暂停、时间文本还是那一秒）。首页很早就自己做了字符串签名判重，播放页与
 * 队列页则是照单全收 —— 现在统一走这里。
 *
 * 为什么不用 JSON.stringify / 深度比较：快照里带**整个队列**（几百上千首）与曲目对象，
 * 每 500ms 序列化一次比渲染还贵。这里只拼**界面真正消费的那几列**，成本是几十个字符的加法。
 *
 * 判重口径的口诀：**签名必须覆盖页面渲染用到的一切，否则界面会停在旧值**。
 * 所以：进度类看到 position 的页面，签名里就必须带上 position 的显示值（按显示精度取整）。
 *
 * 与「平台坑 16」的关系：平台 watcher 不去重，判重只能由页面在订阅入口自己做；
 * 本模块只提供签名与判重，不做订阅。
 */
import { fmtDur } from '../format.js'

/** 会显示在界面上的曲目字段：换歌的一切可见差异 */
export function trackSig(s) {
  const c = (s && s.cur) || {}
  return (c.id || 0) + '|' + (c.name || '') + '|' + (c.artist || '') +
    '|' + (c.album || '') + '|' + (c.cover || '') + '|' + (c.durationMs || 0)
}

/** 播放控制态：播放/暂停/循环模式/倍速/是否已在本地（图标与状态行都会变） */
export function playSig(s) {
  return (s && s.isPlaying ? 1 : 0) + '' + (s && s.paused ? 1 : 0) +
    '|' + ((s && s.loopMode) || '') +
    '|' + ((s && s.rate) || 0) +
    '|' + (s && s.cached ? 1 : 0)
}

/**
 * 「控制区 / 进度面板」视角的完整签名：曲目 + 控制态 + 进度 + 状态文案。
 *
 * 进度按**显示精度**取整，而不是原值：时间是 `m:ss`（1s 一档），进度条是 0.1% 一档
 * （ControlPanel.fillStyle 自己的 `Math.round(pct * 1000) / 10`）。两者取整后相同 =
 * 这一 tick 界面上什么都没变，不必渲染。
 * 注意 pct 的分子分母必须与 ControlPanel 一致（durationMs 为 0 时 pct 记 0）。
 */
export function viewSig(s) {
  const pos = Number((s && s.positionMs) || 0)
  const dur = Number((s && s.durationMs) || 0)
  const p = dur ? Math.round((pos / dur) * 1000) / 10 : 0
  return trackSig(s) + '#' + playSig(s) +
    '#' + (s && s.status ? 'S' + s.status : fmtDur(pos)) +
    '#' + fmtDur(dur) + '#' + p
}

/**
 * 队列列表签名：长度 + 首尾采样。
 * 队列可能上千首（「播放全部」整张歌单），逐首拼 id 会变成每 tick 一次 O(n) 字符串构造；
 * 页面真正关心的只是「列表内容/顺序变了没有」。长度 + 首尾各若干 id 能覆盖增删与重排，
 * 且是常数成本。极端情况（只改了采样窗口之外的顺序）漏判的代价是该页沿用旧列表，
 * 队列页的 `show` 事件与多选/删除操作都会再刷一次兜底。
 */
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

/** 队列页视角：队列列表 + 当前曲 + 循环模式（决定高亮行与副题） */
export function queueViewSig(s) {
  return queueSig(s && s.queue) + '#' + trackSig(s) + '#' +
    ((s && s.index) == null ? -1 : s.index) + '#' + ((s && s.loopMode) || '') +
    '#' + (s && s.paused ? 1 : 0) + (s && s.isPlaying ? 1 : 0)
}

/**
 * 判重器：给一个签名函数，返回 `feed(state) -> true(变了) / false(没变)`。
 * 用法：`this._feed = sigFeed(viewSig); this._feed(player.state())` 初始化一次，
 * 之后每个 tick `if (this._feed(s)) this.st = s`。
 */
export function sigFeed(fn) {
  let last = null
  return function (s) {
    const k = '~' + fn(s)
    if (k === last) return false
    last = k
    return true
  }
}
