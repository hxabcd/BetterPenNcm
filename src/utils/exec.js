/**
 * 命令通道：process.exec 的统一封装 + 分能力探测。
 *
 * 新代码需要命令能力（curl / du / stat / ...）时从这里过，不要各自探测。
 *
 * 语义：
 *   - 探测失败按「不可用」缓存（false），不会反复探；`has()` 永不抛。
 *   - `run()` 是 `/bin/sh -c cmd` 的封装，**exec 不解析命令串，必须显式 /bin/sh -c**
 *     （运行时API参考 §6）。返回 {code, stdout, stderr}；通道不可用时返回 null，
 *     命令本身失败（非 0 退出）也照样 resolve —— 判断 rc 是调用方的事。
 *   - 探测在「首次用到该能力」时才发生（惰性）。
 *
 * 已知落差（有意保留，见出处注释）：
 *   - cache.js 原先只探 du/awk 不探 df，`df` 能力为此处净增的正确性修正。
 *   - hasStat 的探测超时 6000 → 8000（与其它探测一致；命令常驻，无副作用）。
 */
import { log } from './log.js'

/* ---- 能力表：key → 探测命令（stdout 非空且 rc=0 算可用） ---- */
const PROBES = {
  curl: 'command -v curl',
  du: 'command -v du',
  awk: 'command -v awk',
  stat: 'command -v stat',
  df: 'command -v df',
  ffmpeg: 'command -v ffmpeg'
}

const PROBE_TIMEOUT = 8000 // 各探针统一上限（原 6000~8000，命令都是常驻二进制、无副作用）

let proc = null // process 模块（懒加载；平台可能包一层 default）
const caps = {} // 能力 key → boolean（true=可用；探测过即缓存）

async function getProc() {
  if (!proc) {
    const m = await import('process')
    proc = (m && m.default) || m
  }
  return proc
}

/** process.exec 是否可用 */
export async function execOk() {
  try {
    const P = await getProc()
    return !!(P && typeof P.exec === 'function')
  } catch (e) {
    return false
  }
}

async function probe(cap) {
  if (caps[cap] !== undefined) return caps[cap]
  caps[cap] = false // 探测期间/失败一律先记不可用，避免并发重入反复 fork
  try {
    if (!(await execOk())) return false
    const P = await getProc()
    const r = await P.exec('/bin/sh', ['-c', PROBES[cap]], { timeout: PROBE_TIMEOUT, maxBuffer: 16384 })
    caps[cap] = !!(r && r.code === 0 && String((r && r.stdout) || '').trim())
    log('exec', '能力 ' + cap + ' 可用=' + caps[cap])
  } catch (e) {
    caps[cap] = false
    log('exec', '能力 ' + cap + ' 探测失败: ' + ((e && e.message) || e))
  }
  return caps[cap]
}

/**
 * 能力是否可用：has('curl') / has('du') / has('awk') / has('stat') / has('df') / has('ffmpeg')。
 * 未知 key 返回 false。**首次调用会同步等待一次探测**（一次 fork，~50ms）。
 */
export async function has(cap) {
  if (!PROBES[cap]) return false
  return probe(cap)
}

/**
 * 执行一条 shell 命令。cmd 原样交给 `/bin/sh -c`（**别传裸命令名**，见文件头）。
 * @returns {Promise<{code,stdout,stderr}|null>} 通道不可用 = null；命令失败 = 非 0 code（不是异常）
 */
export async function run(cmd, timeoutMs, maxBuffer) {
  if (!(await execOk())) return null
  const P = await getProc()
  return P.exec('/bin/sh', ['-c', cmd], {
    timeout: timeoutMs || 15000,
    maxBuffer: maxBuffer || 262144
  })
}
