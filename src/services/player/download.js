


/* 媒体源层 —— 对外门面：对外 API 与跨模块编排都在本文件，队列/调度在 scheduler.js、
 * 任务清单在 tasks.js、路径探测在 files.js、直链解析在 source.js、传输在 fetcher.js。
 * 两条通道，同一套「每 track 一个目录」布局：
 *   - **play 通道**（ensureCached）：播放要用的缓存，落 data/cache/<id>/、按**播放音质**、
 *     受「缓存上限」LRU 滚动、**不出现在本地下载**；最新请求优先（新请求作废旧的等待者）。
 *   - **batch 通道**（downloadSongs）：用户主动下载，落 data/downloads/<id>/、按**下载音质**、
 *     永久保留、计入本地下载；FIFO 不淘汰、重试不丢。
 *   整体单并发（不跟流播抢带宽），播放通道优先调度；播放请求可以**提权**批量项，但只改调度
 *   通道、不改队列项的 kind —— 用户点下的下载不会因被提权就变成缓存。
 *   元数据与歌词在状态库 track_meta / track_lyric（media.js 统一读写）。
 *
 * 实现按功能拆在同目录：dl-meta（判重/补元数据/残片转正）、dl-song（单曲下载）、dl-pending（待续传与退出）、
 * dl-reconcile（启动对账）、dl-delete（删除与路径失效）、dl-text（文案/签名/空间预检）、
 * dl-hooks（文件变更钩子）、dl-state（共享可变状态）。本文件保留对外导出面与跨模块编排。
 * 新增文件用 dl- 前缀：同目录的 cache- / fetch- / lists- / meta2- 另有归属，别混用。 */

import { warmMeta } from './cache.js'
import { currentQuality } from './quality.js'
import { markUser, markPlaylist, markSkippedExisting } from './dlorigin.js'
import { dlPath } from './files.js'
import { log } from '../../core/infra/log.js'
import * as sched from './scheduler.js'
import * as tasks from './tasks.js'
import { downloadOne } from './dl-song.js'
import { notifyFileChanged } from './dl-hooks.js'
import { pendingAdd, pendingDrop, pendingClear } from './dl-pending.js'
import { metaReady, metaSatisfies, metaNeedsRetry, repairMeta } from './dl-meta.js'
import { st } from './dl-state.js'
import { getStorage, KEY_DL_PENDING } from '../../core/infra/store.js'
import { isOffline } from '../../core/infra/net/status.js'
import { sleep } from '../../core/infra/util.js'

// 门面转发：原文件既有的公共导出面，符号与签名一个不少
export { resolveUrl } from './source.js'
export { cachedPath, dlPath, playCachePath } from './files.js'
export { cancelDownload } from './scheduler.js'
export { dlState, onDl, offDl, dlTasks, ackFinished, cancelTask } from './tasks.js'
export { setFileChangedHook } from './dl-hooks.js'
export {
  estimateBytes, touchPlayCache, dlText, startText, resultText, spaceCheck, dlSig
} from './dl-text.js'
export { stopForExit, resetExit } from './dl-pending.js'
export { reconcileDownloads } from './dl-reconcile.js'
export { ensureCached } from './dl-song.js'
export {
  deleteCached, deleteBatchState, deleteBatch, forgetAll, invalidateLocalPaths
} from './dl-delete.js'

// scheduler 需要「真正的下载动作」与「文件变更通知」；两边的相互引用都收敛在这里，
// 调度器与任务模块之间零循环依赖
sched.wireScheduler({
  downloadOne: downloadOne,
  notifyFileChanged: notifyFileChanged
})


// 启动后续传上次没下完的队列（boot 在登录态就绪后调用，不 await）：
// 已下完的会按 metaReady+metaSatisfies 自动跳过；离线则原样留着，下次启动再试
export async function resumePendingDownloads() {
  let arr = []
  try {
    const raw = await getStorage(KEY_DL_PENDING)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) arr = parsed
    }
  } catch (e) {}
  if (!arr.length) {
    await pendingClear()
    return { resumed: 0 }
  }
  if (await isOffline()) {
    log('dl', '上次未完成的下载 ' + arr.length + ' 首：当前离线，保留到下次启动')
    return { offline: true, pending: arr.length }
  }
  // 让首页/播放恢复先起来，别抢启动带宽
  await sleep(2000) 
  if (st.exiting) return { resumed: 0 }
  log('dl', '续传上次未完成的下载 ' + arr.length + ' 首')
  const manual = []
  const playlist = []
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i]
    if (!it || !it.id) continue
    if (it.origin === 'playlist') playlist.push(it)
    else manual.push(it)
  }
  if (manual.length) {
    downloadSongs(manual, { origin: 'manual' }).catch(function (e) {
      log('dl', '续传异常：' + ((e && e.message) || e))
    })
  }
  if (playlist.length) {
    downloadSongs(playlist, { origin: 'playlist' }).catch(function (e) {
      log('dl', '续传异常：' + ((e && e.message) || e))
    })
  }
  return { resumed: manual.length + playlist.length }
}


