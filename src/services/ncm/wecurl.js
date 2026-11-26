

// 登录流程专用传输通道：weapi over 系统 curl
//
// 为什么内建 http 不够用：设备 http 模块（curl 内核）从不把响应头 Set-Cookie 交还给 JS，
// 于是扫码登录全程都是零 cookie 的裸请求，服务端眼里每次都是全新匿名环境；手机点确认
// 那一刻会被判「安全环境风险」→ code 8821（redirectUrl 指向 igame 的无安全环境页）。
// 系统 curl 有 cookie 引擎（-c/-b 同一个 Netscape jar 文件），能把服务端下发的会话
// cookie 留下来；拿到后再并回 net/cookies.js 的 jar，后续请求无论走哪条通道都自动带上。
// ⚠ fs 模块只有读接口，写这个 jar 文件只能借 curl 的 -c 或 shellWrite。
import { weapiBody } from './crypto.js'
import { absorbCookieString, get as getCookie, header as cookieHeader } from '../../core/infra/net/cookies.js'
import { log, brief } from '../../core/infra/log.js'
import { fileExists, getFs } from '../../core/platform/fsutil.js'
import { has, run as shRun } from '../../core/platform/exec.js'
import { wecurlJarFile } from '../../core/infra/paths.js'

const BASE = 'https://music.163.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REF = 'https://music.163.com/'

function jar() {
  return wecurlJarFile()
}

export async function available() {
  return has('curl')
}

// curl 写出的 Netscape cookie 文件 → {name: value}：7 个 tab 分隔字段，name/value 在 5/6 列，
// # 开头是注释，但 #HttpOnly_ 前缀后面仍是有效行
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

// 日志脱敏：手机号保留前 3 后 4，验证码/密码整段打码。
// 出网口是唯一会打印请求明文的地方，凭据必须在这里拦掉，否则会顺着
// logserver 进 device_log.txt（PC 上那是明文文件）。
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

function stripTail(out) {
  const s = String(out || '')
  const i = s.lastIndexOf('HTTP=')
  return i < 0 ? s : s.slice(0, i)
}

// GET 首页，让服务端下发匿名 cookie（NMTID 等）——登录前先有会话
// 返回回收到的 cookie 项数（0 = 没拿到，不致命）
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

// weapi POST（curl 通道）。opts: {timeout, tag, raw}
// 返回 null = 通道不可用（调用方应回退内建 http）
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

    if (o.raw) log('curl', o.tag + ' BODY=' + body)
  }

  

  
  // ⚠ jarCookies 必须带回给调用方：验证码/密码登录（/weapi/login/cellphone）的会话
  // cookie 只在 Set-Cookie 响应头里，响应体没有 cookie 字段；不计这一项调用方会算出
  // 「cookie 0 项」，界面就变成假的「登录成功但没取到 cookie」（真机实际收到 6 项）。
  const jarN = await absorbJar()
  return { status: status, json: json, body: body2, headers: {}, jarCookies: jarN }
}

// 用 /bin/sh 重定向写文本文件。⚠ 不要用在别处：产品数据一律进 SQLite（core/platform/db.js），
// 写文本只能借 shell（一次 fork，真机 92~139ms），fs 模块没有写接口。
// 内容用单引号包裹，内部单引号逐个转义——cookie 值里不会出现单引号。
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
