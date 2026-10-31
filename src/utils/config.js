/**
 * 应用设置（storage 持久化，字符串 KV）
 * 用法：await cfg.load(); cfg.get('rate'); await cfg.set('rate', 1.25)
 *
 * storage 走 utils/store.js 的封装：那边会先确保 <appdata>/data/storage 目录存在，
 * 否则框架的 setStorage 一律失败（见 store.js 顶部说明）。
 *
 * 用户已存配置里的残留键会在 load()
 * 里被忽略（只认 DEFAULTS 里出现的键），无需迁移。
 */
import { getStorage, setStorage } from './store.js'

const KEY = 'ncm_settings'

const DEFAULTS = {
  // 是否自动演示（开发用）
  demo: false,
  // 登录资料缓存（cookie 本体在 utils/net/cookies.js 里单独持久化）
  nickname: '',
  avatarUrl: '',
  userId: 0,
  // ---- 播放器设置（播放选项页可改，加）----
  rate: 1, // 倍速档位
  loopMode: 'list_loop', // 列表循环 / 顺序播放 / 单曲循环 / 随机播放
  // 音质档位（设置页可改，档位表见 utils/player/quality.js）：
  //   playQuality     —— 在线播放用的档位，**也是「边听边存」缓存文件的档位**
  //   downloadQuality —— 用户主动下载到 music/ 用的档位
  // 默认都是极高 = 320k mp3，失败降 128k；可选「无损 / Hi-Res」（账号无权益时服务端会降级）
  playQuality: 'exhigh',
  downloadQuality: 'exhigh',
  // 「缓存上限」（MB，默认 1G = 1024）：
  //   **只约束「边听边存」的播放缓存**（$dataDir/cache，按播放音质）—— 总量超过上限时，
  //   从**最久没被播放**的开始滚掉（LRU，见 cache.js 的 enforceCacheLimit）。
  //   用户主动**下载**（$dataDir/music，按下载音质）不受它约束，只由用户手动删。
  //   0 / 非法值 = 不限。
  cacheLimitMb: 1024,
  // 启动时自动拉取本地索引内的歌单（只更新远端快照，不下载/不删文件；默认禁用）。
  // 设置入口：设置 → 音质与存储 → 自动拉取。
  autoPull: false,
  // 退出应用时暂停音乐（默认启用，设置页可关）。
  // SoundPlayer 是独立的系统进程（guardian_run 守护），应用退出带不走它 ——
  // 不主动暂停的话退出后音乐会继续放。关闭 = 退出后继续播放（后台/息屏听歌场景）。
  pauseOnExit: true,
  lyricOn: true, // 歌词开关
  showTrans: true, // 歌词翻译开关（仅 lyricOn 为真时有意义）
  // 逐字歌词（默认开）：服务端有 YRC 时按音节逐字点亮/扫亮；
  // 无 YRC 自动回退逐行歌词，关闭 = 强制逐行（保留单文本节点，不建逐字动画）。
  lyricWord: true,
  // 歌词动画（默认开）：滚动/字号高亮/逐字扫亮等过渡；
  // 关闭 = 定位与逐字进度照常更新，但全部瞬时完成、无过渡。
  lyricAnim: true,
  // 歌词是否允许拖动翻看。false = 省性能：**禁用拖动**，位置恒为「当前行居中」，
  // 只保留双击跳行。两种模式都只渲染可视范围（歌词面板是窗口化渲染）。
  lyricFull: true,
  // 歌词自动跟歌（默认开）：活动行更新时**平滑滚动**到该行。
  // 关掉 = 只更新高亮、轨道不动（手动翻看时不会被拽走）。
  // 手动翻看期间高亮始终跟着播放进度 —— 这条不受开关影响（LyricBoard 的 follow）。
  lyricFollow: true,
  lyricDbl: true, // 双击歌词跳转到该行
  // 首页「正在播放」卡的**柔光渐变**（加开关）：
  //   开 = 卡面叠一层由封面取色（无曲目时回落主题色）的静态渐变；
  //   关 = 只用 @panel 纯色卡面。
  // ⚠ 默认开（这是 才做的效果，关掉是给用户一个「不想要」的退路，不是默认行为）。
  // ⚠ 关掉**只影响首页那张卡**：播放页的渐变、进度条都不归它管。
  glowOn: true,
  // ---- 外观（主题实现在 utils/theme.js，这里只存 preset key）----
  bgColor: 'gray', // 深灰 / 纯黑 / 深蓝 / 暗紫
  // 主题色（accent）预设 key：红(默认) / 橙 / 绿 / 蓝 / 紫 / 粉 —— 表见 utils/theme.js 的 ACCENTS，
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
      // 读取失败用默认值
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
