import { getFs } from '../../core/platform/fsutil.js'
import { has, run as shRun } from '../../core/platform/exec.js'

// 分片尺寸（调优）：每片一次 curl 进程 + 一次 cat 追加，片太小则连接建立（新 TCP + 慢启动）开销占比高 ——
// 真机实测 256KB 片在 ~400KB/s 网络下只有 ~300KB/s 有效速度（裸 curl 单连接 393KB/s）。
// 改为 512KB 起、按片速 ≥256KB/s 翻倍（上限 4MB）：同一网络下连接数减半以上；低速时仍落回下限。
export const CHUNK_MIN = 512 * 1024 
// 分片上限（高速用：省进程开销）
export const CHUNK_MAX = 4 * 1024 * 1024 
// 片速超过它才翻倍
export const GROW_BPS = 256 * 1024 
// JS 侧判低速阈值
export const LOW_SPEED_BPS = 64 * 1024 
// curl --speed-limit
export const SPEED_LIMIT_BPS = 48 * 1024 
// 低于限速持续这么久 → curl 中断（rc=28），交上层续传
export const SPEED_TIME_SEC = 10 
export const CONNECT_TIMEOUT = 8
// 单次请求最长秒数
export const CHUNK_MAX_TIME = 120 
// 连续失败上限（跨片计数，成功即清零）
export const MAX_TRY_PER_CHUNK = 3 
// 换节点次数上限
export const MAX_NODE_SWITCH = 3 
export const RETRY_BACKOFF_MS = [400, 1200, 3000]
export const UA = 'Mozilla/5.0 (Linux; arm; Android 10) AppleWebKit/537.36'
export const REFERER = 'https://music.163.com/'

// 进度轮询间隔（fs.stat 是 native 调用、不 fork，成本可忽略）
export const POLL_MS = 300 
// 整文件整轮重试上限（-C - 会从半截接着下，重试不丢进度）
export const WHOLE_MAX_TRY = 3 
// 单轮最长秒数（无损 25MB 在慢网下也够；-C - 兜底续传）
export const WHOLE_MAX_TIME = 600 

// 低速阈值比 curl 通道宽松（16KB/s × 30s）：整文件被掐断一次就要重启整轮，宁可让它在慢节点上多熬一会儿，也别反复重启。
export const WHOLE_SPEED_LIMIT_BPS = 16 * 1024
export const WHOLE_SPEED_TIME_SEC = 30
// 轮询空转上限（2400 × 300ms = 12 分钟，兜住 rc 文件丢失）
export const POLL_TICK_MAX = 2400 

// 落盘前确保 .part 的**父目录**在盘上：新布局 outPath = <downloads|cache>/<track_id>/track.<ext>.part，
// 中间那层曲目目录是下载前才建的；curl 的 -o 不会建父目录，目录缺失时它会直接失败（rc=23）。
// 这里用原生 fs（exists + mkdir，零 fork）补一次，幂等。
export async function ensureParentDir(path) {
  try {
    const i = String(path).lastIndexOf('/')
    if (i <= 0) return false
    const dir = String(path).slice(0, i)
    const fs = await getFs()
    if (await fs.exists(dir)) return true
    await fs.mkdir(dir)
    return true
  } catch (e) {
    return false
  }
}

// 当前通道：'curl' | 'builtin'（上层据此决定能否用 mv 提升 .part）
export async function transportMode() {
  return (await has('curl')) ? 'curl' : 'builtin'
}

// 退出收尾 / 防双写：应用退出时 JS 会被直接掐掉，但 wholeFetch 拉起的 curl 是**独立进程**（子 shell 后台化），
// 不主动杀就会继续写盘：最长 600s，且下次启动再下同一首时会和它抢同一个 .part。
// activeParts 记当前正在写的 .part（路径含歌曲 id），退出时按路径 pkill；stopping 是进程级退出标志 ——
// 杀掉 curl 后各轮询点看到它就收手，不再起新一轮。
let stopping = false
const activeParts = {}

// 当前是否处于「应用退出」状态（download.js 的 stopForExit 置位）
export function isStopping() {
  return stopping
}

// closeApp 失败、应用还活着时复位（否则本进程内所有下载都会立刻 aborted）
export function resetFetching() {
  stopping = false
}

// 应用退出：置退出标志 + 杀掉所有活跃 curl。返回杀掉的路径数。
// 幂等；调用方（download.stopForExit）最多等它几毫秒到一百毫秒。
export async function stopFetching() {
  stopping = true
  const parts = Object.keys(activeParts)
  for (let i = 0; i < parts.length; i++) {
    try {
      await shRun('pkill -9 -f "' + parts[i] + '" 2>/dev/null; echo ok', 8000)
    } catch (e) {}
  }
  return parts.length
}

// 开始下载前杀掉同一 .part 的残留 curl（上一进程被强杀时可能还在写）。路径里带歌曲 id，不会误伤别的下载；没有残留时 pkill 无匹配也是成功。
export async function killStale(part) {
  try {
    await shRun('pkill -9 -f "' + part + '" 2>/dev/null; echo ok', 8000)
  } catch (e) {}
}

// 对外暴露：完整残片转正前先杀掉可能还在写的旧 curl，
// 避免 mv 之后它继续往同一个 inode 里追加（最终文件被写坏）。
export async function killPartFetch(part) {
  await killStale(part)
}

// 退出时的标准返回（上层据此按 aborted 结算，不写失败日志）
export function abortedResult() {
  return { ok: false, size: 0, mode: 'curl', aborted: true, error: '应用退出' }
}

// 跨文件接线：stopping / activeParts 只有这一份，各通道都从这里取
export function trackPart(part) { activeParts[part] = true }
export function untrackPart(part) { delete activeParts[part] }
