/**
 * 登录流程专用传输通道：weapi over 系统 curl
 *
 * 为什么内建 http 不够用：设备 http 模块（curl 内核）**从不把响应头的 Set-Cookie
 * 交还给 JS** —— 全量日志里「从响应头收下」出现 0 次，连 unikey 请求也不例外。
 * 于是扫码登录全程都是「零 cookie 的裸请求」：每个请求在服务端眼里都是一个全新的
 * 匿名环境，没有 NMTID 之类的会话标识，手机点确认那一刻被判「安全环境风险」
 * → code 8821（redirectUrl 指向 igame 的安全环境风险页）。
 *
 * 系统 curl 有 cookie 引擎（-c/-b 同一个 Netscape jar 文件），能拿到并回传服务端
 * 下发的会话 cookie。本模块负责：
 *   1) 用 curl 发 weapi POST（body 与内建通道完全一致，都是 crypto.weapiBody）
 *   2) 把 curl jar 里新出现的 cookie 合并回 net/cookies.js 的 jar，
 *      后续请求（无论走哪条通道）自动带上，整个登录链路就有了连续会话。
 *
 * 另提供 shellWrite：`/bin/sh` 重定向写文件 —— 本机 fs 模块只读，而写文件是
 * 持久化会话（cookie.txt）的唯一办法（http.download 不适合写这么点内容）。
 */
import { weapiBody } from './crypto.js'
import { absorbCookieString, get as getCookie, header as cookieHeader } from '../net/cookies.js'
import { log, brief } from '../log.js'
import { fileExists, getFs } from '../fsutil.js'
import { has, run as shRun } from '../exec.js'
import { wecurlJarFile } from '../paths.js'

const BASE = 'https://music.163.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REF = 'https://music.163.com/'

/** curl 会话 jar 路径（收敛到 paths.js；旧实现依赖 $dataDir 自带尾斜杠） */
function jar() {
  return wecurlJarFile()
}

/** curl 通道是否可用（保留导出：登录链路判断「能否走 curl 会话通道」的既有入口；
 *  探测实现收敛到 utils/exec.js —— has('curl') 与旧 detect() 同义） */
export async function available() {
  return has('curl')
}

/** curl 写出的 Netscape cookie 文件 → {name: value}（跳过 # 注释与 HttpOnly 前缀） */
function parseJar(text) {
  const out = {}
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i]
    if (ln.charAt(ln.length - 1) === '\r') ln = ln.slice(0, -1)
    if (!ln) continue
    if (ln.indexOf('#HttpOnly_') === 0) ln = ln.slice(10)
    else if (ln.charAt(0) === '#') continue
    const f = ln.split('\t')
    if (f.length < 7) continue
    const name = f[5]
    const val = f[6]
    if (!name || !val) continue
    out[name] = val
  }
  return out
}

/** 把 curl jar 里的内容并回 JS jar，返回新增项数 */
async function absorbJar() {
  let txt = ''
  try {
    if (!(await fileExists(jar()))) return 0
    const fs = await getFs()
    txt = (await fs.readFile(jar())) || ''
  } catch (e) {
    return 0
  }
  const map = parseJar(txt)
  const keys = Object.keys(map)
  if (!keys.length) return 0
  const parts = []
  for (let i = 0; i < keys.length; i++) parts.push(keys[i] + '=' + map[keys[i]])
  const n = absorbCookieString(parts.join('; '))
  if (n) log('curl', 'jar 回收 ' + n + ' 项 cookie: ' + keys.join(','))
  return n
}

/**
 * 日志脱敏：手机号保留前 3 后 4，验证码/密码整段打码。
 * 出网口是唯一会打印请求明文的地方，凭据必须在这里拦掉 —— 否则会顺着
 * logserver 进 device_log.txt（PC 日志是明文文件）。
 */
export function maskPayload(p) {
  const out = {}
  const keys = Object.keys(p || {})
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const v = p[k]
    if (k === 'captcha' || k === 'password' || k === 'md5_password') {
      out[k] = '******'
    } else if (k === 'phone' || k === 'cellphone') {
      const s = String(v === undefined || v === null ? '' : v)
      out[k] = s.length > 7 ? s.slice(0, 3) + '****' + s.slice(-4) : '****'
    } else {
      out[k] = v
    }
  }
  return out
}

function tailCode(out) {
  const m = String(out || '').match(/HTTP=(\d{3})/)
  return m ? parseInt(m[1], 10) : 0
}

/** 去掉 curl -w 追加的状态行，只留响应体 */
function stripTail(out) {
  const s = String(out || '')
  const i = s.lastIndexOf('HTTP=')
  return i < 0 ? s : s.slice(0, i)
}

