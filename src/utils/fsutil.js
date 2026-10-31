/**
 * fs 小工具：模块句柄单例 + 全工程共用的读/写/删除/建目录。
 *
 * 约定：
 *   - 所有函数**不抛异常**：失败返回安全默认（0 / false / '' / []）；调用方无需再包 try。
 *   - 删除一律「尽力而为」：删不掉不报错（Linux 语义下 fd 仍有效，见各调用方注释）。
 *   - **平台 fs 模块没有写入接口**（只有 exists/stat/statfs/readdir/readFile/mkdir/rm），
 *     `global` 的 createFile 也只建空文件 —— 写内容只能 `/bin/sh` 重定向，
 *     所以 writeTextFile 每次写 = 一次 fork（真机裸 fork 48~52ms）。
 *     ⇒ 只有「低频、按需」的写入才走它；高频小块留给原生 storage（见 utils/filestore.js 的取舍表）。
 */
import { run } from './exec.js'
import { log } from './log.js'

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
 *  fetcher.js 的进度轮询每 300ms 调一次就靠这一点（exec 一次要 48ms，绝不能拿来轮询） */
export async function fileExists(p) {
  try {
    const fs = await getFs()
    return !!(await fs.exists(p))
  } catch (e) {
    return false
  }
}

/** 删除文件，删不掉静默（包括「本来就不存在」） */
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
 *  store.js 的 storage 目录自愈与 cover.js / download.js 的建目录都走这里 */
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

/* ---------------- 读 / 写文本文件（写走 shell 重定向） ---------------- */

/** 单条命令里内容的字节上限：`/bin/sh -c <整串>` 是**一个 argv**，Linux 单参数上限 128KB，
 *  这里取 60KB 留足转义与路径的余量（超了自动分片追加） */
const CHUNK_BYTES = 60000
const WRITE_TIMEOUT = 20000

/** 单引号包裹：内部的 ' 变成 '\''。引号内的 $ ` \ 与换行 shell 都不解释 */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** 按「转义后的字节数」切片（'?' → 4 字节，中文 → 3 字节）；空串返回 [''] */
function chunk(s, max) {
  const out = []
  let buf = ''
  let cost = 0
  for (let i = 0; i < s.length; i++) {
    let c = s.charAt(i)
    let add = 0
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      // 别把代理对劈开：一次吃两个 char（4 字节）
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        c += s.charAt(++i)
        add = 4
      } else add = 3
    } else if (c === "'") {
      add = 4 // '\'' 
    } else if (code < 0x80) {
      add = 1
    } else if (code < 0x800) {
      add = 2
    } else {
      add = 3
    }
    if (cost + add > max && buf) {
      out.push(buf)
      buf = ''
      cost = 0
    }
    buf += c
    cost += add
  }
  out.push(buf)
  return out
}

/** 读文本文件；不存在/出错一律给 ''（不抛） */
export async function readTextFile(path) {
  try {
    const fs = await getFs()
    if (!(await fs.exists(path))) return ''
    const t = await fs.readFile(path)
    return t === undefined || t === null ? '' : String(t)
  } catch (e) {
    return ''
  }
}
/**
 * 写文本文件（**原子替换**：先写 `<path>.tmp` 再 `mv -f`，读到的永远是完整一版）。
 * 内容超过 60KB 自动分片：**每片一条命令、各一次 exec**（整串命令本身就是一个 argv，
 * 把多片拼进同一条命令不会绕过 128KB 上限），最后一片带上 `mv`。
 * 返回是否成功；失败只记日志（调用方决定要不要回退）。
 */
export async function writeTextFile(path, text) {
  const s = text === undefined || text === null ? '' : String(text)
  const i = path.lastIndexOf('/')
  if (i > 0) await ensureDir(path.slice(0, i))
  const tmp = path + '.tmp'
  const parts = chunk(s, CHUNK_BYTES)
  for (let k = 0; k < parts.length; k++) {
    const last = k === parts.length - 1
    let cmd = 'printf \'%s\' ' + shq(parts[k]) + (k === 0 ? ' > ' : ' >> ') + shq(tmp)
    if (last) cmd += ' && mv -f ' + shq(tmp) + ' ' + shq(path)
    let r = null
    try {
      r = await run(cmd, WRITE_TIMEOUT)
    } catch (e) {
      r = null
    }
    if (!r || r.code !== 0) {
      log('fs', '写文件失败 ' + path + ' len=' + s.length + ' 片=' + (k + 1) + '/' + parts.length +
        ' rc=' + (r && r.code) + ' err=' + String((r && r.stderr) || '').slice(0, 80))
      try {
        await rmQuiet(tmp)
      } catch (e) {}
      return false
    }
  }
  return true
}

/** 删文件（shell rm -f 优先，失败回退 fs.rm）。文件本来不存在也算成功 */
export async function removePath(path) {
  let r = null
  try {
    r = await run('rm -f ' + shq(path), 8000)
  } catch (e) {
    r = null
  }
  if (r && r.code === 0) return true
  await rmQuiet(path)
  return !(await fileExists(path))
}

/** 删整个目录（shell rm -rf 优先，失败回退逐个 fs.rm） */
export async function removeTree(dir) {
  let r = null
  try {
    r = await run('rm -rf ' + shq(dir), 20000)
  } catch (e) {
    r = null
  }
  if (r && r.code === 0) return true
  const names = await readNames(dir)
  for (let i = 0; i < names.length; i++) await rmQuiet(dir + '/' + names[i])
  readyDirs[dir] = false // 目录没了，下次 ensureDir 要重新建
  return true
}
