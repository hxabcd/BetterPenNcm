

// 下载传输层 —— 系统 curl 下载（**整文件为主，分片为兜底**）。
// 真机实测：process.exec('/bin/sh', ['-c', cmd], {timeout,maxBuffer}) 可用（root 身份，返回 {code,stdout,stderr}；
// exec 不解析命令串，必须显式 /bin/sh -c）；设备 curl 7.77.0，`-r a-b` 返回 206（CDN 支持 Range）→ 分片与续传成立；
// 每次 exec 在这台 32 位 ARMv7 上一次 fork 要 92~139ms，而每片要付 2 次 exec。
// 同一首 10.69MB 实测：整文件 11002KB/s ｜ 4MB 片 7758 ｜ 2MB 片 3439 ｜ 512KB 片 1990 —— 分片本身就是最大的开销来源。
// 所以主路径是整文件（-C - 续传 + pkill 取消），分片只在整文件反复失败时兜底；两边共用同一个 .part。
import { download as httpDownload } from '../../core/infra/net/request.js'
import { log } from '../../core/infra/log.js'
import { sleep } from '../../core/infra/util.js'
import { fileExists, fileSize, getFs, readText, rmQuiet } from '../../core/platform/fsutil.js'
import { has, run as shRun } from '../../core/platform/exec.js'

// 分片尺寸（调优）：每片一次 curl 进程 + 一次 cat 追加，片太小则连接建立（新 TCP + 慢启动）开销占比高 ——
// 真机实测 256KB 片在 ~400KB/s 网络下只有 ~300KB/s 有效速度（裸 curl 单连接 393KB/s）。
// 改为 512KB 起、按片速 ≥256KB/s 翻倍（上限 4MB）：同一网络下连接数减半以上；低速时仍落回下限。
const CHUNK_MIN = 512 * 1024 
// 分片上限（高速用：省进程开销）
const CHUNK_MAX = 4 * 1024 * 1024 
// 片速超过它才翻倍
const GROW_BPS = 256 * 1024 
// JS 侧判低速阈值
const LOW_SPEED_BPS = 64 * 1024 
// curl --speed-limit
const SPEED_LIMIT_BPS = 48 * 1024 
// 低于限速持续这么久 → curl 中断（rc=28），交上层续传
const SPEED_TIME_SEC = 10 
const CONNECT_TIMEOUT = 8
// 单次请求最长秒数
const CHUNK_MAX_TIME = 120 
// 连续失败上限（跨片计数，成功即清零）
const MAX_TRY_PER_CHUNK = 3 
// 换节点次数上限
const MAX_NODE_SWITCH = 3 
const RETRY_BACKOFF_MS = [400, 1200, 3000]
const UA = 'Mozilla/5.0 (Linux; arm; Android 10) AppleWebKit/537.36'
const REFERER = 'https://music.163.com/'

// 进度轮询间隔（fs.stat 是 native 调用、不 fork，成本可忽略）
const POLL_MS = 300 
// 整文件整轮重试上限（-C - 会从半截接着下，重试不丢进度）
const WHOLE_MAX_TRY = 3 
// 单轮最长秒数（无损 25MB 在慢网下也够；-C - 兜底续传）
const WHOLE_MAX_TIME = 600 

// 低速阈值比 curl 通道宽松（16KB/s × 30s）：整文件被掐断一次就要重启整轮，宁可让它在慢节点上多熬一会儿，也别反复重启。
const WHOLE_SPEED_LIMIT_BPS = 16 * 1024
const WHOLE_SPEED_TIME_SEC = 30
// 轮询空转上限（2400 × 300ms = 12 分钟，兜住 rc 文件丢失）
const POLL_TICK_MAX = 2400 

