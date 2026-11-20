/**
 * 会话级网络状态（**直接问系统，不再靠传输层记账**）
 *
 * 为什么需要它：详情页（songinfo/artist/album）离线的数据源是本地索引，
 * 但「先试网络、12s 超时后再兜底」在断网时每页都要干等一轮超时（artist 页三段
 * 串行最坏 36s）。反过来「本地先出、网络回来再覆盖」在线时又会闪一下本地视图。
 *
 * 判据 = 系统 API `global.isOnline()`（原生 JSGlobalProxy，同步返回「有无互联网出口」）。
 * 出处：Global 模块 API 实测（§3.3）；`≠ wifi.isConnected()`
 * （前者=能不能上网，后者=WiFi 链路通不通）这条语义由官方播放器字节码交叉验证。
 * 比旧的传输层记账准在时点上：记账要等一次请求真失败才知道断网（首屏先白等一轮
 * 超时），系统状态在断网当场就已经翻掉了。
 *
 * 兜底：`global` 导不进来（平台差异）或调用抛错 → 退回记账口径
 *   - reportNet() 由 request.js 上报；最近一次**失败**起 60s 内视为离线，任何一次
 *     成功立即翻回在线（HTTP 状态码 >0 就算在线 —— 401/500 也是「摸到了服务器」）
 *   - log.js 不走 request.js（logserver 没在跑是常态），不会污染这份状态
 */
import { log } from '../log.js'

/* ---------------- 系统 API：global.isOnline() ---------------- */

let globalInst = null // Global 单例（业务层自行缓存，见模块文档）
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

/* ---------------- 兜底：传输层记账 ---------------- */

let offlineAt = 0 // 最近一次传输失败的时间戳；0 = 在线（或还没失败过）

const OFFLINE_MS = 60000

/** request.js 每次请求后上报：ok = 真的摸到了服务器（status>0）；仅系统 API 不可用时生效 */
export function reportNet(ok) {
  offlineAt = ok ? 0 : Date.now()
}

/**
 * 当前是否应按「离线」处理 —— 系统说没网就是离线。
 * 系统状态取不到（模块缺失 / 调用抛错）时退回传输层记账。
 */
export async function isOffline() {
  try {
    const g = await getGlobal()
    if (g && typeof g.isOnline === 'function') return !g.isOnline()
  } catch (e) {}
  return offlineAt > 0 && Date.now() - offlineAt < OFFLINE_MS
}
