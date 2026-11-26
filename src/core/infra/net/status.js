
// 会话级网络状态（直接问系统，不靠传输层记账）。
// 判据 = 系统 API `global.isOnline()`（原生 JSGlobalProxy，同步返回「有无互联网出口」）——
// ≠ wifi.isConnected()：前者 = 能不能上网，后者 = WiFi 链路通不通（官方播放器字节码交叉验证）。
// 兜底：global 导不进来（平台差异）或调用抛错 → 退回传输层记账：
//   - reportNet() 由 request.js 上报；最近一次失败起 60s 内视为离线，任何一次成功立即翻回在线
//     （HTTP 状态码 >0 就算在线 —— 401/500 也是「摸到了服务器」）
//   - log.js 不走 request.js（logserver 没在跑是常态），不会污染这份状态
import { log } from '../log.js'

let globalInst = null // Global 单例
let globalLoad = null // 载入 Promise（并发调用只导一次）

async function getGlobal() {
  if (globalInst) return globalInst
  if (!globalLoad) {
    globalLoad = import('global')
      .then(function (m) {
        const Global = (m && m.Global) || (m && m.default && m.default.Global) || null
        globalInst = Global ? new Global() : null
        if (!globalInst) log('netstatus', 'global 模块没有 Global 导出，退回传输层记账')
        return globalInst
      })
      .catch(function (e) {
        log('netstatus', 'global 模块载入失败，退回传输层记账：' + ((e && e.message) || e))
        return null
      })
  }
  return globalLoad
}

// 最近一次传输失败的时间戳；0 = 在线（或还没失败过）
let offlineAt = 0 

const OFFLINE_MS = 60000

// request.js 每次请求后上报：ok = 真的摸到了服务器（status>0）；仅系统 API 不可用时生效
export function reportNet(ok) {
  offlineAt = ok ? 0 : Date.now()
}

// 当前是否应按「离线」处理 —— 系统说没网就是离线；系统状态取不到（模块缺失 / 调用抛错）时
// 退回传输层记账
export async function isOffline() {
  try {
    const g = await getGlobal()
    if (g && typeof g.isOnline === 'function') return !g.isOnline()
  } catch (e) {}
  return offlineAt > 0 && Date.now() - offlineAt < OFFLINE_MS
}
