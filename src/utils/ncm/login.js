/**
 * 网易云扫码登录（weapi 加密版）
 *
 * 为什么必须加密：旧版明文 /api/ 扫码接口已被服务端封禁——真机实测中，
 * 手机扫码确认后轮询回来的是 code=8821「请切换其他登录方式或升级新版本再试」。
 * 换成 /weapi/ 加密后即可正常登录（加密实现见 utils/ncm/crypto.js，已与用户
 * MusicVault 项目的纯 Python 实现逐字节对拍通过）。
 *
 * 流程：
 *   1) POST /weapi/login/qrcode/unikey        {type:1}          -> {unikey}
 *   2) 二维码内容 = https://music.163.com/login?codekey=<unikey>
 *   3) POST /weapi/login/qrcode/client/login  {key, type:1}     -> 轮询
 *        code 801 等待扫码 / 802 已扫码待确认 / 803 授权成功 / 800 二维码过期
 *   4) 803 时登录态在**响应体 cookie 字段**里（旧明文接口是走 Set-Cookie 响应头）
 *   5) POST /weapi/w/nuser/account/get        {}                -> {profile:{nickname,...}}
 *
 * 登录态由 utils/net/cookies.js 统一持久化，其他业务请求自动带 Cookie 头。
 */
import { weapiPost } from './weapi.js'
import { md5Hex } from './crypto.js'
import * as wecurl from './wecurl.js'
import {
  absorbHeaders,
  absorbCookieString,
  has,
  clear as clearCookies,
  save,
  header as cookieHeader
} from '../net/cookies.js'
import { invalidateUserPlaylists } from './playlist.js'
import { invalidateDaily } from './recommend.js'
import config from '../config.js'
import { log, brief } from '../log.js'
import { rmQuiet } from '../fsutil.js'
import { cookieFile, wecurlJarFile } from '../paths.js'

const BASE = 'https://music.163.com'

export const CODE = {
  EXPIRED: 800,
  WAITING: 801,
  SCANNED: 802,
  OK: 803,
  RISKY: 8821 // 安全环境风控：「请切换其他登录方式或升级新版本再试」
}

/**
 * 登录链路统一出网口：**优先系统 curl**（有 cookie 引擎，能把服务端下发的
 * NMTID 等会话 cookie 回收并回传 —— 没有它就会被判 8821，详见 wecurl.js 顶部），
 * curl 不可用时回退内建 http（此时仍可能 8821，但至少功能不瘫）。
 */
async function loginPost(path, payload, opts) {
  const r = await wecurl.post(path, payload, opts)
  if (r) return r
  return weapiPost(path, payload, opts)
}

/**
 * 会话引导：登录前先让服务端下发匿名 cookie（NMTID 等）。
 * 只做一次；失败不致命（日志会写明）。
 */
let primed = false
export async function primeSession() {
  if (primed) return
  primed = true
  const n = await wecurl.prime()
  log('login', '会话引导: ' + (n > 0 ? '拿到 ' + n + ' 项匿名 cookie' : '未拿到匿名 cookie（通道不可用？8821 风险高）'))
}

/**
 * 把当前会话写进 $dataDir/cookie.txt（fs 只读 → 走 shell 重定向）。
 * 为什么需要：本应用 setStorage 实测写不进去，重启后内存 jar 就没了，
 * 每次启动都得重新扫码 —— 而反复扫码正是触发 8821 风控的温床。
 */
export async function persistSession() {
  const s = cookieHeader()
  if (!s) return 0
  const ok = await wecurl.shellWrite(cookieFile(), s)
  log('login', ok ? '会话已写入 cookie.txt' : '会话写入 cookie.txt 失败（不影响本次）')
  return ok ? 1 : 0
}

/** 二维码里要编码的内容 */
export function qrContent(unikey) {
  return BASE + '/login?codekey=' + unikey
}

/** 第 1 步：申请一个二维码 key */
export async function createQr() {
  await primeSession() // 先拿匿名会话 cookie，否则十有八九是 8821
  const r = await loginPost('/api/login/qrcode/unikey', { type: 1 }, { tag: 'unikey' })
  const j = r.json || {}
  const unikey = (j.data && j.data.unikey) || j.unikey || ''
  if (!unikey) throw new Error('无 unikey: ' + brief(j, 120))
  return { unikey: unikey, url: qrContent(unikey) }
}

