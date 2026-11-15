/**
 * 音频引擎端口（port）—— 业务层唯一允许依赖的音频契约。
 *
 * 背景：现在的 player.js 一边管队列、一边直接调 sound.js，还顺手用 `paused` 兼作
 * 「别把自己的 stop 当成播完」的保护位（见 startSource）。平台怪癖因此渗进业务：
 * 上层要认识 uuid、要猜事件实参形状、要用「是否临近结尾」判断这次结束是自然播完还是被别的应用抢占。
 *
 * 这个端口的职责就是把那些怪癖挡在适配器里，让上层只看到干净语义：
 *
 *   const engine = createSoundPlayerEngine()
 *   engine.on((e) => { ... })                  // started / position / duration / ended / error
 *   await engine.open({ kind, locator, positionMs, rate })   // 返回会话令牌
 *   await engine.stop()                        // 只会产生 ended(reason='stopped')，不产生 error
 *
 * 上层**不需要**知道 uuid、不需要订阅原生信号、不需要判断 stop 引发的事件。
 *
 * ## 能力声明（capabilities）
 *
 * 平台没有 pause / seek，这件事不该写进每个调用点的 if 里，而应该由引擎声明能力，
 * 上层按能力走同一套降级逻辑（见 player 的 pause/seek 实现）：
 *
 *   pause:  'native' | 'stop'      'stop' = 暂停靠 stop() 实现，进度由上层记住
 *   seek:   'native' | 'reopen'    'reopen' = 换位置 = 重新 open
 *   rate:   'native' | 'reopen'    'native' = open 时带上倍速即可
 *   volume: 'native' | 'none'      'none' = 没有音量接口，只能走系统音量
 *   route:  'native' | 'none'      'none' = 无法指定输出设备（蓝牙/喇叭）
 *
 * 换后端（比如 ffmpeg|aplay）时，这里多一个适配器即可，上层一行不改。
 */

/** 引擎向上发出的事件名（适配器负责把平台事件翻译成这五种） */
export const EVENTS = {
  STARTED: 'started', // 已出声（本地文件起播 / 流式首个位置上报）
  POSITION: 'position', // 位置上报（毫秒），用于锚定时钟
  DURATION: 'duration', // 时长上报（毫秒）
  ENDED: 'ended', // 结束：reason 见 END_REASON
  ERROR: 'error' // 出错：fatal=true 表示本次播放不可恢复
}

/** ended 事件的 reason —— 上层据此决定「连播」还是「就当停了」 */
export const END_REASON = {
  NATURAL: 'natural', // 自然播完 → 该连播
  STOPPED: 'stopped', // 我们自己调的 stop() → 不连播
  INTERRUPTED: 'interrupted' // 外部抢占（单例被别的应用 stop 掉）→ 不连播，记位置
}

/** 会话令牌：每次 open 递增，晚到的事件靠它对账 */
let seq = 0

export function nextSessionId() {
  return ++seq
}
