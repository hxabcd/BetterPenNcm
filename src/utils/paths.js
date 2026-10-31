/**
 * 可写目录路径的**单一来源**。
 *
 * 所有可写路径都从这里取，归一化只做一次（normDir：去尾斜杠 + 折叠重复斜杠）。
 * $dataDir 实测可能含双斜杠（`.../8000200708310039//data/`）；只归一化一处会拼出
 * `//covers` 这种混合形态。Linux 路径里 // 与 / 等价，本模块只保证形态一致、日志好看，
 * 不是行为修复（各调用方在设备上都能工作）。
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

/** 用户主动下载目录（永久保留，见 cache.js 头部的「缓存/下载分家」） */
export function musicDir() {
  return normDir() + '/music'
}

/** 播放缓存目录（边听边存，受「缓存上限」LRU 滚动） */
export function cacheDir() {
  return normDir() + '/cache'
}

/** 封面缓存目录 */
export function coversDir() {
  return normDir() + '/covers'
}

/** storage 持久化目录（框架安装时不建，store.js 首次写入前自愈创建） */
export function storageDir() {
  return normDir() + '/storage'
}

/**
 * 自建文件型存储目录（storage 拆分后的落地位置，见 utils/filestore.js）。
 * storage 的全部 key 落在同一个 preferences.json、每次写都重写整份，
 * 所以「大表」搬到这里，一张表一个 JSON 文件。
 */
export function storeDir() {
  return normDir() + '/store'
}

/** 歌词库目录（每首一个 JSON，见 utils/filestore.js 的 lrcPath） */
export function lrcDir() {
  return normDir() + '/lrc'
}

/** 会话 cookie 落盘文件（net/cookies.js 导入、ncm/login.js 退出登录时删） */
export function cookieFile() {
  return normDir() + '/cookie.txt'
}

/** curl 会话 jar（ncm/wecurl.js 扫码登录用） */
export function wecurlJarFile() {
  return normDir() + '/ncm_ck.txt'
}
