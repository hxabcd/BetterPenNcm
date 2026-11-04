/**
 * 可写路径的**单一来源**。
 *
 * 布局见 docs/存储重构.md §2。所有可写路径都从这里取，归一化只做一次
 * （normDir：去尾斜杠 + 折叠重复斜杠）。
 * $dataDir 实测可能含双斜杠（`.../8000200708310039//data/`）；只归一化一处会拼出
 * `//downloads` 这种混合形态。Linux 路径里 // 与 / 等价，本模块只保证形态一致、日志好看，
 * 不是行为修复（各调用方在设备上都能工作）。
 *
 * 两条通道的语义（贯穿全应用）：
 *   downloads/ —— 用户主动下载，**永久保留**，计入「本地下载」
 *   cache/     —— 边听边存，受「缓存上限」LRU 滚动，不计入「本地下载」
 * 两者都按 **每 track 一个目录** 组织，目录内是固定文件名（track.* / cover.jpg / metadata.json）。
 */

/** $dataDir 归一化：去尾斜杠 + 折叠中间重复斜杠（末尾带 / 时切片会留下一个 '//'） */
export function normDir() {
  /* global $dataDir */
  const d = String($dataDir || '')
  return d.replace(/\/+$/, '').replace(/\/{2,}/g, '/')
}

/** 应用数据根目录（= 归一化后的 $dataDir） */
export function dataDir() {
  return normDir()
}

/* ---------------- 根目录（两条媒体通道） ---------------- */

/** 用户主动下载目录（永久保留） */
export function downloadsDir() {
  return normDir() + '/downloads'
}

/** 播放缓存目录（边听边存，受「缓存上限」LRU 滚动） */
export function cacheDir() {
  return normDir() + '/cache'
}

/** 浏览缩略图目录（可整体清空；不属于任何曲目记录，见 docs/存储重构.md §0.1.1） */
export function thumbsDir() {
  return cacheDir() + '/thumbs'
}

/**
 * kind → 通道根目录。'download' = 用户下载，其余一律按播放缓存。
 * 这是**唯一**的 kind 归一化点：调用方传 'download' / 'cache'，不自己写 if。
 */
export function rootOf(kind) {
  return kind === 'download' ? downloadsDir() : cacheDir()
}

/* ---------------- 单个 track 的目录与文件 ---------------- */

/** 某个 track 在某条通道下的目录：`<root>/<id>` */
export function trackDir(id, kind) {
  return rootOf(kind) + '/' + String(id)
}

/**
 * 音频文件路径。扩展名由直链回包的 type 定：无损档 = .flac，其余 .mp3。
 * ⚠ 文件名固定 `track`，不含 id —— id 已经在目录名上，目录内不需要重复。
 */
export function trackFile(id, ext, kind) {
  return trackDir(id, kind) + '/track.' + (ext === 'flac' ? 'flac' : 'mp3')
}

/** 同目录另一种扩展名的路径（换音质后清理旧文件用；**只在本目录内找**） */
export function altTrackFile(id, ext, kind) {
  return trackFile(id, ext === 'flac' ? 'mp3' : 'flac', kind)
}

/** 曲目封面：单尺寸 200px（两种通道同名，见 docs/存储重构.md §0.1） */
export function trackCover(id, kind) {
  return trackDir(id, kind) + '/cover.jpg'
}

/** 曲目歌词（只有 downloads/ 有；cache/ 的歌会被 LRU 滚掉，存词即孤儿数据） */
export function trackLyrics(id, kind) {
  return trackDir(id, kind) + '/lyrics.json'
}

/** 曲目元数据（显示信息 + 档位 + 下载归属 + LRU 时间） */
export function trackMeta(id, kind) {
  return trackDir(id, kind) + '/metadata.json'
}

/* ---------------- 顶层文件 ---------------- */

/** 应用配置（原 storage 的 ncm_settings） */
export function configFile() {
  return normDir() + '/config.json'
}

/** 登录 Cookie（原 storage 的 ncm_cookies） */
export function cookiesFile() {
  return normDir() + '/cookie.json'
}

/** 播放会话快照（原 storage 的 bpncm_player_state；高频小块，留 JSON 文件） */
export function stateFile() {
  return normDir() + '/state.json'
}

/** 播放历史（原 storage 的 bpncm_playhist；高频小块，留 JSON 文件） */
export function historyFile() {
  return normDir() + '/history.json'
}

/** SQLite 索引库（表：album/artist/track/track_artist/playlist/playlist_track） */
export function dbFile() {
  return normDir() + '/local_index.db'
}

/* ---------------- 旧通道（仅 utils/migrate.js 读取；新代码不得调用） ---------------- */

/** 旧封面目录 */
export function legacyCoversDir() {
  return normDir() + '/covers'
}

/** 旧 store/ 目录 */
export function legacyStoreDir() {
  return normDir() + '/store'
}

/** 旧歌词目录 */
export function legacyLrcDir() {
  return normDir() + '/lrc'
}

/** 旧下载目录 */
export function legacyMusicDir() {
  return normDir() + '/music'
}

/** 旧 storage 目录 */
export function legacyStorageDir() {
  return normDir() + '/storage'
}

/* ---------------- 其它既有落点 ---------------- */

/** 会话 cookie 落盘文件（adb 递会话的导入通道，net/cookies.js 读取；退出登录时删） */
export function cookieFile() {
  return normDir() + '/cookie.txt'
}

/** curl 会话 jar（ncm/wecurl.js 扫码登录用） */
export function wecurlJarFile() {
  return normDir() + '/ncm_ck.txt'
}

/* ---------------- 兼容别名（旧导出名，逐步淘汰） ---------------- */

/** @deprecated 旧名：用户下载目录。新代码用 downloadsDir() */
export function musicDir() {
  return downloadsDir()
}

/** @deprecated 旧名：封面缓存目录。新代码用 thumbsDir()（浏览缩略图）或 trackCover() */
export function coversDir() {
  return thumbsDir()
}
