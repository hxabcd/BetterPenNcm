/**
 * 下载传输层 —— 系统 curl 下载（**整文件为主，分片为兜底**）
 *
 * 真机探针实测（设备日志 probe 段）：
 *   - `process.exec('/bin/sh', ['-c', cmd], {timeout,maxBuffer})` 可用，root 身份，
 *     返回 {code, stdout, stderr}；**注意 exec 不解析命令串，必须显式 /bin/sh -c**
 *   - 设备 curl 7.77.0：`-r a-b` 返回 206（CDN 支持 Range）→ 分片与续传成立
 *   - 传输速度取决于站点/CDN：同一链路下整文件 curl 与内建 http.download 可同速
 *     （局域网实测 9~10MB/s；慢站点两者都可能只有 0.2~0.4MB/s）。
 *     这里以 curl 为主通道是因为续传/进度/取消，而不是固定倍率。
 *
 * 应用内实测（探针工程 `dev/dl-probe/`，同一首 10.69MB 当场 A/B）——
 * **分片本身就是最大的开销来源**：`process.exec` 一次 fork 在这台 32 位 ARMv7 上要
 * 48~52ms（宿主 miniapp 进程内存大，fork 复制页表贵），而每片要付 2 次 exec：
 *   512KB 片 1990KB/s ｜ 2MB 片 3439KB/s ｜ 4MB 片 7758KB/s ｜ **整文件一次 11002KB/s**
 *   整首墙钟：分片现状 1981~2118ms → 整文件 950~1225ms（**1.6~2.2 倍**）
 *   2026-10-17 局域网复测（固定片长、2 exec/片）：整文件 1.09s、4MB 片 2.56s、512KB 片 4.61s；
 *   片数/连接数比片大小更关键，快链路上分片开销占比更高。
 * 所以主路径改为整文件：
 *   - **整文件**：后台起 curl（`-C -` 断点续传）下整个文件，JS 侧轮询进度；
 *     取消用 pkill（51ms 停住，比分片"等当前片下完"快得多）；md5 实测与官方一致
 *   - **分片（兜底）**：整文件反复失败（CDN 不支持续传 / 总被掐断）时回退——
 *     失败域被片大小限制住、能逐片换节点，是最后一道防线；两边共用同一个 .part，接着续
 *   - **低速检测**：curl `--speed-limit/--speed-time` 在传输层掐掉卡死连接（退出码 28）
 *   - exec/curl 不可用时回退内建 http.download（整文件一次，无续传）
 */
import { download as httpDownload } from '../net/request.js'
import { log } from '../log.js'
import { sleep } from '../util.js'
import { fileExists, fileSize, rmQuiet } from '../fsutil.js'
import { has, run as shRun } from '../exec.js'

/* ---- 参数 ---- */
/* 分片尺寸（调优）：每片一次 curl 进程 + 一次 cat 追加，片太小则连接建立
   （新 TCP + 慢启动）开销占比高——真机实测 256KB 片在 ~400KB/s 网络下只有 ~300KB/s 有效
   速度（裸 curl 单连接 393KB/s）。改为 512KB 起、按片速 ≥256KB/s 翻倍（上限 4MB）：
   同一网络下连接数减半以上；低速时仍落回下限（失去的只是取消/进度的粒度）。 */
const CHUNK_MIN = 512 * 1024 // 分片下限（低速用：失败域小、进度细）
const CHUNK_MAX = 4 * 1024 * 1024 // 分片上限（高速用：省进程开销）
const GROW_BPS = 256 * 1024 // 片速超过它才翻倍（原 1MB/s——在 400KB/s 的网络里永远不翻倍）
const LOW_SPEED_BPS = 64 * 1024 // JS 侧判低速阈值
const SPEED_LIMIT_BPS = 48 * 1024 // curl --speed-limit
const SPEED_TIME_SEC = 10 // 低于限速持续这么久 → curl 中断（rc=28），交上层续传
const CONNECT_TIMEOUT = 8
const CHUNK_MAX_TIME = 120 // 单次请求最长秒数
const MAX_TRY_PER_CHUNK = 3 // 连续失败上限（跨片计数，成功即清零）
const MAX_NODE_SWITCH = 3 // 换节点次数上限
const RETRY_BACKOFF_MS = [400, 1200, 3000]
const UA = 'Mozilla/5.0 (Linux; arm; Android 10) AppleWebKit/537.36'
const REFERER = 'https://music.163.com/'

