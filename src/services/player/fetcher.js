

// 下载传输层 —— 系统 curl 下载（**整文件为主，分片为兜底**）。
// 真机实测：process.exec('/bin/sh', ['-c', cmd], {timeout,maxBuffer}) 可用（root 身份，返回 {code,stdout,stderr}；
// exec 不解析命令串，必须显式 /bin/sh -c）；设备 curl 7.77.0，`-r a-b` 返回 206（CDN 支持 Range）→ 分片与续传成立；
// 每次 exec 在这台 32 位 ARMv7 上一次 fork 要 92~139ms，而每片要付 2 次 exec。
// 同一首 10.69MB 实测：整文件 11002KB/s ｜ 4MB 片 7758 ｜ 2MB 片 3439 ｜ 512KB 片 1990 —— 分片本身就是最大的开销来源。
// 所以主路径是整文件（-C - 续传 + pkill 取消），分片只在整文件反复失败时兜底；两边共用同一个 .part。
import { fileExists, fileSize } from '../../core/platform/fsutil.js'
import { has, run as shRun } from '../../core/platform/exec.js'
import { isStopping, abortedResult, ensureParentDir, killStale } from './fetch-common.js'
import { wholeFetch } from './fetch-whole.js'
import { curlFetch } from './fetch-curl.js'
import { builtinFetch } from './fetch-builtin.js'

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
  if (isStopping()) return abortedResult()
  await ensureParentDir(opts.outPath)
  const okCurl = await has('curl')
  if (!okCurl) return await builtinFetch(opts)
  try {
    // 上一进程被强杀时，它拉起的 curl 可能还在写同一个 .part。开始前先杀掉（路径含歌曲 id，不会误伤其它下载）；没有残片就跳过，省一次 fork。

    
    if (await fileExists(opts.outPath)) await killStale(opts.outPath)
    if (isStopping()) return abortedResult()

    // 主路径：整文件（实测比 512KB 分片快 1.6~2.2 倍，取消也从「等当前片」变成 51ms 停住）。
    // 进度由 wholeFetch 自己轮询文件大小提供，对外签名不变。
    
    const r = await wholeFetch(opts)
    if (r.ok || r.aborted) return r
    // 退出中：别回退分片再起一轮
    if (isStopping()) return abortedResult() 

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

// 三条取数通道与模块状态收在 fetch-*.js；本文件保留公共入口与导出面
export { transportMode, stopFetching, isStopping, resetFetching, killPartFetch } from './fetch-common.js'

