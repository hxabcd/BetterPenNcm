/**
 * 应用启动序列（幂等）
 *
 * 从原 index.vue 的 mounted 启动链搬出：存储目录就绪 → 设置加载 → cookie 引导
 * （$dataDir/cookie.txt，开发期 adb 递会话用）→ cookie 载入 → 账号校验。
 * 多页面/页面挂两遍都会调，用模块级 Promise 保证只跑一次。
 */
import config from './config.js'
import { notify as themeNotify } from './theme.js'
import { loadPlayerSettings, loadLastState } from './player/player.js'
import { load as loadHistory } from './player/history.js'
import { ensureDir as ensureStorageDir } from './store.js'
import { ensureDir } from './fsutil.js'
import { storeDir, lrcDir } from './paths.js'
import { importFromFile, load as loadCookies, names as cookieNames } from './net/cookies.js'
import { cachedProfile, loggedIn, fetchProfile } from './ncm/login.js'
import { pullAll as autoPullLocalLists } from './player/locallists.js'
import { log } from './log.js'

let promise = null

/**
 * 存储就绪 —— **只建目录，不写 storage**。
 *
 * storage 的唯一前提是 `<appdata>/data/storage` 存在（框架安装时不建，见 store.js），
 * 建目录走 fs.mkdir（原生调用、不 fork）。**不要在这里写探测 key**：storage 每次写都重写
 * 整份 preferences.json，一次探测就是两次整份重写，而它只验证目录存在与否。
 * store/ 与 lrc/ 是文件型表与歌词库（见 utils/filestore.js）。
 */
async function prepareStore() {
  const a = await ensureStorageDir()
  const b = await ensureDir(storeDir())
  const c = await ensureDir(lrcDir())
  log('boot', '存储目录 storage=' + a + ' store=' + b + ' lrc=' + c)
}

async function run() {
  await prepareStore()
  await config.load()
  // 播放器设置（倍速 / 循环模式）在 config 载入后恢复，播放页直接读单例状态
  loadPlayerSettings()
  // 播放历史（本地）在页面读取前载入完 —— 首页卡片/历史列表页不做「未加载」闪烁
  await loadHistory()
  // 上次播放状态（队列/当前曲/进度）——恢复为暂停态，首页「正在播放」卡片据此显示
  await loadLastState()
  // 背景色/主题色同理：组件挂载时配置可能还没 load 完，载入后广播一次让 chrome 重读
  themeNotify()
  await importFromFile()
  await loadCookies()
  let profile = cachedProfile()
  if (loggedIn()) {
    log('boot', '载入登录态 ' + profile.nickname + '（cookie ' + cookieNames().length + ' 项），校验账号…')
    try {
      const p = await fetchProfile()
      if (p && p.nickname) profile = p
    } catch (e) {}
  } else {
    log('boot', '未登录')
  }
  // 自动拉取（设置 → 音质与存储，默认禁用）：只更新本地索引歌单的远端快照，
  // 不下载/不删文件。**不 await**：启动链不能被 N 个歌单的请求拖住；
  // 失败只记日志，下次启动再试。离线/未登录时 pullAll 内部会直接返回。
  if (config.get('autoPull') && loggedIn()) {
    log('boot', '自动拉取：启动')
    autoPullLocalLists().catch(function (e) {
      log('boot', '自动拉取异常：' + ((e && e.message) || e))
    })
  }
  return profile
}

/** 返回 Promise<profile>；重复调用返回同一个 Promise */
export function boot() {
  if (!promise) promise = run()
  return promise
}
