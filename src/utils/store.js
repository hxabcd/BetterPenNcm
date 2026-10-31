/**
 * storage 封装（带目录自愈 + 调用形态兼容）
 *
 * 踩到的坑（实测）：**框架安装应用时不创建 `<appdata>/data/storage/` 目录，
 * 目录不存在时 storage 模块的 setStorage 一律失败** —— 与写入时机（启动后 0/5/15/30/60 秒）、
 * 长度（10~2000 字符）、内容（纯文本 / JSON）都无关，全部失败；
 * 手工 `mkdir <appdata>/data/storage` 之后立刻恢复正常，落盘在
 * `<appdata>/data/storage/preferences.json`（扁平 JSON 字符串表）。
 * 本应用是用 `miniapp_cli install` 装的，推测官方 PMS 安装路径会建目录、这条路径不会。
 *
 * 另按社区应用 PenMusic 的做法（存储三级降级）
 * 兼容 setStorage 的多种调用形态，失败时降级而不是抛出去。
 */
import { log } from './log.js'
import { ensureDir as ensureFsDir } from './fsutil.js'
import { storageDir } from './paths.js'

let storageMod = null

async function getMod() {
  if (!storageMod) {
    const m = await import('storage')
    storageMod = (m && m.default) || m
  }
  return storageMod
}

let readyLogged = false // 只在首次（或失败时）记日志，避免每次写盘都刷一条

/** 确保 <appdata>/data/storage 存在（存在即幂等，失败只记一次日志） */
export async function ensureDir() {
  const ok = await ensureFsDir(storageDir())
  if (!readyLogged || !ok) {
    readyLogged = true
    log('store', 'storage 目录就绪=' + ok)
  }
  return ok
}

export async function getStorage(key) {
  try {
    const st = await getMod()
    const v = await st.getStorage(key)
    return v === undefined ? null : v
  } catch (e) {
    return null
  }
}

/** 写入；返回是否成功。失败时按文档兼容 {key,data} 形态再试一次 */
export async function setStorage(key, value) {
  await ensureDir()
  const st = await getMod()
  try {
    await st.setStorage(key, value)
    return true
  } catch (e) {
    try {
      await st.setStorage({ key: key, data: value })
      return true
    } catch (e2) {
      // 值一律不回显：里面可能有登录凭据
      log('store', 'setStorage 失败 key=' + key + ' len=' + String(value || '').length)
      return false
    }
  }
}

export async function removeStorage(key) {
  try {
    const st = await getMod()
    await st.removeStorage(key)
    return true
  } catch (e) {
    return false
  }
}