/**
 * 会话引导：GET 首页，让服务端下发匿名 cookie（NMTID 等）。
 * 浏览器登录前本来也会先打开页面，这一步是让笔上的流程接近它。
 * 返回回收到的 cookie 项数（0 = 没拿到，不致命）。
 */
export async function prime() {
  const okCurl = await has('curl')
  if (!okCurl) return 0
  const ck = cookieHeader()
  const cmd =
    'curl -sS -L --connect-timeout 8 -m 20 -A \'' + UA + '\' -e \'' + REF + '\'' +
    (ck ? ' -H \'Cookie: ' + ck + '\'' : '') +
    ' -c \'' + jar() + '\' -o /dev/null -w \'HTTP=%{http_code}\' \'' + BASE + '/\''
  try {
    const r = await shRun(cmd, 25000)
    log('curl', '引导首页 http=' + tailCode(r && r.stdout) + ' rc=' + (r && r.code))
  } catch (e) {
    log('curl', '引导首页失败: ' + ((e && e.message) || e))
    return 0
  }
  return await absorbJar()
}

/**
 * weapi POST（curl 通道）。opts: {timeout, tag, raw}
 * 返回 null = 通道不可用（调用方应回退内建 http）
 */
export async function post(path, payload, opts) {
  const okCurl = await has('curl')
  if (!okCurl) return null
  const o = opts || {}
  const p = Object.assign({}, payload)
  p.csrf_token = getCookie('__csrf') || ''

  const body = weapiBody(p)
  const url = BASE + path.replace('/api/', '/weapi/')
  const ck = cookieHeader()
  const cmd =
    'curl -sS -L --connect-timeout 8 -m ' + (o.timeout ? Math.ceil(o.timeout / 1000) : 20) +
    ' -A \'' + UA + '\' -e \'' + REF + '\'' +
    ' -H \'Content-Type: application/x-www-form-urlencoded\'' +
    (ck ? ' -H \'Cookie: ' + ck + '\'' : '') +
    ' -c \'' + jar() + '\'' +
    ' --data-raw \'' + body + '\'' +
    ' -w \'\\nHTTP=%{http_code}\' \'' + url + '\''

  let r = null
  try {
    r = await shRun(cmd, (o.timeout || 20000) + 5000)
  } catch (e) {
    log('curl', (o.tag || '') + ' 请求异常: ' + ((e && e.message) || e))
    return null
  }
  const out = (r && r.stdout) || ''
  const status = tailCode(out)
  const body2 = stripTail(out)
  let json = null
  try {
    json = JSON.parse(body2)
  } catch (e) {
    log('curl', (o.tag || '') + ' 响应非 JSON: ' + brief(body2, 160))
  }
  if (o.tag) {
    log('curl', (o.tag || '') + ' url=' + url + ' 明文=' + brief(maskPayload(p), 200))
    log('curl', (o.tag || '') + ' url=' + url + ' http=' + status + ' code=' + (json && json.code) +
      ' 体=' + brief(json || body2, 200))
    // raw 只在人工排查时开：BODY 含加密串，不含明文，但体量较大
    if (o.raw) log('curl', o.tag + ' BODY=' + body)
  }
  // ⚠ jar 回收数必须带回给调用方：验证码/密码登录（/weapi/login/cellphone）的会话
  // cookie **只在 Set-Cookie 响应头里**，响应体没有 cookie 字段 —— 不计这一项的话
  // 调用方会算出「cookie 0 项」，界面上就变成假的「登录成功但没取到 cookie」
  // （真机：实际收到 6 项并已落盘，界面却显示 0）。
  const jarN = await absorbJar()
  return { status: status, json: json, body: body2, headers: {}, jarCookies: jarN }
}

/**
 * 用 /bin/sh 重定向写文本文件（fs 模块在本机只读）。
 * 内容用单引号包裹，内部的单引号会被逐字转义 —— cookie 值里不会出现单引号。
 */
export async function shellWrite(path, content) {
  const okCurl = await has('curl')
  if (!okCurl) return false
  const safe = String(content || '').replace(/'/g, "'\\''")
  const cmd = 'printf \'%s\' \'' + safe + '\' > \'' + path + '\''
  try {
    const r = await shRun(cmd, 8000)
    if (r && r.code === 0) return true
    log('curl', '写文件失败 rc=' + (r && r.code) + ' ' + brief(r && r.stderr, 120))
    return false
  } catch (e) {
    log('curl', '写文件异常: ' + ((e && e.message) || e))
    return false
  }
}
