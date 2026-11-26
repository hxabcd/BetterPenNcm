
// 应用设置 = state.db 的 kv 行 ncm_settings（见 core/infra/store.js）。
// ⚠ 不写 config.json：平台 fs 没有写接口，写文件只能 fork 一次 shell（真机 92~139ms），
//   而改主题/倍速/音质时配置会被连续改写；库里的 upsert 是微秒级
// 用户已存配置里的残留键在 load() 里被忽略（只认 DEFAULTS 里出现的键），无需迁移
import { getStorage, setStorage, KEY_SETTINGS } from './store.js'

const KEY = KEY_SETTINGS

// 默认值表 = 这些设置默认值的唯一出处。core 不能 import services，所以默认值住在 core、
// 服务层反向读（如 quality.js 的 DEFAULT_QUALITY = DEFAULTS.playQuality）
export const DEFAULTS = {

  demo: false,

  // 登录资料缓存（cookie 本体在 core/infra/net/cookies.js 里单独持久化）
  nickname: '',
  avatarUrl: '',
  userId: 0,

  rate: 1, // 倍速档位
  loopMode: 'list_loop', // 列表循环 / 顺序播放 / 单曲循环 / 随机播放

  // 音质档位（档位表见 services/player/quality.js）：
  //   playQuality     —— 在线播放用的档位，也是「边听边存」缓存文件的档位
  //   downloadQuality —— 用户主动下载到 downloads/ 用的档位
  // 默认极高 = 320k mp3，失败降 128k；可选「无损 / Hi-Res」（账号无权益时服务端会降级）
  playQuality: 'exhigh',
  downloadQuality: 'exhigh',

  // 「缓存上限」（MB，默认 1G = 1024）：只约束「边听边存」的播放缓存（$dataDir/cache，按播放音质），
  // 总量超过上限时从最久没被播放的开始滚掉（LRU，见 cache.js 的 enforceCacheLimit）。
  // 用户主动下载（$dataDir/downloads，按下载音质）不受它约束，只由用户手动删。
  // 0 = 不限（合法值，读的时候别用 `|| 0` 之类的兜底把它和「没设置」混起来）
  cacheLimitMb: 1024,

  // 启动时自动拉取本地索引内的歌单（只更新远端快照，不下载/不删文件；默认禁用）
  autoPull: false,

  // 退出应用时暂停音乐。SoundPlayer 是独立的系统进程（guardian_run 守护），应用退出带不走它 ——
  // 不主动暂停的话退出后音乐会继续放。关闭 = 退出后继续播放（后台/息屏听歌）
  pauseOnExit: true,
  lyricOn: true, 
  showTrans: true, 

  // 逐字歌词：服务端有 YRC 时按音节逐字点亮/扫亮，无 YRC 自动回退逐行；
  // 关闭 = 强制逐行（保留单文本节点，不建逐字动画）
  lyricWord: true,

  // 歌词动画：滚动/字号高亮/逐字扫亮等过渡。关闭 = 定位与逐字进度照常更新，但全部瞬时完成
  lyricAnim: true,

  // 歌词是否允许拖动翻看。false = 省性能：禁用拖动，位置恒为「当前行居中」，只保留双击跳行。
  // 两种模式都只渲染可视范围（歌词面板是窗口化渲染）
  lyricFull: true,

  // 歌词自动跟歌：活动行更新时平滑滚动到该行。关掉 = 只更新高亮、轨道不动。
  // 手动翻看期间高亮始终跟着播放进度 —— 这条不受开关影响（LyricBoard 的 follow）
  lyricFollow: true,
  lyricDbl: true, // 双击歌词跳转到该行

  // 首页「正在播放」卡的柔光渐变：开 = 卡面叠一层由封面取色（无曲目时回落主题色）的静态渐变，
  // 关 = 只用 @panel 纯色卡面。⚠ 关掉只影响首页那张卡，播放页的渐变、进度条都不归它管
  glowOn: true,

  bgColor: 'gray', // 深灰 / 纯黑 / 深蓝 / 暗紫

  // 主题色（accent）预设 key：红(默认) / 橙 / 绿 / 蓝 / 紫 / 粉 —— 表见 ui/theme.js 的 ACCENTS，
  // 着色图标 PNG 的 key 与其成对（scripts/gen_icons.py）
  accentColor: 'red'
}

let cache = Object.assign({}, DEFAULTS)

export const config = {
  get(key) {
    return cache[key]
  },
  async load() {
    try {
      const raw = await getStorage(KEY)
      if (raw) {
        const obj = JSON.parse(raw)
        Object.keys(DEFAULTS).forEach(function (k) {
          if (obj[k] !== undefined) cache[k] = obj[k]
        })
      }
    } catch (e) {

    }
    return cache
  },
  async set(key, value) {
    cache[key] = value
    await setStorage(KEY, JSON.stringify(cache))
    return value
  },
  all() {
    return Object.assign({}, cache)
  }
}

export default config
