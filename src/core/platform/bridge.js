

// 原生桥 bpnnet：X3S（RK3566 / aarch64）的运行时没有 fs / http / process 裸模块，也没有
// process.exec 兜底，由 libs/arm64-cherry3566/libjsapi_bpnnet.so 注册同名裸模块补回三块能力。
// S7 / X5 是 armhf，动态加载器不加载 aarch64 产物 → import('bpnnet') 抛错 → bridge() 永久返回 null，
// 调用方（net/request.js、infra/log.js、fsutil.js、exec.js）回退原生裸模块。
// 长操作是「后台线程 + 轮询 takeResult」：QuickJS 上下文非线程安全，不能从后台线程 resolve Promise。
// 不 import log.js：log.js 反过来用本文件，会递归；失败一律静默，由调用方记。

let bpn = null
let loading = null

/** bpnnet 模块句柄；不可用（非 X3S / .so 没装上）返回 null */
export function bridge() {
  if (bpn) return Promise.resolve(bpn)
  if (!loading) {
    loading = import('bpnnet')
      .then(function (m) {
        bpn = (m && m.default) || m
        return bpn
      })
      .catch(function () {
        bpn = null
        return null
      })
  }
  return loading
}

// bpnnet 的异步任务：start* 返回任务 id，takeResult(id) 出 JSON 串结果
const POLL_MS = 80

/** 轮询取任务结果；超时（timeoutMs + 5s 兜底）resolve null（任务继续跑，结果被丢弃） */
function pollJob(id, timeoutMs) {
  return new Promise(function (resolve) {
    const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : 15000) + 5000
    const tick = function () {
      let raw = null
      if (bpn) {
        try {
          raw = bpn.takeResult(id)
        } catch (e) {
          raw = null
        }
      }
      if (raw) {
        let obj = null
        try {
          obj = JSON.parse(raw)
        } catch (e) {
          obj = null
        }
        resolve(obj || {})
        return
      }
      if (Date.now() > deadline) {
        resolve(null)
        return
      }
      setTimeout(tick, POLL_MS)
    }
    setTimeout(tick, POLL_MS)
  })
}

// bpnnet 收发头都用 "Key: value\r\n" 文本行，不走对象
function headersToText(h) {
  if (!h) return ''
  const keys = Object.keys(h)
  const lines = []
  for (let i = 0; i < keys.length; i++) {
    const v = h[keys[i]]
    if (v === undefined || v === null) continue
    lines.push(keys[i] + ': ' + String(v))
  }
  return lines.join('\r\n')
}

/** 原始响应头文本 → 对象（键统一小写；同名多值折叠为数组，set-cookie 靠这个保住） */
function parseHeaders(text) {
  const out = {}
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].indexOf(':')
    // 状态行 / 空行没有冒号
    if (c <= 0) continue 
    const k = lines[i].slice(0, c).trim().toLowerCase()
    const v = lines[i].slice(c + 1).trim()
    if (!k || !v) continue
    if (!out[k]) out[k] = v
    else if (Array.isArray(out[k])) out[k].push(v)
    else out[k] = [out[k], v]
  }
  return out
}

/**
 * 返回 {request, download}；bpnnet 不可用返回 null。
 * 与 S7 内建 http 契约对齐，差异：body 含 NUL 不截断（S7 会截断）；download 走 tmp + rename
 * 原子落盘，返回即完整（S7 那边返回时可能还没 flush 完，调用方的轮询等待兼容两种形态）。
 */
export async function bridgeHttp() {
  const b = await bridge()
  if (!b) return null
  return {
    request: async function (opts) {
      if (!opts || !opts.url) throw new Error('bpnnet.request: 缺 url')
      const timeout = opts.timeout || 12000
      const id = b.startRequest(
        opts.url,
        opts.method || 'GET',
        headersToText(opts.headers),
        opts.data === undefined || opts.data === null ? null : String(opts.data),
        timeout
      )
      if (!id) throw new Error('bpnnet.startRequest 失败')
      const r = await pollJob(id, timeout)
      if (!r) throw new Error('bpnnet.request 超时无结果')
      if (r.error) throw new Error(r.error)
      return { status: r.status || 0, headers: parseHeaders(r.headers), body: r.body || '' }
    },
    download: async function (opts) {
      if (!opts || !opts.url || !opts.outPath) throw new Error('bpnnet.download: 缺 url/outPath')
      const timeout = opts.timeout || 60000
      const id = b.startDownload(opts.url, opts.outPath, headersToText(opts.headers), timeout)
      if (!id) throw new Error('bpnnet.startDownload 失败')
      const r = await pollJob(id, timeout)
      if (!r) throw new Error('bpnnet.download 超时无结果')
      if (!r.ok) throw new Error(r.error || 'status=' + (r.status || 0))
      return { status: r.status || 0, raw: r }
    }
  }
}

/** 返回 {exists, stat, readdir, readFile, mkdir, rm}；bpnnet 不可用返回 null。
 *  与 S7 裸模块 fs 契约对齐：全 await 形态、失败给安全默认。
 *  平台 fs 本来就没有 writeFile，写走 SQLite / 下载通道，这里不提供写函数。 */
export async function bridgeFs() {
  const b = await bridge()
  if (!b) return null
  return {
    exists: async function (p) {
      return !!b.fsExists(p)
    },
    stat: async function (p) {
      if (!b.fsExists(p)) return null
      return {
        size: Number(b.fsSize(p)) || 0,
        mtimeMs: Number(b.fsMtime(p)) || 0
      }
    },
    readdir: async function (p) {
      return b.fsReaddir(p) || []
    },
    readFile: async function (p) {
      return String(b.fsReadText(p, 2 * 1024 * 1024) || '')
    },
    mkdir: async function (p) {
      return !!b.fsMkdir(p)
    },
    rm: async function (p) {

      
      // 对齐 S7 裸模块 fs 契约：rm 递归删目录。传 0 时 bpnnet 走 rmdir，
      // 非空目录（音频 + 封面）删不掉 → X3S 上删除下载永远失败
      return !!b.fsRm(p, 1)
    }
  }
}

/**
 * 返回 {exec}；bpnnet 不可用返回 null。
 * 只支持工程里实际使用的 exec('/bin/sh', ['-c', cmd], {timeout, maxBuffer}) 形态，返回
 * {code, stdout, stderr}；通道失败（任务起不来 / 超时无结果）返回 null —— 与 exec.js run()
 * 的「通道不可用 = null」语义一致。
 */
export async function bridgeProc() {
  const b = await bridge()
  if (!b) return null
  return {
    exec: async function (file, args, opts) {
      if (file !== '/bin/sh' || !args || args[0] !== '-c' || typeof args[1] !== 'string') {
        throw new Error("bpnnet.exec 仅支持 exec('/bin/sh', ['-c', cmd]) 形态")
      }
      opts = opts || {}
      const timeout = opts.timeout || 15000
      const id = b.startExec(args[1], timeout, opts.maxBuffer || 262144)
      if (!id) return null
      const r = await pollJob(id, timeout)
      if (!r) return null
      return {
        code: typeof r.code === 'number' ? r.code : -1,
        stdout: String(r.stdout || ''),
        stderr: String(r.stderr || '')
      }
    }
  }
}
