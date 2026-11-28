// 播放器（拆分自 player.js）：循环模式与倍速档位常量。


export const MODES = [
  { key: 'list_loop', label: '列表循环' },
  { key: 'list_seq', label: '顺序播放' },
  { key: 'single', label: '单曲循环' },
  { key: 'shuffle', label: '随机播放' }
]

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

export function modeInfo(key) {
  for (let i = 0; i < MODES.length; i++) {
    if (MODES[i].key === key) return MODES[i]
  }
  return MODES[0]
}