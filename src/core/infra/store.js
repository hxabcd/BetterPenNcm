/**
 * 顶层键值存储 —— 同名 API 的 **SQLite 实现**（原平台 storage 的替代）。
 *
 * ## 落在哪个库
 *
 * `state.db` 的 `kv` 表（见 [`paths.stateDbFile()`](paths.js) / utils/db.js）。
 * 这个库放的是**用户资产**：配置、登录 Cookie、播放会话快照、播放历史，
 * 以及每曲元数据与歌词。它和 `local_index.db`（可重建的索引）分开，
 * 重置索引不会碰到登录态。
 *
 * ## 为什么不写 JSON 文件
 *
 * 平台 `fs` 模块**没有写入接口**（只有 exists/stat/statfs/readdir/readFile/mkdir/rm），
 * 所以「一个 key 一个 JSON 文件」必须借 shell 重定向去写：`printf > tmp && mv -f`。
 * 那条路每次写都是一次 `process.exec` = 一次 fork（S7 真机实测 92~139ms/次），
 * 而且内容超过 60KB 还要分片、每片再一次 fork —— 播放会话快照（500 首队列 ≈134KB）
 * 一次落盘实测 **2511ms**，正好卡在「播放器切换/等待」的用户手势上。
 * 换成本模块的 kv 表后，同一份数据的写入是**一次 bind + step**，实测 10ms。
 *
 * ## 为什么保留 storage 的调用形态
 *
 * `config.js` / `net/cookies.js` / `player/history.js` / `player/session.js` 都是
 * 「读一个 key、拿到 JSON 字符串、自己 parse」的形状。这里保持同名同签名（异步、字符串值），
 * 那些模块的调用点一行都不用改。
 *
 * ## 一致性
 *
 * 写入是单行 `INSERT OR REPLACE`，读到的永远是完整一版（SQLite 自己的原子性），
 * 不需要 `mv -f` 那套临时文件把戏。**同一 key 的并发写在这里串行化并只保留最新一版** ——
 * 播放快照每 5~15 秒一写、切歌/暂停还会即时触发，合并写把它们压成一次。
 *
 * ## 失败语义
 *
 * 与旧实现一致：**不抛**。写失败返回 false 并记日志，读失败给 null。
 * 上层（config/session/history）都持有内存态，下一次写会重试。
 */
import { kvGet, kvPut, kvDel } from '../../core/platform/db.js'
import { log } from './log.js'

/* ---------------- key 常量（沿用旧 storage 的名字，上层不必改自己的 KEY） ---------------- */

export const KEY_SETTINGS = 'ncm_settings' // 应用配置
export const KEY_COOKIES = 'ncm_cookies' // 登录 Cookie
export const KEY_PLAYER_STATE = 'bpncm_player_state' // 播放会话快照
export const KEY_PLAY_HIST = 'bpncm_playhist' // 播放历史

/* ---------------- 读 ---------------- */

/** 读一个 key：返回字符串（可能是 JSON 文本）或 null */
export async function getStorage(key) {
  try {
    return await kvGet(String(key))
  } catch (e) {
    return null
  }
}

/* ---------------- 写（串行 + 合并） ---------------- */

const queues = {} // key → { busy, next }

/**
 * 写入一个 key。值按**原始字符串**存（上层给的就是 JSON 文本）。
 * 同一 key 的并发写只保留最新一版、一次在飞 —— 播放快照/历史都在 5~15 秒一次的节奏上。
 */
export function setStorage(key, value) {
  const k = String(key)
  const text = value === undefined || value === null ? '' : String(value)
  let q = queues[k]
  if (!q) q = queues[k] = { busy: false, next: null }
  return new Promise(function (resolve) {
    if (q.next) q.next.done(false) // 上一版被顶掉：数据是同一份内存态的最新版
    q.next = { text: text, done: resolve }
    if (!q.busy) drain(k, q)
  })
}

async function drain(k, q) {
  q.busy = true
  while (q.next) {
    const job = q.next
    q.next = null
    const ok = await kvPut(k, job.text)
    if (!ok) log('store', '写 kv 失败 ' + k + ' len=' + job.text.length)
    job.done(ok)
  }
  q.busy = false
}

/** 删除一个 key */
export async function removeStorage(key) {
  try {
    return await kvDel(String(key))
  } catch (e) {
    return false
  }
}

/**
 * 兼容旧调用点：原先用于「确保 `<data>/storage` 目录存在」（框架不建那个目录时
 * storage 写入一律失败，见 git 历史里的 store.js 注释）。
 *
 * SQLite 实现没有这个前置条件 —— 库文件与父目录由 utils/db.js 的 ensureDb 建。
 * 函数保留只是为了让 `boot.js` 等既有调用点不必改；返回值恒为 true。
 */
export async function ensureDir() {
  return true
}
