/**
 * 应用启动序列（幂等）
 *
 * 存储目录就绪 → 开两个库（建表）→ 索引灌内存 →
 * 设置加载 → cookie 引导（$dataDir/cookie.txt，开发期递会话用）→ cookie 载入 → 账号校验。
 * 多页面/页面挂两遍都会调，用模块级 Promise 保证只跑一次。
 *
 * 没有迁移步骤：应用只认当前布局，旧布局的数据一律不读、不搬。
 */
import config from './config.js'
import { notify as themeNotify } from './theme.js'
import { loadPlayerSettings, loadLastState } from '../../services/player/player.js'
import { load as loadHistory } from '../../services/player/history.js'
import { ensureDir } from './fsutil.js'
import { downloadsDir, cacheDir, thumbsDir } from './paths.js'
import { open as openDb, ensureStateDb as openStateDb } from './db.js'
import { importFromFile, load as loadCookies, names as cookieNames } from './net/cookies.js'
import { cachedProfile, loggedIn, fetchProfile } from '../../services/ncm/login.js'
import { pullAll as autoPullLocalLists } from '../../services/player/locallists.js'
import { log } from './log.js'

let promise = null

/**
 * 存储就绪 —— **只建目录，不写任何数据**。
 *
 * 建目录走原生 `fs.mkdir`（递归、不分叉），只是为了让首次 `readdir`/`ls` 不报错、
 * 以及日志好排查。数据一律在 SQLite 里，目录只装音频文件与封面。
 *
 * ⚠ 不要在这里写探测数据：写文本文件只能借 shell，一次就是一次 fork（真机 92~139ms）。
 */
async function prepareStore() {
  const a = await ensureDir(downloadsDir())
  const b = await ensureDir(cacheDir())
  const c = await ensureDir(thumbsDir())
  log('boot', '存储目录 downloads=' + a + ' cache=' + b + ' thumbs=' + c)
}

async function run() {
  await prepareStore()
  // 两个库都建表：索引库（可重建）+ 状态库（配置/凭据/会话/元数据/歌词）。
  // 索引表接着整表灌内存（之后查询不再查库，见 utils/db.js）。
  await openStateDb()
  await openDb()
  // 配置从状态库的 kv 行读进来。**必须在任何读配置的模块之前**：
  // 下面 loadPlayerSettings / 主题广播 / 自动拉取都直接读 config 的单例缓存。
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
