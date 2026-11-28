import { log } from '../../core/infra/log.js'
import { sleep } from '../../core/infra/util.js'
import { fileExists, fileSize, readText } from '../../core/platform/fsutil.js'
import { run as shRun } from '../../core/platform/exec.js'
import {
  CONNECT_TIMEOUT, UA, REFERER, WHOLE_MAX_TRY, WHOLE_MAX_TIME,
  WHOLE_SPEED_LIMIT_BPS, WHOLE_SPEED_TIME_SEC, POLL_MS, POLL_TICK_MAX, MAX_NODE_SWITCH,
  isStopping, abortedResult, trackPart, untrackPart
} from './fetch-common.js'

// 整文件后台下载（**主路径**，实测：比 512KB 分片快 1.6~2.2 倍）。
// 为什么必须「后台起 + 自己轮询」，不能前台一次 curl：curl 的进度只有结束时经 -w 输出，
// 而 process.exec 是**收完 stdout 才 resolve**，拿不到流式进度 → 前台整文件 = 下载页 % 一直卡在 0。
// 四个真机实测过的关键点：
//   1) 后台命令**必须**重定向 stdout/stderr —— 否则 exec 会被后台进程继承的 stdout 管道拖住，一直等到它结束（实测：重定向后 41ms 返回；不重定向要等满 3s）
//   2) 进度轮询用 fs.stat（native，零 fork）；结束判定用 rc 文件 + fs.exists（同样零 fork）
//   3) 取消用 pkill -9 -f <outPath>：outPath 含歌曲 id，不会误伤别的 curl；实测 51ms 停住，而分片通道要等当前片下完（最坏 4MB / 2MB/s ≈ 2s）
//   4) 断点续传靠 curl -C -：实测半截 3072KB 续到 10441KB，md5 与官方完全一致
export async function wholeFetch(opts) {
  const part = opts.outPath
  trackPart(part)
  try {
    return await wholeFetchInner(opts)
  } finally {
    untrackPart(part)
  }
}

async function wholeFetchInner(opts) {
  const part = opts.outPath
  if (isStopping()) return abortedResult()
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
    if (isStopping()) return abortedResult()
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
      
      if (isStopping()) {
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

      if (isStopping()) return abortedResult()
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
    if (isStopping()) return abortedResult()
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
