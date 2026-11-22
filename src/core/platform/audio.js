/**
 * 音频输出初始化 —— X3S 的 ALSA 混音器默认是「静音 + 输出路径 OFF」。
 *
 * X3S 设备事实（docs/词典笔X3S_设备事实与能力_2026-11-22.md §4.1）：
 *   - `Playback Path` 默认 `OFF`、`Master Playback Volume` 默认 `0`（= −50 dB）；
 *   - 任何程序播放前必须自己开路径 / 设音量（建议 ≤176 ≈ −16.5 dB）。
 * S7 / X5 没有这套「默认静音」问题（也没有独立的 `volume` 裸模块），本模块在那些机型上
 * 直接 no-op —— 判定方式：`import('volume')` 成功（X3S 独有模块）才执行 amixer。
 *
 * 为什么用 shell + amixer 而不是 `volume` 模块：X3S 的 `Volume.setVolume` 实测返回
 * undefined 且不改 ALSA（`amixer sget` 仍是 0/0），而 SoundPlayer 走的是 ALSA codec；
 * 直接设混音器是从根上保证出声。
 *
 * ⚠ **每次起播都要重新设一遍**：X3S 的 /etc/asound.conf 钩子在播放结束时会把
 * `Playback Path` 还原成 OFF，只在启动时设一次的话第二首起就没声。
 * 「本机是否 X3S」这个判定才缓存（一次 import 试探），混音器设置不走缓存。
 *
 * 注意：只把 **OFF** 改成 **SPK**；如果用户已插耳机/蓝牙（HP/BT/SPK_HP…），保持系统选择，
 * 不强行覆盖。Master 音量两个声道一起设（numid=3 是 2-value 控制，不能用 sset 名）。
 */
import { run } from './exec.js'
import { log } from '../infra/log.js'

/** 目标音量：150 ≈ −21.5 dB（0..255，−50 dB 起、0.19 dB/step）；离上限留余量 */
const VOLUME = 150

/** 是否 X3S（有无 volume 裸模块）：探一次就缓存 —— 机型不会变，但混音器状态会变 */
let isX3S = null

async function detect() {
  try {
    const m = await import('volume')
    return !!m
  } catch (e) {
    return false
  }
}

async function setup() {
  if (isX3S === null) isX3S = await detect()
  // 非 X3S（S7/X5）直接跳过，避免无谓 fork
  if (!isX3S) return false
  const cmd =
    "P=$(amixer -c 0 sget 'Playback Path' 2>/dev/null); " +
    "case \"$P\" in *\"Item0: 'OFF'\"*) amixer -c 0 sset 'Playback Path' SPK >/dev/null 2>&1 ;; esac; " +
    'amixer -c 0 cset numid=3 ' + VOLUME + ',' + VOLUME + ' >/dev/null 2>&1; true'
  const r = await run(cmd, 8000)
  const ok = !!(r && r.code === 0)
  log('audio', 'X3S 输出初始化 ' + (ok ? 'ok' : '失败') + '（音量 ' + VOLUME + '）')
  return ok
}

/**
 * 播放前调用。**每次都会重新设一遍混音器**（见文件头：播完一首系统会还原成 OFF），
 * 只有「本机是不是 X3S」这一项缓存。非 X3S 立即 resolve false，零开销。
 */
export function ensureOutput() {
  return setup()
}
