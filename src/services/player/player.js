/* 播放器单例 —— 多页面间 ES 模块是同一实例，各页直接 import。
 * 出声统一走 playFile：本地文件与在线直链同一条路（平台实测：fileName 给直链时同样认 position 与 rate）。
 * ⚠ 无 pause：暂停 = stop()，续播 = playFile(源, positionMs, rate)。
 *
 * 实现按功能拆在同目录：player-state（共享状态 S + 快照/广播/时间常量）、player-events（媒体事件）、
 * player-persist（会话快照落盘）、player-source（取可播地址与起播）、player-play（播放/暂停/seek/连播）、
 * player-queue（队列编辑）、player-settings（倍速/循环模式）、player-shuffle（随机队列）、player-modes（档位常量）。
 * 本文件保留对外导出面（与拆分前完全一致）与 player 单例对象。 */

import { flushNow } from './player-persist.js'
import { next, pauseForExit, playAt, prev, seekTo, stopPlay, toggle } from './player-play.js'
import { appendToQueue, insertNext, playList, queueToken, removeFromQueue } from './player-queue.js'
import { cycleLoopMode, setLoopMode, setRate } from './player-settings.js'
import { off, on, state } from './player-state.js'
// 副作用导入：媒体事件订阅（bindEvents）在 player-events 的模块求值时登记，
// 没人 import 它就不会订阅，播放器将收不到 position/end/error 事件。放最后一行，
// 让 player-state 的钩子注册先执行（与原文件里 setFileChangedHook 在 bindEvents 之前的顺序一致）。
import './player-events.js'


export { MODES, RATES } from './player-modes.js'
export { flushNow, loadLastState } from './player-persist.js'
export { loadPlayerSettings } from './player-settings.js'
export { pauseForExit } from './player-play.js'

export const player = {
  playList: playList,
  playAt: playAt,
  toggle: toggle,
  next: next,
  prev: prev,
  stop: stopPlay,
  seekTo: seekTo,
  setRate: setRate,
  setLoopMode: setLoopMode,
  cycleLoopMode: cycleLoopMode,
  removeFromQueue: removeFromQueue,
  insertNext: insertNext,
  queueToken: queueToken,
  appendToQueue: appendToQueue,
  state: state,
  on: on,
  off: off,
  flushNow: flushNow,
  pauseForExit: pauseForExit
}