// UI 层注入用的门面（ui/mixins/dlsub.js 不直接 import services）：页面 bindDl(this, dlApi, fn)
export const dlApi = {
  onDl: tasks.onDl,
  offDl: tasks.offDl,
  dlState: tasks.dlState
}
/* 用户下载（播放器页「下载」键 / 列表多选下载 / 本地歌单「下载全部」/ 同步）：
 *   - 已达标缓存 → 跳过（skipped）；档位低于当前「下载档」→ 重下替换（升质；先下 .part 再 mv 顶替，失败不破坏旧文件）
 *   - 其余入 batch 队列（FIFO、不淘汰；单并发，播放通道优先）
 * 逐首 resolve 后汇总，**永远 resolve 不抛**（页面 toast 才有落点）。返回 {total, ok, failed, skipped, cancelled, error, results}。
 * opts.origin：'manual'（默认，完成后写 user 归属）| 'playlist'（本地歌单「下载全部」/ 同步 → playlist 归属；
 *   跳过已存在文件时只给**没有标记**的补 user。归属只影响本地下载页的分类，不改变文件行为） */
export async function downloadSongs(songs, opts) {
  st.activeBatches++
  const batch = []
  const src = songs || []
  for (let i = 0; i < src.length; i++) {
    if (src[i] && src[i].id) batch.push(src[i])
  }
  try {
    return await downloadSongsInner(songs, opts)
  } finally {
    st.activeBatches--

    if (!st.exiting) await pendingDrop(batch)
  }
}

async function downloadSongsInner(songs, opts) {
  const mode = (opts && opts.origin === 'playlist') ? 'playlist' : 'manual'
  const list = []
  const src = songs || []
  for (let i = 0; i < src.length; i++) {
    if (src[i] && src[i].id) list.push(src[i])
  }
  const res = { total: list.length, ok: 0, failed: 0, skipped: 0, cancelled: 0, error: '', results: [] }
  if (!list.length) return res
  const qk = currentQuality('down')

  // 先记「待续传快照」：退出/被强杀后，下次启动据此接续（已下完的会自动跳过）
  await pendingAdd(list, qk, mode)
  const jobs = []
  for (let i = 0; i < list.length; i++) {
    const song = list[i]

    // ⚠ 只看**下载目录**：只有播放缓存（cache/）不算已下载，照样要走一趟正式下载
    // （下载档通常更高，且下载完成后会清掉 cache 里的副本，不留两份）
    
    const hit = await dlPath(song.id)
    if (hit) {
      let meta = await warmMeta(song.id)
      const force = metaNeedsRetry(meta)

      // 只有「当前档位已经够」时才就地补元数据并跳过。档位不够（要升质）时**不能补**：
      // 补写会清掉 p，downloadOne 就认不出上次留下的同档位 .part，续传进度白丢
      
      if (!force && metaSatisfies(meta, qk)) {
        if (!metaReady(meta)) {
          const fixed = await repairMeta(song, hit, meta, 'download')
          if (fixed) meta = fixed
        }

        // 补完再判一次：fresh 行用 p 回填档位后，可能发现 p 低于目标 → 仍要走升质
        if (metaSatisfies(meta, qk)) {
          res.skipped++
          res.results.push({ id: song.id, status: 'skipped', existed: true })
          continue
        }
      }
      if (force) log('dl', '元数据证据不足，重下一次 ' + song.id)
    }
    log('dl', '下载入队 ' + song.id + ' ' + (song.name || '') +
      (hit ? '（升质重下 → ' + qk + '）' : ''))
    jobs.push({ song: song, p: sched.enqueueBatch(song, qk) })
  }
  for (let i = 0; i < jobs.length; i++) {
    let r = await jobs[i].p

    // 搭车到「播放通道」的项可能被用户切歌顶掉（superseded）——重排一次到批量通道，
    // 别把用户的下载静默吞掉（第二次还失败才算失败）
    
    if (r && r.superseded) {
      log('dl', '下载被播放请求顶掉，重排 ' + jobs[i].song.id)
      r = await sched.enqueueBatch(jobs[i].song, qk)
    }
    if (r && r.ok) {
      res.ok++
      res.results.push({ id: jobs[i].song.id, status: 'ok', existed: false })
    } else if (r && r.aborted) {
      res.cancelled++
      res.results.push({ id: jobs[i].song.id, status: 'cancelled', existed: false })
    } else {
      res.failed++
      res.results.push({ id: jobs[i].song.id, status: 'failed', existed: false })
      if (!res.error && r && r.error) res.error = r.error
    }
  }

  // 归属标记：ok → 按来源写；skipped → 歌单来源只给无标记的补 user
  try {
    const okIds = []
    const skippedIds = []
    for (let i = 0; i < res.results.length; i++) {
      if (res.results[i].status === 'ok') okIds.push(res.results[i].id)
      else if (res.results[i].status === 'skipped') skippedIds.push(res.results[i].id)
    }
    if (mode === 'playlist') {
      if (okIds.length) await markPlaylist(okIds)
      if (skippedIds.length) await markSkippedExisting(skippedIds)
    } else {
      const all = okIds.concat(skippedIds)
      if (all.length) await markUser(all)
    }
  } catch (e) {
    log('dl', '归属标记失败（不影响下载）：' + ((e && e.message) || e))
  }
  log('dl', '批量下载完成：共 ' + res.total + ' 成功 ' + res.ok + ' 失败 ' + res.failed +
    ' 跳过 ' + res.skipped + ' 取消 ' + res.cancelled + ' origin=' + mode)
  return res
}