/* ---- 整文件通道参数（实测调优，见文件头）---- */
const POLL_MS = 300 // 进度轮询间隔（fs.stat 是 native 调用、不 fork，成本可忽略）
const WHOLE_MAX_TRY = 3 // 整文件整轮重试上限（-C - 会从半截接着下，重试不丢进度）
const WHOLE_MAX_TIME = 600 // 单轮最长秒数（无损 25MB 在慢网下也够；`-C -` 兜底续传）
/* 低速阈值比 curl 通道宽松（16KB/s × 30s）：整文件被掐断一次就要重启整轮，
   宁可让它在慢节点上多熬一会儿，也别反复重启。 */
const WHOLE_SPEED_LIMIT_BPS = 16 * 1024
const WHOLE_SPEED_TIME_SEC = 30
const POLL_TICK_MAX = 2400 // 轮询空转上限（2400 × 300ms = 12 分钟，兜住 rc 文件丢失)

/* ---- 能力探测：统一走 utils/exec.js（curl 一次探测、进程内缓存） ----
 * 原 detect()/execFn 的本地实现已删；`fileSize` / `fileExists` / `sleep` 也用公共版
 * （fsutil.js / util.js）。文件是否存在的轮询约束（native 调用、不 fork）见 fsutil.fileExists。 */

