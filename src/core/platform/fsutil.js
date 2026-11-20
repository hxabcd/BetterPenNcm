/**
 * fs 小工具：模块句柄单例 + 全工程共用的读/删/建目录。
 *
 * 约定：
 *   - 所有函数**不抛异常**：失败返回安全默认（0 / false / '' / []）；调用方无需再包 try。
 *   - **只做原生调用**：`fs` 的 exists / stat / statfs / readdir / readFile / mkdir / rm
 *     都是 native（微秒级、不分叉）。建目录与递归删除都走 `mkdir` / `rm`，不再 fork shell。
 *   - 平台 `fs` **没有写入接口**（`writeFile` / `rename` / `unlink` 是 undefined），
 *     所以**这里没有写函数**：文本一律进 SQLite（`utils/db.js` 的 kv / track_meta /
 *     track_lyric）。历史上的 `printf > tmp && mv -f` 通道已删除 —— 它每次写都是一次
 *     `process.exec`（真机 92~139ms），134KB 的播放快照分片写实测 2511ms。
 */
import { log } from '../../core/infra/log.js'

let fsMod = null

/** fs 模块句柄（平台模块可能包一层 default，两种形态都兼容） */
export async function getFs() {
  if (!fsMod) {
    const m = await import('fs')
    fsMod = (m && m.default) || m
  }
  return fsMod
}

/** 文件字节数；不存在/出错给 0 */
export async function fileSize(p) {
  try {
    const fs = await getFs()
    if (!(await fs.exists(p))) return 0
    const st = await fs.stat(p)
    return (st && st.size) || 0
  } catch (e) {
    return 0
  }
}

/** 是否存在。**fs.exists 是 native 调用、不走 exec（不 fork）** ——
 *  fetcher.js 的进度轮询每 300ms 调一次就靠这一点（fork 一次要 92ms，绝不能拿来轮询） */
export async function fileExists(p) {
  try {
    const fs = await getFs()
    return !!(await fs.exists(p))
  } catch (e) {
    return false
  }
}

/** 删除路径（文件或目录，**递归**）。删不掉静默（包括「本来就不存在」） */
export async function rmQuiet(p) {
  try {
    const fs = await getFs()
    await fs.rm(p)
  } catch (e) {}
}

/** 读目录名列表（归一成字符串数组）；目录不存在/出错给 []。
 *  readdir 的条目可能是字符串也可能是 {name}（平台差异），这里统一抹平 */
export async function readNames(dir) {
  try {
    const fs = await getFs()
    const names = (await fs.readdir(dir)) || []
    const out = []
    for (let i = 0; i < names.length; i++) {
      const name = typeof names[i] === 'string' ? names[i] : names[i] && names[i].name
      if (name) out.push(name)
    }
    return out
  } catch (e) {
    return []
  }
}

/** stat 对象（{size, mtimeMs/mtime, ...}）；出错给 null */
export async function statOf(p) {
  try {
    const fs = await getFs()
    return (await fs.stat(p)) || null
  } catch (e) {
    return null
  }
}

const readyDirs = {} // 已确认存在的目录（幂等缓存，免得每次写盘都 exists 一次）

/** 确保目录存在（幂等；失败返回 false，只记一次日志）。
 *  `fs.mkdir` 在真机上**自动建多级父目录**（实测 `a/b/c` 一次成功），不需要 `-p` */
export async function ensureDir(dir) {
  if (readyDirs[dir]) return true
  let ok = false
  try {
    const fs = await getFs()
    try {
      ok = await fs.exists(dir)
    } catch (e) {}
    if (!ok) {
      try {
        await fs.mkdir(dir)
        ok = true
      } catch (e) {}
    }
  } catch (e) {
    ok = false
  }
  readyDirs[dir] = !!ok
  return !!ok
}

/**
 * 删文件（原生 `fs.rm`）。
 * 保留这个导出只是为了让既有调用点（cover / download / login）不必改；
 * 语义与 `rmQuiet` 一致，返回值以「文件确实不在了」为准。
 */
export async function removePath(path) {
  await rmQuiet(path)
  return !(await fileExists(path))
}

/**
 * 删整个目录（原生 `fs.rm`，**本身递归**，不需要 `rm -rf`）。
 * 目录不在也算成功。
 */
export async function removeTree(dir) {
  await rmQuiet(dir)
  readyDirs[dir] = false // 目录没了，下次 ensureDir 要重新建
  return !(await fileExists(dir))
}
