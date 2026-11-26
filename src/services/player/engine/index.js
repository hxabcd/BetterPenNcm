

// 引擎向上发出的五种事件（适配器负责把平台事件翻译成这五种）；POSITION/DURATION 单位毫秒，
// ERROR 的 fatal=true 表示本次播放不可恢复
export const EVENTS = {
  STARTED: 'started', 
  POSITION: 'position', 
  DURATION: 'duration', 
  ENDED: 'ended', 
  ERROR: 'error' 
}

// ended 的 reason：natural 该连播；stopped（我们自己调的 stop）与 interrupted（被别的应用抢占）都不连播，
// 后者还要记位置
export const END_REASON = {
  NATURAL: 'natural', 
  STOPPED: 'stopped', 
  INTERRUPTED: 'interrupted' 
}

// 会话令牌：每次 open 递增，晚到的事件靠它对账
let seq = 0

export function nextSessionId() {
  return ++seq
}
