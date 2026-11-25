/**
 * 顶层键值存储 —— SQLite 实现（替代平台 storage），值落 `state.db` 的 `kv` 表
 * （两个库的分工见 core/platform/db.js 头注释）。
 *
 * 失败语义：**不抛** —— 写失败返回 false 并记日志、读失败给 null。上层
 * （config/session/history）都持有内存态，下一次写会重试。
 *
 * 一致性：写入是单行 `INSERT OR REPLACE`，读到的永远是完整一版；**同一 key 的并发写
 * 在这里串行化并只保留最新一版**（播放快照每 5~15 秒一写、切歌/暂停还即时触发，合并写压成一次）。
 */
import { kvGet, kvPut, kvDel } from '../../core/platform/db.js'
import { log } from './log.js'

/* ---------------- key 常量（沿用旧 storage 的名字，上层不必改自己的 KEY） ---------------- */

export const KEY_SETTINGS = 'ncm_settings' // 应用配置
export const KEY_PLAYER_STATE = 'bpncm_player_state' // 播放会话快照
export const KEY_PLAY_HIST = 'bpncm_playhist' // 播放历史
export const KEY_DL_PENDING = 'bpncm_dl_pending' // 批量下载队列快照（退出/被强杀后下次启动续传）

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
 * SQLite 实现没有这个前置条件 —— 库文件与父目录由 core/platform/db.js 的 ensureDb 建。
 * 函数保留只是为了让 `boot.js` 等既有调用点不必改；返回值恒为 true。
 */
export async function ensureDir() {
  return true
}