/**
 * 第 3 步：轮询扫码状态
 * 返回 {code, message, nickname, avatarUrl, cookieCount}
 */
export async function pollQr(unikey, opts) {
  const r = await loginPost('/api/login/qrcode/client/login', { key: unikey, type: 1 }, {
    tag: 'poll',
    raw: !!(opts && opts.raw)
  })
  const j = r.json || {}
  const code = j.code || r.status

  if (code === CODE.RISKY) {
    log('login', '!! 命中安全环境风控 8821（message=' + (j.message || '') + '）' +
      '；通常是会话 cookie 缺失/环境陌生，见 wecurl.js 顶部说明')
  }

  if (code === CODE.OK) {
    // 三处来源同 applyLoginResponse：响应体 cookie / 响应头 Set-Cookie / curl jar 回收
    const n1 = j.cookie ? absorbCookieString(j.cookie) : 0
    const n2 = absorbHeaders(r.headers)
    const n3 = r.jarCookies || 0
    if (!n1 && !n2 && !n3) {
      log('login', '!! 未取到 cookie. bodyKeys=' + brief(Object.keys(j), 160) +
        ' headerKeys=' + brief(Object.keys(r.headers || {}), 160))
    }
    await save()
    // 落一份到 cookie.txt：本应用 storage 写不进去，不落盘的话重启就得重新扫码，
    // 而反复扫码正是 8821 风控的温床（boot 启动时 importFromFile 会读回来）
    await persistSession()
    // 换账号了：歌单缓存必须作废，否则首页/歌单页会显示上一个账号的歌单
    invalidateUserPlaylists()
    const p = await fetchProfile()
    return {
      code: code,
      message: j.message || '',
      nickname: (p && p.nickname) || j.nickname || '',
      avatarUrl: (p && p.avatarUrl) || j.avatarUrl || '',
      userId: (p && p.userId) || 0,
      cookieCount: n1 + n2 + n3
    }
  }

  return { code: code, message: j.message || '', nickname: j.nickname || '', avatarUrl: j.avatarUrl || '' }
}

/** 第 5 步：取账号资料并持久化 */
export async function fetchProfile() {
  try {
    // 也走登录通道：带的是同一份 cookie jar，避免会话在两个通道间不一致
    const r = await loginPost('/api/w/nuser/account/get', {}, { tag: 'account' })
    const j = r.json || {}
    const data = j.data || {}
    const p = data.profile || data.account || j.profile || j.account
    if (!p) {
      log('login', 'account/get 无 profile: ' + brief(j, 160))
      return null
    }
    const out = { nickname: p.nickname || '', avatarUrl: p.avatarUrl || '', userId: p.userId || 0 }
    await config.set('nickname', out.nickname)
    await config.set('avatarUrl', out.avatarUrl)
    await config.set('userId', out.userId)
    log('login', '已登录: ' + out.nickname + ' (uid=' + out.userId + ')')
    return out
  } catch (e) {
    log('login', '获取资料失败: ' + (e && e.message))
    return null
  }
}

/** 是否已登录（有 MUSIC_U 即视为已登录） */
export function loggedIn() {
  return has('MUSIC_U')
}

/* ------------------------------------------------------------------ *
 * 短信验证码登录（可发布的自助登录方式）
 *
 * 为什么：扫码「确认授权」被环境风控拦死（8821，换号也一样，见 wecurl.js），
 * 而短信登录是 2026 年社区公认仍可行的自助登录（NeteaseCloudMusicApi 文档
 * 明确建议：密码登录有网易云盾，优先短信验证码登录）。接口与现有加密
 * 完全同路（/weapi/），成功后 cookie 同样在响应体里，落盘逻辑一并复用。
 * ------------------------------------------------------------------ */

/**
 * 发送短信验证码。返回 {code, message}，200 = 已发送
 *
 * ⚠ 手机号字段名有分歧：MusicVault 的实现用 **cellphone**，社区文档写 phone。
 * 真机实测：只发 `phone` 会回 code=400「参数错误」。
 * 所以先按 cellphone 发，失败再退 phone —— 服务端改回去也不会整条链路瘫。
 */
