

// 两套档位（设置页可分别改）：config.playQuality 是在线播放那条路径，也是「边听边存」缓存文件的音质；
// config.downloadQuality 是用户主动下载到本机的音质。缓存与播放同档 → 播放层那份直链可直接复用给缓存层。
// 档位名对齐网易云手机端（标准/较高/极高/无损/Hi-Res），底层是 v1 直链接口的 level 参数（ncm/api.js 的 getSongUrl）；
// 老接口只认 br 且最高 999000、没有 hires 档。回包 d.type（'mp3'|'flac'）决定缓存/下载文件扩展名。
// ⚠ 回包 d.level 只是档位标签、不可靠（带 cookie 实测：请求 hires 回 'lossless'，24bit 与 16bit 的 flac 都标 'lossless'）；
// hires/lossless 与老接口 999000 返回的是同一个文件 —— Hi-Res 不是这一档解锁出来的，账号有黑胶且曲目有 24bit 资源时，
// 无损档下的就是那份。真正判音质只能看 br/size（要辨 24bit 需解 flac STREAMINFO，未做）。
// 降级链：从选定档位往下取，最低 128k 兜底（VIP 歌拿不到高码率时的老行为）；中间档位不等距跳（无损 → 320k → 128k，跳过 192k）
import config, { DEFAULTS } from '../../core/infra/config.js'

export const QUALITIES = [
  { key: 'standard', label: '标准', level: 'standard', br: 128000, note: '128k mp3' },
  { key: 'higher', label: '较高', level: 'higher', br: 192000, note: '192k mp3' },
  { key: 'exhigh', label: '极高', level: 'exhigh', br: 320000, note: '320k mp3' },
  { key: 'lossless', label: '无损', level: 'lossless', br: 999000, note: 'FLAC 无损' },
  { key: 'hires', label: 'Hi-Res', level: 'hires', br: 2400000, note: '24bit FLAC' }
]

// 默认档位的值住 core/infra/config.js 的 DEFAULTS.playQuality（默认值只能住 core，服务层反向读）；
// 未设置/非法 key 的回退与设置页初始态都读这一个常量
export const DEFAULT_QUALITY = DEFAULTS.playQuality

export function currentQuality(kind) {
  const key = kind === 'play' ? 'playQuality' : 'downloadQuality'
  return config.get(key) || DEFAULT_QUALITY
}

// 不传 key 时按「下载音质」读 config（下载层就是这么调的：resolveLevels() → qualityInfo() → config；
// 别改成「不传就回默认档」，否则设置页改了档位，下载层永远走默认档——真机踩过一次）
export function qualityInfo(key) {
  const k = key || currentQuality('down')
  for (let i = 0; i < QUALITIES.length; i++) {
    if (QUALITIES[i].key === k) return QUALITIES[i]
  }
  for (let i = 0; i < QUALITIES.length; i++) {
    if (QUALITIES[i].key === DEFAULT_QUALITY) return QUALITIES[i]
  }
  return QUALITIES[0]
}

// 直链请求链（从选定档位往下，最后一档 128k 兜底），返回的是 v1 接口的 level 值。
// hires 链里仍保留 lossless 作为保险 —— 实测两者返回同一文件（见文件头），正常第一档就命中 url 直接返回，
// 只防服务端将来真分级
export function resolveLevels(key) {
  const k = qualityInfo(key).key
  if (k === 'hires') return ['hires', 'lossless', 'exhigh', 'standard']
  if (k === 'lossless') return ['lossless', 'exhigh', 'standard']
  if (k === 'exhigh') return ['exhigh', 'standard']
  if (k === 'higher') return ['higher', 'standard']
  return ['standard']
}

// 档位名次（standard=0 → hires=4）：缓存升级判定用 ——「已有缓存档位名次 ≥ 目标档位」才跳过，低于才值得重下
export function qualityRank(key) {
  const k = qualityInfo(key).key
  for (let i = 0; i < QUALITIES.length; i++) {
    if (QUALITIES[i].key === k) return i
  }
  return 0
}

// 档位名义码率（bps）：只用于空间估算（Hi-Res 2400000 略高于实测 1.8M → 偏保守，宁可多提醒）。
// ⚠ 已知低估：选「无损」档时，带 24bit 资源的曲目实际下到 1.8M 的 flac，按 999000 估会少算近一半。
// ⚠ 别拿它做「老元数据是否达标」的比较：真机实测无损接口回包的实际 br 是 ~947k（device_log：type=flac br=947180），
// 与名义 999000 比会误判「未达标」而白重下一次；老数据的达标判定按 flac/码率反推档位
export function nominalBr(key) {
  return qualityInfo(key).br
}
