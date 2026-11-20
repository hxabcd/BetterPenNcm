/**
 * 远程日志 / 屏幕日志
 *
 * 为什么需要：console.log 不会进 /data/applog/YD_PEN_APP.log（设备实测），
 * 唯一可靠的观测通道是把日志 POST 回 PC 上的 scripts/logserver.py。
 *
 * 注意：这里**直接**使用内建 http 模块，不经过 utils/net/request.js——
 *   1) 避免与 Cookie 层互相递归（request -> cookies -> log -> request）
 *   2) 日志请求不该带业务 Cookie
 * 所有日志都在尝试失败时静默（PC 没起 logserver 时不能影响业务）。
 *
 * 日志服务器地址（开源清理）：不把内网 IP 写进仓库。
 * 开发构建时用环境变量指定：`BPNCM_LOG_SRV=http://<你的PC>:8888/log bash scripts/build.sh`
 *（build.sh 把它写进生成文件 logconfig.generated.js；生成物不进仓库）。
 * 未注入时使用下行常量里的回环缺省地址 —— 设备上连不通、POST 静默失败
 *（等价于「没跑 logserver」），对功能零影响。
 */
import { LOG_SRV } from './logconfig.generated.js'
// 生成物为空（未注入 BPNCM_LOG_SRV）→ 回环缺省：设备上连不通、静默失败，功能零影响
const SRV = LOG_SRV || 'http://127.0.0.1:8888/log'
const MAX = 30

let httpMod = null
async function getHttp() {
  if (!httpMod) {
    const m = await import('http')
    httpMod = (m && m.default) || m
  }
  return httpMod
}

const ring = [] // 最近若干条，供界面直接显示（PC 不在线时也能看）
const subs = []

export function tail(n) {
  return ring.slice(-(n || 8))
}

export function onLog(fn) {
  subs.push(fn)
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
  for (let i = 0; i < subs.length; i++) {
    try {
      subs[i](line)
    } catch (e) {}
  }
  // 第二通道：console.warn 会以 console(<appid>).warn.N 前缀进 /data/applog/YD_PEN_APP.log
  // （console.log 不进；console.warn 会进系统日志）——PC 收不到时有兜底
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

/** 把任意对象转成简短可读串（日志用） */
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