export async function sendCaptcha(phone) {
  await primeSession()
  let r = await loginPost('/api/sms/captcha/sent', { cellphone: phone, ctcode: 86 }, { tag: 'captcha' })
  let j = r.json || {}
  if ((j.code || 0) !== 200) {
    log('login', 'cellphone 字段被拒（' + (j.code || 0) + '），改用 phone 重试')
    r = await loginPost('/api/sms/captcha/sent', { phone: phone, ctcode: 86 }, { tag: 'captcha-retry' })
    j = r.json || {}
  }
  if ((j.code || 0) !== 200) {
    log('login', '验证码发送失败 code=' + (j.code || 0) + ' ' + (j.message || j.msg || ''))
  }
  return { code: j.code || 0, message: j.message || j.msg || '' }
}

/**
 * 登录响应收尾（验证码 / 密码两条路共用）：
 * 吸 cookie → 落 storage → 落 cookie.txt → 作废歌单缓存 → 取资料
 */
async function applyLoginResponse(r, tag) {
  const j = r.json || {}
  const code = j.code || r.status
  if (code !== 200) {
    log('login', tag + '失败 code=' + code + ' ' + (j.message || j.msg || ''))
    return { code: code, message: j.message || j.msg || '', nickname: '', userId: 0, cookieCount: 0 }
  }
  // 登录态三处来源都要算：
  //   n1 响应体 cookie 字段（扫码 803 走这条）
  //   n2 响应头 Set-Cookie（内建 http 通道才有）
  //   n3 curl cookie jar 回收 —— **验证码/密码登录只走这条**（响应体没有 cookie 字段），
  //      漏掉它就会误报「登录成功但未取到 cookie」
  const n1 = j.cookie ? absorbCookieString(j.cookie) : 0
  const n2 = absorbHeaders(r.headers)
  const n3 = r.jarCookies || 0
  await save()
  await persistSession()
  invalidateUserPlaylists()
  const p = await fetchProfile()
  return {
    code: 200,
    message: '',
    nickname: (p && p.nickname) || '',
    userId: (p && p.userId) || 0,
    cookieCount: n1 + n2 + n3
  }
}

/** 验证码登录。返回 {code, message, nickname, userId, cookieCount} */
export async function loginByCaptcha(phone, captcha) {
  const r = await loginPost(
    '/api/login/cellphone',
    { phone: phone, captcha: captcha, countrycode: 86 },
    { tag: 'sms-login' }
  )
  return applyLoginResponse(r, '短信登录')
}

/**
 * 密码登录。返回 {code, message, nickname, userId, cookieCount}
 *
 * ⚠ password 字段要 **md5 后的值**（社区通行做法，与 NeteaseCloudMusicApi 一致）。
 * ⚠ 兜底通道：网易对密码登录有云盾验证，成功率低于短信验证码 —— 界面上要写清楚。
 */
export async function loginByPassword(phone, password) {
  const r = await loginPost(
    '/api/login/cellphone',
    { phone: phone, countrycode: 86, password: md5Hex(password), rememberLogin: true },
    { tag: 'pwd-login' }
  )
  return applyLoginResponse(r, '密码登录')
}

/** 从本地设置里取上次登录的昵称 */
export function cachedProfile() {
  return {
    nickname: config.get('nickname') || '',
    avatarUrl: config.get('avatarUrl') || '',
    userId: config.get('userId') || 0
  }
}

/**
 * 退出登录：清 cookie + 清资料 + 删 cookie.txt + 通知界面
 *
 * **必须删 $dataDir/cookie.txt**：boot.js 每次启动都无条件 importFromFile()，
 * 不删的话重启后会话会被灌回来 —— 「退出登录」就变成假的（审核发现）。
 * 代价是 adb 递会话（push cookie.txt）的调试通道没了，需要时重新 push 即可。
 * 注意 $dataDir 结尾自带 '/'（设备实测），所以这里不再补斜杠。
 */
export async function logout() {
  await clearCookies()
  await config.set('nickname', '')
  await config.set('avatarUrl', '')
  await config.set('userId', 0)
  invalidateUserPlaylists()
  invalidateDaily() // 每日推荐是账号相关的，换账号后不能接着用上一个账号那份
  try {
    await rmQuiet(cookieFile())
    // 顺手清掉 curl 的 cookie jar：留着会让下一次扫码带上上一次的匿名会话
    await rmQuiet(wecurlJarFile())
  } catch (e) {
    // 文件不存在或 fs 不可用都无所谓，会话本身已经清掉了
  }
  try {
    /* global $falcon */
    $falcon.trigger('bpncm:login-done') // 首页/设置页/个人中心据此刷新
  } catch (e) {}
  log('login', '已退出登录（cookie.txt 已清除）')
}
