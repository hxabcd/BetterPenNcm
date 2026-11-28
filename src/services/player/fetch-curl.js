import { log } from '../../core/infra/log.js'
import { sleep } from '../../core/infra/util.js'
import { fileSize } from '../../core/platform/fsutil.js'
import { run as shRun } from '../../core/platform/exec.js'
import {
  CHUNK_MIN, CHUNK_MAX, GROW_BPS, LOW_SPEED_BPS, SPEED_LIMIT_BPS, SPEED_TIME_SEC,
  CONNECT_TIMEOUT, CHUNK_MAX_TIME, MAX_TRY_PER_CHUNK, MAX_NODE_SWITCH, RETRY_BACKOFF_MS,
  UA, REFERER, isStopping, abortedResult, trackPart, untrackPart
} from './fetch-common.js'

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
export async function curlFetch(opts) {
  const part = opts.outPath
  trackPart(part)
  try {
    return await curlFetchInner(opts)
  } finally {
    untrackPart(part)
  }
}

async function curlFetchInner(opts) {
  const part = opts.outPath
  if (isStopping()) return abortedResult()
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
    if (isStopping()) return abortedResult() 
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
  if (total && !isStopping() && !(opts.shouldAbort && opts.shouldAbort())) {
    let r = await fetchChunk(url, done, null, part, tmp)
    if (isStopping()) return abortedResult()
    let guard = 0
    while (r.ok && r.appended && guard++ < 30) {
      if (isStopping()) return abortedResult()
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
