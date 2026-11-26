
// 远程日志 / 屏幕日志。
// console.log 不进 /data/applog/YD_PEN_APP.log（设备实测）—— 唯一可靠的观测通道是把日志
// POST 回 PC 上的 scripts/logserver.py。
// 这里直接使用内建 http 模块，不经过 core/infra/net/request.js：
//   1) 避免与 Cookie 层互相递归（request -> cookies -> log -> request）
//   2) 日志请求不该带业务 Cookie
// 所有日志请求失败都静默（PC 没起 logserver 时不能影响业务）。
// 日志服务器地址不写进仓库：构建时用 BPNCM_LOG_SRV=http://<PC>:8888/log 注入
// （build.sh 写进生成物 logconfig.generated.js）；未注入时走下面的回环缺省，功能零影响

import { LOG_SRV } from './logconfig.generated.js'
// 生成物为空（未注入 BPNCM_LOG_SRV）→ 回环缺省：设备上连不通、静默失败
const SRV = LOG_SRV || 'http://127.0.0.1:8888/log'
const MAX = 30

let httpReady = null
function getHttp() {
  if (!httpReady) httpReady = loadHttp()
  return httpReady
}

// X3S 没有 http 裸模块 → 回退到原生桥（见 core/platform/bridge.js）
async function loadHttp() {
  try {
    const m = await import('http')
    const mod = (m && m.default) || m
    if (mod && typeof mod.request === 'function') return mod
  } catch (e) {}
  try {
    const b = await import('../platform/bridge.js')
    return await b.bridgeHttp()
  } catch (e) {
    return null
  }
}

const ring = [] // 最近若干条，供界面直接显示（PC 不在线时也能看）

export function tail(n) {
  return ring.slice(-(n || 8))
}

export function log(tag, msg) {
  const line =
    '[' +
    new Date().toTimeString().slice(0, 8) +
    '][' +
    tag +
    '] ' +
    (msg === undefined || msg === null ? '' : String(msg))
  ring.push(line)
  if (ring.length > MAX) ring.shift()

  // 第二通道：console.warn 会以 console(<appid>).warn.N 前缀进 /data/applog/YD_PEN_APP.log
  // （console.log 不进、console.warn 进系统日志）—— PC 收不到时有兜底
  try {
    console.warn(line)
  } catch (e) {}
  post(line)
  return line
}

async function post(line) {
  try {
    const h = await getHttp()
    // 原始 body 必须放 data 字段（设备实测，其他字段名发空体）
    await h.request({
      url: SRV,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      data: line,
      timeout: 4000
    })
  } catch (e) {}
}

export function brief(o, max) {
  let s
  try {
    s = typeof o === 'string' ? o : JSON.stringify(o)
  } catch (e) {
    s = String(o)
  }
  if (!s) s = String(o)
  const m = max || 300
  return s.length > m ? s.slice(0, m) + '...' : s
}

export default log
