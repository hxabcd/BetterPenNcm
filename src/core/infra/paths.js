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
 * 两者都按 **每 track 一个目录** 组织，目录内是固定文件名（track.* / cover.jpg）。
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
 * kind 归一化：'download' 原样，其余（含 undefined / 拼错）一律按播放缓存。
 * 这是**唯一**的 kind 归一化点：调用方拿到外部传来的 kind 先过一次，不自己写 if。
 */
export function toKind(kind) {
  return kind === 'download' ? 'download' : 'cache'
}

/** kind → 通道根目录（经 toKind 归一，缺省 = 播放缓存） */
export function rootOf(kind) {
  return toKind(kind) === 'download' ? downloadsDir() : cacheDir()
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

/**
 * 本地索引库（**只**放索引表：album / artist / track / track_artist / playlist / playlist_track）。
 * 丢了能从文件与网络重建，所以它自己一个文件、可以整个删掉。
 */
export function dbFile() {
  return normDir() + '/local_index.db'
}

/**
 * 应用状态库：配置、登录凭据、播放会话快照、播放历史（`kv` 表），
 * 以及每曲元数据与歌词（`track_meta` / `track_lyric` 表）。
 *
 * 与索引库分开的理由：这些是**用户资产**（丢了要重新登录/丢进度），
 * 而索引是可重建的派生数据。分开后「重置索引」不会碰到登录态。
 * 两者都是 SQLite —— 平台 `fs` 没有写接口，文本数据写文件只能 fork 一次 shell
 * （真机 92~139ms，134KB 快照实测 2511ms），见 docs/存储重构.md §4。
 */
export function stateDbFile() {
  return normDir() + '/state.db'
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
