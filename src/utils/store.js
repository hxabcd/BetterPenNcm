/**
 * 顶层 JSON 键值存储 —— 同名 API 的**文件实现**（原平台 storage 的替代）。
 *
 * ## 为什么换掉平台 storage
 *
 * 平台 `storage`（`libfalcon.so` 的 `JQuick::SharedPreferences`）把**全部 key 写在同一个文件**
 * `<appdata>/data/storage/preferences.json`，`setStorage` 一次 = 整份重写一次，
 * 写代价 ∝ 全库总量、与这次写的是哪个 key 无关（实测约 0.13ms/KB，147KB 库单次写 ≈20ms）。
 *
 * 新布局把它们拆成**一个 key 一个文件**（`config.json` / `cookie.json` / `state.json` /
 * `history.json`，见 docs/存储重构.md §2），单次写的代价只与那条数据本身有关。
 * 顺带的收益：这些文件可以直接 adb 拖下来看/改，不再依赖框架的私有格式。
 *
 * ## 为什么保留 storage 的调用形态
 *
 * `config.js` / `net/cookies.js` / `player/history.js` / `player/session.js` 都是
 * 「读一个 key、拿到 JSON 字符串、自己 parse」的形状。这里保持同名同签名（异步、字符串值），
 * 那四个模块一行都不用改。
 *
 * ## 一致性
 *
 * 写走 `fsutil.writeTextFile`（`printf` 重定向 + `mv -f` 原子替换），所以读到的永远是完整一版。
 * **写要 fork（≈50ms）**，所以调用方必须保持「低频、合并写」的用法：
 * 播放快照/历史各自已有合并写节流（见 session.js / history.js 的注释），不要在这层再加轮询。
 *
 * ## 失败语义
 *
 * 与旧实现一致：**不抛**。写失败返回 false 并记日志，读失败给 null。
 * 这里**不做**「写失败就写 storage 兜底」—— 两处都写会让「哪份是真的」变成需要判断的事，
 * 而现在只有文件是真相。上层（config/session/history）都持有内存态，下一次写会重试。
 */
import { readTextFile, writeTextFile, ensureDir as ensureDirImpl, removePath } from './fsutil.js'
import { configFile, cookiesFile, stateFile, historyFile, normDir } from './paths.js'
import { log } from './log.js'

/* ---------------- key → 文件 ---------------- */

/**
 * 历史 key 与新文件的对应关系。
 * 这几个 key 是旧 storage 里的名字，原样保留 —— 迁移脚本按这张表把值搬过来，
 * 上层模块也就不必跟着改自己的 KEY 常量。
 */
const FILE_BY_KEY = {
  ncm_settings: configFile, // 应用配置
  ncm_cookies: cookiesFile, // 登录 Cookie
  bpncm_player_state: stateFile, // 播放会话快照
  bpncm_playhist: historyFile // 播放历史
}

/** 未登记的 key 落 `data/kv/<安全名>.json`（probe 页等临时用途，不与上面四个混在一起） */
function fileFor(key) {
  const known = FILE_BY_KEY[key]
  if (known) return known()
  const safe = String(key).replace(/[^A-Za-z0-9_.-]/g, '_')
  return normDir() + '/kv/' + safe + '.json'
}

/* ---------------- 读 ---------------- */

/** 读一个 key：返回字符串（可能是 JSON 文本）或 null。每次读都走原生 fs.readFile，不分叉 */
export async function getStorage(key) {
  try {
    const t = await readTextFile(fileFor(key))
    return t || null
  } catch (e) {
    return null
  }
}

/* ---------------- 写（串行 + 合并） ---------------- */

const queues = {} // path → { busy, next }

/**
 * 写入一个 key。值按**原始字符串**落盘（上层给的就是 JSON 文本）。
 * 同一文件的并发写只保留最新一版、一次在飞 —— 播放快照/历史都在 5~15 秒一次的节奏上，
 * 合并写把它们压成一次 fork。
 */
export function setStorage(key, value) {
  const path = fileFor(key)
  const text = value === undefined || value === null ? '' : String(value)
  let q = queues[path]
  if (!q) q = queues[path] = { busy: false, next: null }
  return new Promise(function (resolve) {
    if (q.next) q.next.done(false) // 上一版被顶掉：数据是同一份内存态的最新版
    q.next = { text: text, done: resolve }
    if (!q.busy) drain(path, q)
  })
}

async function drain(path, q) {
  q.busy = true
  while (q.next) {
    const job = q.next
    q.next = null
    const i = path.lastIndexOf('/')
    if (i > 0) await ensureDir(path.slice(0, i))
    const ok = await writeTextFile(path, job.text)
    if (!ok) log('store', '写文件失败 ' + path + ' len=' + job.text.length)
    job.done(ok)
  }
  q.busy = false
}

/** 删除一个 key（= 删掉对应文件） */
export async function removeStorage(key) {
  try {
    return await removePath(fileFor(key))
  } catch (e) {
    return false
  }
}

/**
 * 兼容旧调用点：原先用于「确保 `<data>/storage` 目录存在」（框架不建那个目录时
 * storage 写入一律失败，见 git 历史里的 store.js 注释）。
 *
 * 文件实现没有这个前置条件 —— `writeTextFile` 会自己建父目录。函数保留只是为了让
 * `boot.js` 等既有调用点不必改；返回是否可用恒为 true。
 */
export async function ensureDir() {
  return ensureDirImpl(normDir())
}
