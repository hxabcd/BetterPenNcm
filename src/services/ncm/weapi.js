/**
 * weapi 传输层：加密 + POST + 解析
 *
 * 路径沿用接口原始写法（如 /api/login/qrcode/unikey），内部把 /api/ 换成 /weapi/。
 * 与旧版明文接口的区别只有两点：body 是 params/encSecKey 表单，payload 里多带 csrf_token。
 *
 * 注意：csrf_token 取自 cookie 里的 __csrf（登录成功后服务端才下发，未登录时为空串）。
 */
import { request } from '../net/request.js'
import { weapiBody } from './crypto.js'
import { maskPayload } from './wecurl.js'
import { get as getCookie, names as cookieNames } from '../net/cookies.js'
import { log, brief } from '../log.js'

const BASE = 'https://music.163.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const WEAPI_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/x-www-form-urlencoded'
}

/**
 * POST /weapi/...，返回 {status, json, body, headers}
 * opts: {timeout, tag(日志前缀)}
 */
export async function weapiPost(path, payload, opts) {
  const o = opts || {}
  const p = Object.assign({}, payload)
  p.csrf_token = getCookie('__csrf') || ''

  const t0 = Date.now()
  const body = weapiBody(p)
  const encMs = Date.now() - t0

  const url = BASE + path.replace('/api/', '/weapi/')
  const r = await request({ url: url, method: 'POST', headers: WEAPI_HEADERS, data: body, timeout: o.timeout || 15000 })

  let json = null
  try {
    json = JSON.parse(r.body)
  } catch (e) {
    log('weapi', (o.tag || '') + ' 响应非 JSON: ' + brief(r.body, 160))
  }
  if (o.tag) {
    // 明文日志统一脱敏（手机号/验证码/密码，见 wecurl.js 的 maskPayload）
    log('weapi', o.tag + ' url=' + url + ' 明文=' + brief(maskPayload(p), 200) + ' 加密耗时=' + encMs + 'ms')
    log(
      'weapi',
      o.tag + ' http=' + r.status + ' code=' + (json && json.code) +
        ' 体=' + brief(json || r.body, 260)
    )
    if (o.raw) {
      // 排查风控用：BODY 是加密串，可原样记录；Cookie 只记名称，值不回显（会话凭据不落日志）
      log('weapi', o.tag + ' BODY=' + body)
      log('weapi', o.tag + ' COOKIE_NAMES=' + cookieNames().join(','))
    }
  }
  return { status: r.status, json: json, body: r.body, headers: r.headers, encMs: encMs }
}

export const WEAPI_BASE = BASE