// 落盘前确保 .part 的**父目录**在盘上：新布局 outPath = <downloads|cache>/<track_id>/track.<ext>.part，
// 中间那层曲目目录是下载前才建的；curl 的 -o 不会建父目录，目录缺失时它会直接失败（rc=23）。
// 这里用原生 fs（exists + mkdir，零 fork）补一次，幂等。
async function ensureParentDir(path) {
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
async function killStale(part) {
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
function abortedResult() {
  return { ok: false, size: 0, mode: 'curl', aborted: true, error: '应用退出' }
}

function parseReport(out) {
  // curl -w 输出：HTTP=206 SIZE=123456 SPEED=1234567.0，随后 echo 的 RC=<code>

  const s = String(out || '')
  const g = function (k) {
    const m = s.match(new RegExp(k + '=([-0-9.]+)'))
    return m ? parseFloat(m[1]) : 0
  }
  const rc = s.match(/RC=([0-9]+)/)
  return {
    http: g('HTTP'),
    bytes: g('SIZE'),
    speed: g('SPEED'),
    rc: rc ? parseInt(rc[1], 10) : -1
  }
}

// 取一片并追加进 .part。end=null 表示开区间（-r start-，取到 EOF）。
// 返回 {ok, appended, size, speed, http, rc}
async function fetchChunk(url, start, end, part, tmp) {
  const range = end === null || end === undefined ? start + '-' : start + '-' + end
  const cmd =
    'rm -f "' +
    tmp +
    '"; curl -sS -L --connect-timeout ' +
    CONNECT_TIMEOUT +
    ' --max-time ' +
    CHUNK_MAX_TIME +
    ' --speed-limit ' +
    SPEED_LIMIT_BPS +
    ' --speed-time ' +
    SPEED_TIME_SEC +
    ' -r ' +
    range +
    ' -o "' +
    tmp +
    '" -w "HTTP=%{http_code} SIZE=%{size_download} SPEED=%{speed_download}"' +
    ' -H "User-Agent: ' +
    UA +
    '" -H "Referer: ' +
    REFERER +
    '" "' +
    url +
    '"; echo " RC=$?"'

  let r = null
  try {
    r = await shRun(cmd, (CHUNK_MAX_TIME + 20) * 1000)
  } catch (e) {
    r = null
  }
  const rep = parseReport(r && r.stdout)
  const before = await fileSize(part)

  if (rep.http !== 206 && rep.http !== 200) {
    // 403/404/416/连不上（HTTP=000）等：丢临时文件；半截 .part 保留

    await shRun('rm -f "' + tmp + '"', 5000)
    return { ok: false, appended: false, size: before, speed: rep.speed, http: rep.http, rc: rep.rc }
  }

  const tmpSize = await fileSize(tmp)
  if (rep.http === 200 && start > 0) {
    // 服务端忽略 Range、从头给了整份：只有确实是「完整文件」时才接受，
    // 否则开头的数据接在半截文件后面会把缓存写花

    
    if (tmpSize > start + 65536) {
      await shRun('mv -f "' + tmp + '" "' + part + '"', 8000)
      log('fetch', '服务端忽略 Range，整份替换 size=' + tmpSize)
      return { ok: true, appended: true, size: tmpSize, speed: rep.speed, http: rep.http, rc: rep.rc }
    }
    await shRun('rm -f "' + tmp + '"', 5000)
    return { ok: false, appended: false, size: before, speed: rep.speed, http: rep.http, rc: rep.rc }
  }

  if (tmpSize <= 0) {
    await shRun('rm -f "' + tmp + '"', 5000)
    return { ok: false, appended: false, size: before, speed: rep.speed, http: rep.http, rc: rep.rc }
  }

  // 206：追加（即使 curl 因低速被中断，落盘部分也是完整帧流，照样有效）
  await shRun('cat "' + tmp + '" >> "' + part + '"; rm -f "' + tmp + '"', 15000)
  const after = await fileSize(part)
  if (after <= before) {
    return { ok: false, appended: false, size: before, speed: rep.speed, http: rep.http, rc: rep.rc }
  }
  return { ok: true, appended: true, size: after, speed: rep.speed, http: rep.http, rc: rep.rc }
}

// 分片下载主流程（包一层登记活跃 .part，退出时 stopFetching 能按路径杀掉）
async function curlFetch(opts) {
  const part = opts.outPath
  activeParts[part] = true
  try {
    return await curlFetchInner(opts)
  } finally {
    delete activeParts[part]
  }
}

async function curlFetchInner(opts) {
  const part = opts.outPath
  if (stopping) return abortedResult()
  const tmp = part + '.cur'
  let url = opts.url
  const total = opts.total || 0
  let done = await fileSize(part)
  if (total && done > total) {
    // 脏文件（比目标还大）→ 重来
    await shRun('rm -f "' + part + '"', 8000) 
    done = 0
  }
  let chunk = CHUNK_MIN
  let slowStreak = 0
  let failStreak = 0
  let nodeSwitches = 0
  let lastSpeed = 0

  if (opts.onProgress) opts.onProgress(done, total, 0)

  const switchNode = async function (why) {
    if (!opts.onResolveUrl || nodeSwitches >= MAX_NODE_SWITCH) return
    const nu = await opts.onResolveUrl()
    if (nu && nu !== url) {
      url = nu
      nodeSwitches++
      log('fetch', why + '换节点 (' + nodeSwitches + ')')
    }
  }

  while (total ? done < total : true) {
    // 用户取消（download.js 的 cancelDownload）：**片间检查**，把当前片下完就收手 ——
    // .part 原样保留，下次自动续传（原生 exec 没有杀进程的句柄，只能协作式取消）

    
    if (opts.shouldAbort && opts.shouldAbort()) {
      return { ok: false, size: await fileSize(part), mode: 'curl', aborted: true, error: '已取消' }
    }
    const end = total ? Math.min(done + chunk - 1, total - 1) : null
    const r = await fetchChunk(url, done, end, part, tmp)
    // 退出时 pkill 刚杀掉当前片：别再重试/换节点
    if (stopping) return abortedResult() 
    if (!r.ok) {
      failStreak++
      if (failStreak >= 2) await switchNode('失败(' + r.http + '/' + r.rc + ')')
      if (failStreak >= MAX_TRY_PER_CHUNK) {
        return {
          ok: false,
          size: await fileSize(part),
          mode: 'curl',
          error:
            '下载中断 http=' + r.http + ' rc=' + r.rc + '（已下载 ' + Math.round(done / 1024) + 'KB，保留可续传）'
        }
      }
      await sleep(RETRY_BACKOFF_MS[Math.min(failStreak - 1, RETRY_BACKOFF_MS.length - 1)])
      continue
    }

    failStreak = 0
    const grew = r.size > done
    done = r.size
    if (r.speed > 0) lastSpeed = r.speed

    if (r.speed > 0 && r.speed < LOW_SPEED_BPS) {
      slowStreak++
      chunk = CHUNK_MIN
      if (slowStreak >= 2) await switchNode('低速(' + Math.round(r.speed / 1024) + 'KB/s)')
    } else {
      slowStreak = 0
      if (r.speed > GROW_BPS && chunk < CHUNK_MAX) chunk = Math.min(chunk * 2, CHUNK_MAX)
    }

    if (opts.onProgress) opts.onProgress(done, total, lastSpeed)

    if (!total) {
      // 开区间且正常结束 = 已到 EOF
      if (r.rc === 0) break 
      // 被低速/超时掐断 → 从新大小接着抓
      continue 
    }
    if (!grew) break
  }

  // 尾扫：接口给的 size 偶尔比真实文件小，到点后再开区间探一次防止尾巴被截
  if (total && !stopping && !(opts.shouldAbort && opts.shouldAbort())) {
    let r = await fetchChunk(url, done, null, part, tmp)
    if (stopping) return abortedResult()
    let guard = 0
    while (r.ok && r.appended && guard++ < 30) {
      if (stopping) return abortedResult()
      if (opts.shouldAbort && opts.shouldAbort()) {
        return { ok: false, size: await fileSize(part), mode: 'curl', aborted: true, error: '已取消' }
      }
      if (r.size <= done) break
      done = r.size
      // 正常抓到 EOF
      if (r.rc === 0) break 
      r = await fetchChunk(url, done, null, part, tmp)
      if (r.ok && r.size > done && opts.onProgress) opts.onProgress(done, total, r.speed)
    }
  }

  const size = await fileSize(part)
  return { ok: true, size: size, mode: 'curl', error: '' }
}

// 整文件后台下载（**主路径**，实测：比 512KB 分片快 1.6~2.2 倍）。
// 为什么必须「后台起 + 自己轮询」，不能前台一次 curl：curl 的进度只有结束时经 -w 输出，
// 而 process.exec 是**收完 stdout 才 resolve**，拿不到流式进度 → 前台整文件 = 下载页 % 一直卡在 0。
// 四个真机实测过的关键点：
//   1) 后台命令**必须**重定向 stdout/stderr —— 否则 exec 会被后台进程继承的 stdout 管道拖住，一直等到它结束（实测：重定向后 41ms 返回；不重定向要等满 3s）
//   2) 进度轮询用 fs.stat（native，零 fork）；结束判定用 rc 文件 + fs.exists（同样零 fork）
//   3) 取消用 pkill -9 -f <outPath>：outPath 含歌曲 id，不会误伤别的 curl；实测 51ms 停住，而分片通道要等当前片下完（最坏 4MB / 2MB/s ≈ 2s）
//   4) 断点续传靠 curl -C -：实测半截 3072KB 续到 10441KB，md5 与官方完全一致
async function wholeFetch(opts) {
  const part = opts.outPath
  activeParts[part] = true
  try {
    return await wholeFetchInner(opts)
  } finally {
    delete activeParts[part]
  }
}

async function wholeFetchInner(opts) {
  const part = opts.outPath
  if (stopping) return abortedResult()
  const rcPath = part + '.rc'
  const total = opts.total || 0
  const readSmall = async function (p) {
    return String(await readText(p)).trim()
  }
  let url = opts.url
  let tryNo = 0
  let nodeSwitches = 0
  let lastErr = ''

  while (tryNo < WHOLE_MAX_TRY) {
    if (stopping) return abortedResult()
    tryNo++
    // 脏文件（比目标还大）→ 清掉重来；否则**保留**给 -C - 续传（重试不丢进度）

    const cur = await fileSize(part)
    if (total && cur > total) await shRun('rm -f "' + part + '"', 8000)
    await shRun('rm -f "' + rcPath + '"', 5000)

    const cmd =
      'curl -sS -L -C - -o "' + part + '" --connect-timeout ' + CONNECT_TIMEOUT +
      ' --max-time ' + WHOLE_MAX_TIME +
      ' --speed-limit ' + WHOLE_SPEED_LIMIT_BPS +
      ' --speed-time ' + WHOLE_SPEED_TIME_SEC +
      ' -H "User-Agent: ' + UA + '" -H "Referer: ' + REFERER + '" "' + url +
      '"; echo $? > "' + rcPath + '"'
    await shRun('( /bin/sh -c \'' + cmd + '\' >/dev/null 2>&1 & )', 8000)

    let aborted = false
    let lastSize = await fileSize(part)
    let lastT = Date.now()
    let speed = 0
    let ticks = 0
    while (true) {
      // **完成优先于取消**（探针验证过的真实边界）：curl 已退出（rc 就绪）就按结果往下走 ——
      // 否则「文件刚下完的同时用户点了取消」会被判成已取消，白丢一个完整的 .part（上层不会 promote，下次还要再跑一趟才能补上）。

      

      if (await fileExists(rcPath)) break

      // 退出时 stopFetching 已 pkill：没有 rc 文件就说明是被杀掉的，别再起下一轮。**完成优先于退出**：上面 rc 先查，刚好下完的这一轮仍按成功处理（上层 promote）。
      
      if (stopping) {
        aborted = true
        break
      }
      if (opts.shouldAbort && opts.shouldAbort()) {
        aborted = true
        break
      }
      const sz = await fileSize(part)
      if (sz !== lastSize) {
        const now = Date.now()
        speed = Math.round(((sz - lastSize) * 1000) / Math.max(now - lastT, 1))
        lastSize = sz
        lastT = now
        if (opts.onProgress) opts.onProgress(sz, total, speed)
      }
      if (++ticks > POLL_TICK_MAX) break
      await sleep(POLL_MS)
    }

    if (aborted) {
      // 退出路径：stopFetching 已经 pkill 过，不必再等 250ms（退出要快）

      if (stopping) return abortedResult()
      await shRun('pkill -9 -f "' + part + '" 2>/dev/null; echo ok', 8000)
      // 等它真的放开文件句柄，别让上层立刻 mv 一个还在写的文件
      await sleep(250) 
      return { ok: false, size: await fileSize(part), mode: 'whole', aborted: true, error: '已取消' }
    }

    const rc = parseInt((await readSmall(rcPath)) || '-1', 10)
    const size = await fileSize(part)

    // rc=0 且字节到齐 = 成功。rc=28 = 被 --speed-limit 掐断、其它非 0 = 出错，
    // 两种都交下一轮（-C - 从半截接着下），不浪费已下载的部分
    
    if (rc === 0 && size > 0 && (!total || size >= total * 0.999)) {
      return { ok: true, size: size, mode: 'whole', error: '' }
    }
    if (stopping) return abortedResult()
    lastErr = 'rc=' + rc + ' size=' + size + '/' + total
    log('fetch', '整文件第 ' + tryNo + ' 轮未完成：' + lastErr)

    // 失败判定与下一轮之间也可能被取消：别再白白起一轮 curl
    if (opts.shouldAbort && opts.shouldAbort()) {
      return { ok: false, size: size, mode: 'whole', aborted: true, error: '已取消' }
    }
    if (tryNo >= 2 && nodeSwitches < MAX_NODE_SWITCH && opts.onResolveUrl) {
      const nu = await opts.onResolveUrl(rc)
      if (nu && nu !== url) {
        url = nu
        nodeSwitches++
        log('fetch', '整文件换节点 (' + nodeSwitches + ')')
      }
    }
    await sleep(400)
  }
  return { ok: false, size: await fileSize(part), mode: 'whole', error: '下载失败 ' + lastErr }
}

// 回退通道：运行时内建 http.download（整文件一次；失败删掉半截，避免被当成缓存）。
// **不支持取消**：整文件一次调用没法中途停；调用后若已取消则判为 aborted，由上层删文件。
async function builtinFetch(opts) {
  const path = opts.outPath
  try {
    await ensureParentDir(path)
    await httpDownload({ url: opts.url, outPath: path })
    let size = await fileSize(path)

    // http.download 返回时最后 4KB 可能还没 flush（实测 1KB 首查 0、1MB 少 4096，100ms 后完整）。
    // 该通道只在 curl 不可用时启用；短暂等待后再交给上层做 90% 校验，避免 4KB 缺口被当成完整文件。
    
    for (let i = 0; i < 2 && (!size || (opts.total && size < opts.total)); i++) {
      await sleep(50)
      size = await fileSize(path)
    }
    if (opts.onProgress) opts.onProgress(size, opts.total || 0, 0)
    if (opts.shouldAbort && opts.shouldAbort()) {
      return { ok: false, size: size, mode: 'builtin', aborted: true, error: '已取消' }
    }
    return { ok: true, size: size, mode: 'builtin', error: '' }
  } catch (e) {
    // 清残留半截，避免被当成缓存
    await rmQuiet(path) 
    return { ok: false, size: 0, mode: 'builtin', error: '下载失败: ' + ((e && e.message) || e) }
  }
}

// 把下满的 .part 提升为正式缓存文件（curl 通道用 mv，原子生效；没有 exec 时返回 false，由上层决定怎么办）。
// 两个路径都在同一个曲目目录里（<root>/<id>/track.ext.part → track.ext），目录必然已经存在（下载时建的），mv 不需要额外准备。
export async function promotePart(partPath, finalPath) {
  const okCurl = await has('curl')
  if (!okCurl) return false
  try {
    const r = await shRun('mv -f "' + partPath + '" "' + finalPath + '"', 10000)
    if (!(r && r.code === 0)) return false
    // mv 成功后再确认一次：正式路径必须是完整文件（cmpxchg 式的最后一道）

    return (await fileSize(finalPath)) > 0
  } catch (e) {
    return false
  }
}

// 统一下载入口。
// opts: {url, outPath(.part 路径), total, onProgress(done,total,speed), onResolveUrl(), shouldAbort()}
// shouldAbort = 用户取消（协作式，片间检查；curl 通道保留 .part 可续传）；outPath 形如 <root>/<id>/track.<ext>.part，父目录（曲目目录）在这里统一补齐。
// 返回 {ok, size, mode, error[, aborted]}
export async function fetchToFile(opts) {
  if (!opts || !opts.outPath) {
    return { ok: false, size: 0, mode: 'curl', error: '缺 outPath' }
  }
  if (stopping) return abortedResult()
  await ensureParentDir(opts.outPath)
  const okCurl = await has('curl')
  if (!okCurl) return await builtinFetch(opts)
  try {
    // 上一进程被强杀时，它拉起的 curl 可能还在写同一个 .part。开始前先杀掉（路径含歌曲 id，不会误伤其它下载）；没有残片就跳过，省一次 fork。

    
    if (await fileExists(opts.outPath)) await killStale(opts.outPath)
    if (stopping) return abortedResult()

    // 主路径：整文件（实测比 512KB 分片快 1.6~2.2 倍，取消也从「等当前片」变成 51ms 停住）。
    // 进度由 wholeFetch 自己轮询文件大小提供，对外签名不变。
    
    const r = await wholeFetch(opts)
    if (r.ok || r.aborted) return r
    // 退出中：别回退分片再起一轮
    if (stopping) return abortedResult() 

    // 整文件走不通（CDN 不支持续传 / 反复被掐断 / RC 非 0）→ 回退分片：失败域被片大小限制住、能逐片换节点，是最后一道防线。
    // 两条通道共用同一个 .part，所以分片会从整文件已经下到的位置接着续，不白费流量。
    

    log('fetch', '整文件不通（' + r.error + '）→ 回退分片续传')
    return await curlFetch(opts)
  } catch (e) {
    return {
      ok: false,
      size: await fileSize(opts.outPath),
      mode: 'curl',
      error: '下载异常: ' + ((e && e.message) || e)
    }
  }
}