/** 当前通道：'curl' | 'builtin'（上层据此决定能否用 mv 提升 .part） */
export async function transportMode() {
  return (await has('curl')) ? 'curl' : 'builtin'
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

/**
 * 取一片并追加进 .part。
 * end=null 表示开区间（-r start-，取到 EOF）。
 * 返回 {ok, appended, size, speed, http, rc}
 */
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

/** 分片下载主流程 */
async function curlFetch(opts) {
  const part = opts.outPath
  const tmp = part + '.cur'
  let url = opts.url
  const total = opts.total || 0
  let done = await fileSize(part)
  if (total && done > total) {
    await shRun('rm -f "' + part + '"', 8000) // 脏文件（比目标还大）→ 重来
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

  /* 主循环：已知长度就切片抓，未知长度就开区间抓到 EOF */
  while (total ? done < total : true) {
    // 用户取消（download.js 的 cancelDownload）：**片间检查**，把当前片下完就收手——
    // .part 原样保留，下次自动续传（原生 exec 没有杀进程的句柄，只能协作式取消）
    if (opts.shouldAbort && opts.shouldAbort()) {
      return { ok: false, size: await fileSize(part), mode: 'curl', aborted: true, error: '已取消' }
    }
    const end = total ? Math.min(done + chunk - 1, total - 1) : null
    const r = await fetchChunk(url, done, end, part, tmp)
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

    /* ---- 低速检测 ---- */
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
      if (r.rc === 0) break // 开区间且正常结束 = 已到 EOF
      continue // 被低速/超时掐断 → 从新大小接着抓
    }
    if (!grew) break
  }

  /* 尾扫：接口给的 size 偶尔比真实文件小，到点后再开区间探一次防止尾巴被截 */
  if (total && !(opts.shouldAbort && opts.shouldAbort())) {
    let r = await fetchChunk(url, done, null, part, tmp)
    let guard = 0
    while (r.ok && r.appended && guard++ < 30) {
      if (opts.shouldAbort && opts.shouldAbort()) {
        return { ok: false, size: await fileSize(part), mode: 'curl', aborted: true, error: '已取消' }
      }
      if (r.size <= done) break
      done = r.size
      if (r.rc === 0) break // 正常抓到 EOF
      r = await fetchChunk(url, done, null, part, tmp)
      if (r.ok && r.size > done && opts.onProgress) opts.onProgress(done, total, r.speed)
    }
  }

  const size = await fileSize(part)
  return { ok: true, size: size, mode: 'curl', error: '' }
}

/* ============ 整文件后台下载（**主路径**，实测：比 512KB 分片快 1.6~2.2 倍） ============
 *
 * 为什么必须"后台起 + 自己轮询"，不能前台一次 curl：
 *   curl 的进度只有结束时经 `-w` 输出，而 `process.exec` 是**收完 stdout 才 resolve**，
 *   拿不到流式进度 → 前台整文件 = 没有进度条（下载页 % 会一直卡在 0）。
 *   后台起进程 + 自己 stat 文件，就能同时拿到"整文件的速度"和"平滑的进度"。
 *
 * 四个真机实测过的关键点（探针工程 dev/dl-probe，v3/v4）：
 *   1) 后台命令**必须** `>/dev/null 2>&1` —— 否则 exec 会被后台进程继承的 stdout
 *      管道拖住，一直等到它结束（实测：重定向后 41ms 返回；不重定向则要等满 3s）
 *   2) 进度轮询用 `fs.stat`（native，零 fork）；结束判定用 rc 文件 + `fs.exists`（同样零 fork）
 *   3) 取消用 `pkill -9 -f <outPath>`：outPath 含歌曲 id，不会误伤别的 curl；
 *      实测 51ms 停住，而分片通道要等当前片下完（最坏 4MB / 2MB/s ≈ 2s）
 *   4) 断点续传靠 curl `-C -`：实测半截 3072KB 续到 10441KB，**md5 与官方完全一致**
 */
async function wholeFetch(opts) {
  const part = opts.outPath
  const rcPath = part + '.rc'
  const total = opts.total || 0
  const readSmall = async function (p) {
    const r = await shRun('cat "' + p + '" 2>/dev/null', 5000)
    return String((r && r.stdout) || '').trim()
  }
  let url = opts.url
  let tryNo = 0
  let nodeSwitches = 0
  let lastErr = ''

  while (tryNo < WHOLE_MAX_TRY) {
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
      // **完成优先于取消**（探针验证过的真实边界）：curl 已退出（rc 就绪）
      // 就按结果往下走 —— 否则「文件刚下完的同时用户点了取消」会被判成已取消，
      // 白丢一个完整的 .part（上层不会 promote，下次还要再跑一趟才能补上）。
      if (await fileExists(rcPath)) break
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
      await shRun('pkill -9 -f "' + part + '" 2>/dev/null; echo ok', 8000)
      await sleep(250) // 等它真的放开文件句柄，别让上层立刻 mv 一个还在写的文件
      return { ok: false, size: await fileSize(part), mode: 'whole', aborted: true, error: '已取消' }
    }

    const rc = parseInt((await readSmall(rcPath)) || '-1', 10)
    const size = await fileSize(part)
    // rc=0 且字节到齐 = 成功。rc=28 = 被 --speed-limit 掐断、其它非 0 = 出错
    // 两种都交下一轮（`-C -` 从半截接着下），不浪费已下载的部分
    if (rc === 0 && size > 0 && (!total || size >= total * 0.999)) {
      return { ok: true, size: size, mode: 'whole', error: '' }
    }
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

/** 回退通道：运行时内建 http.download（整文件一次；失败删掉半截，避免被当成缓存。
 *  **不支持取消**：整文件一次调用没法中途停；调用后若已取消则判为 aborted，由上层删文件） */
async function builtinFetch(opts) {
  const path = opts.outPath
  try {
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
    await rmQuiet(path) // 清残留半截，避免被当成缓存
    return { ok: false, size: 0, mode: 'builtin', error: '下载失败: ' + ((e && e.message) || e) }
  }
}

/**
 * 把下满的 .part 提升为正式缓存文件（curl 通道用 mv，原子生效；
 * 没有 exec 时返回 false，由上层决定怎么办）
 */
export async function promotePart(partPath, finalPath) {
  const okCurl = await has('curl')
  if (!okCurl) return false
  try {
    const r = await shRun('mv -f "' + partPath + '" "' + finalPath + '"', 10000)
    return !!(r && r.code === 0)
  } catch (e) {
    return false
  }
}

/** 统一下载入口。
 * opts: {url, outPath(.part 路径), total, onProgress(done,total,speed), onResolveUrl(), shouldAbort()}
 *   shouldAbort —— 用户取消（协作式，片间检查；curl 通道保留 .part 可续传）
 * 返回 {ok, size, mode, error[, aborted]}
 */
export async function fetchToFile(opts) {
  const okCurl = await has('curl')
  if (!okCurl) return await builtinFetch(opts)
  try {
    // 主路径：整文件（实测比 512KB 分片快 1.6~2.2 倍，取消也从"等当前片"
    // 变成 51ms 停住）。进度由 wholeFetch 自己轮询文件大小提供，对外签名不变。
    const r = await wholeFetch(opts)
    if (r.ok || r.aborted) return r
    // 整文件走不通（CDN 不支持续传 / 反复被掐断 / RC 非 0）→ 回退分片：
    // 失败域被片大小限制住、能逐片换节点，是最后一道防线。
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
