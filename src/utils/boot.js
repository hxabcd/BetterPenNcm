/**
 * 应用启动序列（幂等）
 *
 * 从原 index.vue 的 mounted 启动链搬出：存储目录就绪 → 数据布局迁移 → 索引库就绪 →
 * 设置加载 → cookie 引导（$dataDir/cookie.txt，开发期 adb 递会话用）→ cookie 载入 → 账号校验。
 * 多页面/页面挂两遍都会调，用模块级 Promise 保证只跑一次。
 *
 * 顺序是有讲究的：
 *   - 迁移必须在**任何模块读旧布局**之前跑完（config.load 之前，因为迁移判据就写在 config 里）；
 *     这里先读一次原始 config 拿 layoutVersion，迁完再正式 load。
 *   - 索引库 open() 放在迁移之后：迁移会往库里写数据，先 open 会拿不到迁移前的正确状态。
 */
import config, { LAYOUT_VERSION } from './config.js'
import { notify as themeNotify } from './theme.js'
import { loadPlayerSettings, loadLastState } from './player/player.js'
import { load as loadHistory } from './player/history.js'
import { ensureDir } from './fsutil.js'
import { downloadsDir, cacheDir, thumbsDir } from './paths.js'
import { open as openDb } from './db.js'
import { run as runMigrate } from './migrate.js'
import { importFromFile, load as loadCookies, names as cookieNames } from './net/cookies.js'
import { cachedProfile, loggedIn, fetchProfile } from './ncm/login.js'
import { pullAll as autoPullLocalLists } from './player/locallists.js'
import { log } from './log.js'

let promise = null

/**
 * 存储就绪 —— **只建目录，不写任何数据**。
 *
 * 新布局下没有「目录不存在就写失败」这种前置条件（写文件会自建父目录），建目录只是为了
 * 让首次 `readdir`/`ls` 不报错、以及日志好排查。建目录走 fs.mkdir（原生调用、不 fork）。
 *
 * ⚠ 不要在这里写探测数据：任何一次写都可能是一次 fork（≈50ms），而它只验证目录在不在。
 */
async function prepareStore() {
  const a = await ensureDir(downloadsDir())
  const b = await ensureDir(cacheDir())
  const c = await ensureDir(thumbsDir())
  log('boot', '存储目录 downloads=' + a + ' cache=' + b + ' thumbs=' + c)
}

async function run() {
  await prepareStore()
  // 迁移判据在 config.json 里，所以先读原始值再决定要不要迁：
  // 缺失/小于当前版本 ⇒ 旧布局（含「全新安装」—— 全新安装没有任何旧数据，迁移会空跑一遍
  // 并把 layoutVersion 写成当前版本，这是最快的正确路径）。
  let v = 0
  try {
    const raw = await config.load()
    v = Number(raw.layoutVersion) || 0
  } catch (e) {
    v = 0
  }
  if (v < LAYOUT_VERSION) {
    try {
      await runMigrate(v)
    } catch (e) {
      // 迁移内部已逐步吞异常，这里兜住「迁移模块本身炸了」的情况：不阻塞启动。
      log('boot', '迁移异常（继续启动）：' + ((e && e.message) || e))
    }
    await config.load() // 迁移可能改写了 config.json，重新载一次
  }
  // 索引库：建表 + 整表灌内存（之后查询不再 fork，见 utils/db.js）
  await openDb()
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
