/**
 * Cookie 会话（登录态）管理
 *
 * 内建 http 模块（curl 内核）**没有开 cookie 引擎**：请求不会自动带 cookie，
 * 响应也不会自动存。所以这里手工维护一个 jar：
 *   收：响应头 set-cookie（字符串或数组都处理）；登录接口还会在响应体里回一个 cookie 串
 *   发：每次请求前把 jar 拼成 Cookie 头（由 net/request.js 注入）
 *   存：序列化进 storage（裸模块 `storage`，见 utils/store.js），应用重启不丢登录态
 *
 * 值会被写进 $dataDir 之外的地方吗？不会——storage 由运行时管理，不落明文文件。
 */
import { log } from '../log.js'
import { getStorage, setStorage } from '../store.js'
import { fileExists, getFs } from '../fsutil.js'
import { cookieFile } from '../paths.js'

const KEY = 'ncm_cookies'
const ATTRS = {
  path: 1,
  domain: 1,
  expires: 1,
  'max-age': 1,
  samesite: 1,
  secure: 1,
  httponly: 1,
  version: 1,
  comment: 1
}

let jar = {}
let loaded = false

/** 从 storage 读入（只需成功一次） */
export async function load() {
  if (loaded) return jar
  loaded = true
  try {
    const raw = await getStorage(KEY)
    if (raw) jar = JSON.parse(raw) || {}
  } catch (e) {
    jar = {}
  }
  return jar
}

/**
 * 写回 storage，失败退避重试。
 *
 * 实测：应用**刚启动那一瞬**调用 setStorage 会失败（同一份数据几十秒后再存就正常，
 * 与长度无关——探测到 2000 字符都能存），所以在启动早期写入必须重试，
 * 否则登录态在重启后就丢了。
 *
 * 注意：运行时的 setStorage 失败时会把 **整个 value** 回显在错误里，而 value 里是
 * MUSIC_U 之类的登录凭据 —— 所以绝不能把 e.message 写进日志（会泄漏凭据）。
 */
export async function save(attempt) {
  const n = typeof attempt === 'number' ? attempt : 0
  const val = JSON.stringify(jar)
  const ok = await setStorage(KEY, val)
  if (ok) {
    if (n > 0) log('cookie', 'save 重试第 ' + (n + 1) + ' 次成功（' + val.length + ' 字符）')
    return true
  }
  log('cookie', 'save fail 第 ' + (n + 1) + ' 次（长度 ' + val.length + '，值不回显）')
  if (n < 2) {
    setTimeout(function () {
      save(n + 1)
    }, 3000 * (n + 1))
  }
  return false
}

/** 解析 "a=1; b=2; Path=/; Domain=.music.163.com" → {a:'1', b:'2'} */
export function parse(str) {
  const out = {}
  const parts = String(str || '').split(';')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim()
    if (!p) continue
    const eq = p.indexOf('=')
    if (eq <= 0) continue
    const k = p.slice(0, eq).trim()
    const v = p.slice(eq + 1).trim()
    if (ATTRS[k.toLowerCase()]) continue
    if (!v) continue // 空值 = 让浏览器删除该 cookie
    out[k] = v
  }
  return out
}

function merge(obj) {
  const keys = Object.keys(obj)
  if (!keys.length) return 0
  for (let i = 0; i < keys.length; i++) jar[keys[i]] = obj[keys[i]]
  return keys.length
}

/**
 * 从响应头收集 Set-Cookie。headers 可能是：
 *   {'set-cookie': 'a=1; Path=/'}        单条字符串
 *   {'Set-Cookie': ['a=1; ...', 'b=2;...']} 多条数组（标准）
 */
export function absorbHeaders(headers) {
  if (!headers) return 0
  const keys = Object.keys(headers)
  let n = 0
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() !== 'set-cookie') continue
    const v = headers[keys[i]]
    if (Array.isArray(v)) {
      for (let j = 0; j < v.length; j++) n += merge(parse(v[j]))
    } else if (typeof v === 'string') {
      n += merge(parse(v))
    } else if (v && typeof v === 'object') {
      n += merge(v)
    }
  }
  if (n) log('cookie', '从响应头收下 ' + n + ' 项: ' + Object.keys(jar).join(','))
  return n
}

/** 从响应体的 cookie 字段收集（旧接口会把整个 cookie 串放在 body.cookie） */
export function absorbCookieString(s) {
  const n = merge(parse(s))
  if (n) log('cookie', '从响应体收下 ' + n + ' 项: ' + Object.keys(jar).join(','))
  return n
}

/** 拼成请求头值；无 cookie 时返回 '' */
export function header() {
  const keys = Object.keys(jar)
  if (!keys.length) return ''
  const out = []
  for (let i = 0; i < keys.length; i++) out.push(keys[i] + '=' + jar[keys[i]])
  return out.join('; ')
}

export function get(name) {
  return jar[name]
}

export function has(name) {
  return !!jar[name]
}

export function names() {
  return Object.keys(jar)
}

export function all() {
  return Object.assign({}, jar)
}

export async function clear() {
  jar = {}
  await save()
}

export function isLoaded() {
  return loaded
}

/**
 * 会话引导 / 持久化：$dataDir/cookie.txt 里放一份 cookie 串，启动时导入。
 *
 * 为什么走文件而不是 storage：本应用的 storage.setStorage 实测**整体写不进去**
 * （启动后 0/5/15/30/60 秒、10~2000 字符、纯文本/JSON 全部失败，
 * 同机其他应用的 storage 正常），所以文件就是本应用的会话持久化载体。
 * 文件内容与其他应用的 preferences.json 同级，都躺在应用自己的 data 目录里。
 *
 * 关于 8821 的最终结论（换了号、补了 NMTID 都拦）：
 *   扫码「确认授权」时被**环境风控**拦（801/802 全程正常、服务端认得出账号），
 *   与接口加密、会话 cookie 均无关 —— 官方客户端能过靠的是设备指纹上报。
 *   可靠路径 = 从 PC 递一份有效 MUSIC_U 进来（MusicVault config.json 的 cookie 字段
 *   → adb push 本文件）。登录链路已改走系统 curl（utils/ncm/wecurl.js），
 *   能回收 NMTID 等响应 cookie，且 803 成功后 persistSession() 会自动落盘本文件，
 *   重启不再需要重新扫码。
 *
 * 返回导入的 cookie 项数（0 = 没有文件）。
 */
export async function importFromFile() {
  const path = cookieFile()
  try {
    if (!(await fileExists(path))) return 0
    const fs = await getFs()
    const raw = await fs.readFile(path)
    const n = absorbCookieString(raw)
    if (n) {
      await save() // storage 多半会失败，但不影响本次会话可用
      log('cookie', '已从 cookie.txt 导入 ' + n + ' 项会话')
    }
    return n
  } catch (e) {
    log('cookie', 'cookie.txt 导入失败: ' + (e && e.message))
    return 0
  }
}
