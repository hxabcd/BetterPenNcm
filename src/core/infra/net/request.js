/**
 * 网络传输层 —— 业务请求唯一直接使用运行时 http 模块的地方。
 * 运行时实测结论：
 *   const http = await import('http')            // 内建模块，curl 内核
 *   await http.request({url, method, headers, data, timeout}) -> {status, headers, body}
 *     - 原始 body 用 data 字段（body/params/form/raw 均无效，实测空体）
 *   await http.postFormData({url, data:{...}})   -> 表单（multipart）
 *   await http.download({url, outPath})          -> 文件落盘（实测 149KB 图片成功）
 *
 * 实测边界（S7，2026-10-17）：
 *   - request 的响应体按 C 字符串返回，**遇到第一个 NUL 就截断** → 只用于文本/JSON；
 *     图片/音频/protobuf 用 download 或 curl（`AB\0CD` 只回 `AB`，MP3 只回 `ID3\x03`）
 *   - download 返回时文件可能还剩最后一块未 flush → 读 size 前等 100ms 或轮询到稳定
 *
 * 追加：Cookie 会话。curl 内核未开 cookie 引擎，收发都靠 net/cookies.js
 * 手工维护——发请求前注入 Cookie 头，收响应后吸收 set-cookie。
 */
import { load as loadCookies, header as cookieHeader, absorbHeaders } from './cookies.js'
import { reportNet } from './status.js'

let httpMod = null

async function getHttp() {
  if (!httpMod) {
    const m = await import('http')
    httpMod = (m && m.default) || m
  }
  return httpMod
}

/** 合并业务 headers 与 Cookie 头 */
async function buildHeaders(extra) {
  await loadCookies()
  const h = Object.assign({}, extra || {})
  const ck = cookieHeader()
  if (ck && !h.Cookie && !h.cookie) h.Cookie = ck
  return h
}

/**
 * 通用请求；opts: {url, method, headers, data, timeout, raw}
 * raw=true 时额外返回原始响应对象（排查用）
 */
export async function request(opts) {
  const h = await getHttp()
  const headers = await buildHeaders(opts.headers)
  let r
  try {
    r = await h.request({
      url: opts.url,
      method: opts.method || 'GET',
      headers: headers,
      data: opts.data,
      timeout: opts.timeout || 12000
    })
  } catch (e) {
    reportNet(false) // 兜底记账：仅当系统 API（global.isOnline）不可用时才生效，见 status.js
    throw e
  }
  const status = (r && (r.status || r.statusCode)) || 0
  reportNet(status > 0) // 摸到服务器就算在线（401/500 也是在线）
  const rh = (r && r.headers) || {}
  await absorbHeaders(rh) // 有 set-cookie 就收下（失败静默）
  return {
    status: status,
    headers: rh,
    body: (r && r.body) || '',
    raw: opts.raw ? r : undefined
  }
}

/** 下载到本地文件；opts: {url, outPath, headers, timeout}
 *  ⚠ 返回时文件可能尚未完全 flush（实测 1KB 首查 0、4KB=0、1MB 少 4096，100ms 后完整）；
 *  调用方读 size/校验前应先等 100ms 或轮询到稳定，别把正常文件误判成失败。
 *  ⚠ 故意**不上报网络状态**：封面下载量大、单个 CDN 节点抽风是常态，
 *  一次抽风不该把全应用翻成离线（记账只由 API 请求驱动，见 status.js） */
export async function download(opts) {
  const h = await getHttp()
  const headers = await buildHeaders(opts.headers)
  const r = await h.download({
    url: opts.url,
    outPath: opts.outPath,
    headers: headers,
    timeout: opts.timeout || 60000
  })
  return { status: (r && (r.status || r.statusCode)) || 0, raw: r }
}
