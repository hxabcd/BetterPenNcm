// 媒体源层（拆分自 download.js）：单曲下载落地（downloadOne）与完成收尾。
// 校验、分片/续传细节在 fetcher.js；调度与去重在 scheduler.js。
import { dropPlayMeta, enforceCacheLimit } from './cache.js'
import { saveSongExtras } from './localmeta.js'
import { raceTimeout } from '../../core/infra/util.js'
import { toKind } from '../../core/infra/paths.js'
import { prepareTrackDir, songPath, altPath, dlPath, playCachePath, cachedPath } from './files.js'
import { addProgressHook } from './progress.js'
import { resolveUrl } from './source.js'
import { transportMode, fetchToFile, promotePart } from './fetcher.js'
import { fileSize, rmQuiet } from '../../core/platform/fsutil.js'
import { MIN_AUDIO_BYTES } from './media.js'
import {
  metaReady, metaSatisfies, metaNeedsRetry, repairMeta, finishCompletePart, storeOf
} from './dl-meta.js'
import { notifyFileChanged } from './dl-hooks.js'
import { st } from './dl-state.js'
import { log } from '../../core/infra/log.js'
import * as sched from './scheduler.js'

// 用户正式下载完成后，删掉同 id 的播放缓存副本（同一首不留两份）
export async function purgeCacheCopy(id) {
  const purged = await sched.purgePlayCache(id)
  if (purged.files > 0) {
    await dropPlayMeta(id)
    // player 的 localPath 可能正指着刚被删的缓存文件
    notifyFileChanged(id) 
    log('dl', '下载完成，清掉播放缓存目录 ' + id + '：' + purged.files + ' 个文件 / ' +
      Math.round(purged.bytes / 1024) + 'KB')
  }
  return purged
}

// 下载完成后的共同收尾（正常路径 / 完整残片转正都走这里）
async function finalizeOne(id, kd) {
  if (kd === 'download') {

    // 用户已正式下载这首 → 删掉 cache/<id>/ 整个目录（同一首占两份空间没意义）
    await purgeCacheCopy(id)

    // 退出中不再发详情/歌词请求：应用马上就没了，留给下次启动的 downloads 页 enrich
    if (!st.exiting) {
      try {
        await raceTimeout(saveSongExtras(id), 30000, null)
      } catch (e) {}
    }
  } else if (!st.exiting) {

    // 边听边存：趁刚写入判断一次「缓存上限」，超了就从最久没播的开始滚掉
    enforceCacheLimit().catch(function () {})
  }
}
/* 下载一首到目标目录并校验（分片 + 低速换节点 + 断线续传，见 fetcher.js）。
 * 校验：文件 ≥30KB（MIN_AUDIO_BYTES），且不小于接口报告尺寸的 90%。
 * 不完整时：curl 通道保留 .part 供下次续传；回退通道删掉半截避免被当成缓存。
 * qk：解析直链用的档位 key（也写进元数据的 q：升级判定的依据）。
 * kind：'cache'（边听边存 → cache/<id>/）| 'download'（用户下载 → downloads/<id>/），缺省按 cache。
 * 收尾差异：download 完成 → 清掉同 id 的**缓存目录**（同一首不留两份）；cache 完成 → 触发「缓存上限」LRU 滚动。
 * 返回 {ok, path, size, replaced?, aborted?, error, metaOk?}；另有 fromDisk / fromPart / repaired
 * 等诊断字段（本地命中 / 残片转正 / 补元数据），调度器只认 ok/path/replaced。 */
export async function downloadOne(song, info, opts, qk, kind) {
  const id = String(song.id)
  const kd = toKind(kind)
  const store = storeOf(kd)
  const t0 = Date.now()
  const since = function () {
    return Date.now() - t0
  }

  // 阶段日志（排查用，一次下载 4~5 行）：挂死时「最后一条」就是卡住的那一步
  log('dl', '取源 ' + id + ' ' + (song.name || '') + '[' + kd + ']' +
    (info && info.url ? '（复用播放直链）' : '（按' + qk + '解析）'))

  // 目录准备：通道根 + <root>/<id>/（原生 fs，不 fork）。下载与元数据写入都要求它在
  try {
    await prepareTrackDir(id, kd)
  } catch (e) {}

  // 0) 上次中断但残片已经写满：不联网，直接转正 + 收尾（先于「已有音频」判断 ——
  //    升级时旧文件还在，残片才是这次已经下完的那份）
  
  const donePath = kd === 'download' ? await dlPath(id) : await playCachePath(id)
  let prev = await raceTimeout(store.of(id), 8000, null)
  const fin = await finishCompletePart(song, kd, qk, prev)
  if (fin) {
    await finalizeOne(id, kd)
    return fin
  }

  // 1) 盘上已有完整音频：档位够 → 缺元数据先就地补，然后直接收尾；不够 → 继续升质
  if (donePath) {
    const force = metaNeedsRetry(prev)

    // 只有「档位已经够」时才补元数据；要升质时补写会清 p，后面的 .part 续传就认不出来了
    if (!force && metaSatisfies(prev, qk)) {
      const wasReady = metaReady(prev)
      if (!wasReady) {
        const fixed = await repairMeta(song, donePath, prev, kd)
        if (fixed) prev = fixed
      }
      if (metaSatisfies(prev, qk)) {
        const size = await fileSize(donePath)
        log('dl', '已在本地，跳过 ' + id + '[' + kd + ']' +
          (metaReady(prev) ? '' : '（元数据仍缺，交给 enrich）'))
        return {
          ok: true,
          path: donePath,
          size: size,
          fromDisk: true,
          repaired: !wasReady && metaReady(prev)
        }
      }
    }
    if (force) log('dl', '元数据证据不足，重下一次 ' + id + '[' + kd + ']')
  }

  // 2) 解析直链
  let meta = info
  if (!meta || !meta.url) meta = await raceTimeout(resolveUrl(id, qk), 25000, null)
  if (!meta || !meta.url) {
    log('dl', '无直链 ' + id + '（或解析超时，' + since() + 'ms）')
    return { ok: false, path: '', error: '歌曲受限，暂无直链' }
  }
  log('dl', '直链就绪 ' + id + ' ' + (meta.type || 'mp3') + '/' + (meta.br || 0) +
    (meta.level ? ' lvl=' + meta.level : '') + '（' + since() + 'ms）')

  const ext = meta.type === 'flac' ? 'flac' : 'mp3'
  const finalPath = songPath(id, ext, kd)
  // 盘上已有完整音频 = 本次是升级（begin 记 f=0）
  const hadOld = !!donePath 
  const mode = await raceTimeout(transportMode(), 15000, 'builtin')
  const partPath = finalPath + '.part'

// 续传残片只认同档位：用户中途改过音质的话，旧档的 .part 接上新档字节会写出「长度对、内容是垃圾」的文件
// （校验只查长度，拦不住）→ 档位对不上就丢弃重下
  

  // **从盘上读** p：进程重启后内存快照是空的，只看内存会把上次中断留下的 .part 当跨档残片丢掉，白丢已下载的进度
  
  const pv = (prev && prev.p) || ''
  if ((await fileSize(partPath)) > 0 && pv !== qk) {
    log('dl', '丢弃跨档位的续传残片 ' + id + '[' + kd + ']（残片档=' + (pv || '未知') + ' 本次=' + qk + '）')
    await rmQuiet(partPath)
    await rmQuiet(partPath + '.cur')
  }

  // 下载开始就先写基础元数据（歌名/歌手/时长/封面 + p + 预期大小 z）：之后任何时刻退出，都不会出现
  // 「有歌没名字」。升级时 begin 不碰旧的 q/b/y
  
  let begun = null
  try {
    begun = await raceTimeout(store.begin(song, qk, meta.size || 0, hadOld), 8000, null)
  } catch (e) {}
  if (!begun) log('dl', '基础元数据写入失败 ' + id + '（下载继续，完成后再写一次）')
  const target = mode === 'curl' ? partPath : finalPath
  log('dl', '拉取开始 ' + id + ' mode=' + mode + '（' + since() + 'ms）')

  const r = await raceTimeout(
    fetchToFile({
      url: meta.url,
      outPath: target,
      total: meta.size || 0,
      onProgress: opts && opts.onProgress,
      shouldAbort: opts && opts.shouldAbort,

      

      // 低速 / 断线时重新取直链（换 CDN 节点）。格式漂移防护：降级链可能让新直链换了容器（flac→mp3），
      // 把 mp3 数据续进 flac 的 .part 会写花缓存 → 格式不同就不换
      onResolveUrl: async function () {
        const m2 = await resolveUrl(id, qk)
        if (!m2 || !m2.url) return null
        const cur = meta.type === 'flac' ? 'flac' : 'mp3'
        const nxt = m2.type === 'flac' ? 'flac' : 'mp3'
        return nxt === cur ? m2.url : null
      }
    }),
    8 * 60 * 1000,
    { ok: false, size: 0, aborted: false, error: '拉取超时' }
  )

  const size = (r && r.size) || (await fileSize(target))
  log('dl', '拉取结束 ' + id + ' ok=' + !!(r && r.ok) + ' size=' + size + '（' + since() + 'ms）' +
    (r && r.error ? ' err=' + r.error : ''))
  const want = meta.size || 0
  if (!r.ok || !size || size < MIN_AUDIO_BYTES || (want > 0 && size < want * 0.9)) {
    // 回退通道不留半截
    if (mode !== 'curl') await rmQuiet(finalPath) 
    return {
      ok: false,
      path: '',
      size: size,
      aborted: !!(r && r.aborted),
      error: (r && r.error) || '文件不完整 size=' + size + (want ? '/' + want : '')
    }
  }

  if (mode === 'curl') {

    // 下满 → mv 提升为正式缓存（原子，cachedPath 只会看到完整文件）
    const moved = await promotePart(partPath, finalPath)
    if (!moved) {

      // mv 失败（极少见）：再试一次，仍失败则退化成「.part 当成品」不可接受 → 报错保留续传
      const again = await promotePart(partPath, finalPath)
      if (!again) {
        log('cache', '提升缓存失败 ' + id + '（.part 保留可续传）')
        return { ok: false, path: '', size: size, error: '缓存提升失败（可重试续传）' }
      }
    }
  }

  // 一个 id 在本目录只留一个文件：清掉另一种扩展名的旧文件（如先存了 320k mp3，改无损后重下）。
  // ⚠ 反向也成立：请求无损/Hi-Res 但服务端降级成 mp3 时，旧的 .flac 会被这里删掉 —— 即「降质替换」
  

  const alt = altPath(id, ext, kd)
  const altHad = (await fileSize(alt)) > 0
  await rmQuiet(alt)

  // 完成态元数据：写 q/b/y 并清掉 p/z。落库失败重试一次；仍失败只记日志
  // （文件本身仍是真相，启动对账/下次下载会再补，不能因此判下载失败）
  
  let metaOk = false
  for (let i = 0; i < 2; i++) {
    try {
      const pr = await raceTimeout(store.put(song, meta.br, ext, qk), 8000, null)
      if (pr && pr.ok) {
        metaOk = true
        break
      }
    } catch (e) {}
  }
  if (!metaOk) log('dl', '元数据写入失败 ' + id + '（文件在，下次启动对账再补）')
  await finalizeOne(id, kd)
  return { ok: true, path: finalPath, size: size, replaced: hadOld || altHad, metaOk: metaOk }
}

/* 确保某首歌有完整本地文件（播放用）。返回 Promise<{ok, path, size, error}>：
 * 磁盘已有 / 本会话已下过 → 立即返回；正在下载（任意通道）→ 复用同一个 Promise；否则排队（播放通道、最新优先）。
 * 注意：**不重下低档缓存**（升质是用户下载通道的事）—— 播放要的只是「能播」。失败不缓存结果，下次调用会重试（半截 .part 会续传）。
 * ⚠ 超时语义：下面的 9 分钟兜底超时**只放弃等待、不取消底层任务** —— 底层下载会继续跑完并写缓存
 * （缓存幂等，不会产生坏数据；见 util.js raceTimeout 的语义说明）。超时发生时会打一条带 id 的日志。 */
export function ensureCached(song, info, opts) {
  const id = String(song.id)
  const cachedDone = sched.getDone(id)
  if (cachedDone) return Promise.resolve({ ok: true, path: cachedDone, size: 0 })

  const wait = sched.getWait(id)
  if (wait) {
    addProgressHook(id, opts && opts.onProgress)
    return wait
  }
  const old = sched.getFlight(id)
  if (old) {

    // 搭车（正在下载的可能是个批量项）：把播放的进度回调挂上，否则界面停在「缓冲中 0%」
    addProgressHook(id, opts && opts.onProgress)
    return old
  }

  const p = (async function () {
    try {
      log('dl', '查缓存 ' + id)
      const hit = await raceTimeout(cachedPath(id), 12000, null)
      log('dl', '查缓存结果 ' + id + ' → ' + (hit || '未命中'))
      if (hit) {
        sched.setDone(id, hit)
        return { ok: true, path: hit, size: 0, fromDisk: true }
      }

      // 外层总兜底（9 分钟）：即便内部哪一步又挂死，也不会把调用方永远钉在「缓冲中」
      // （超时只放弃等待、底层继续跑）
      
      const t0 = Date.now()
      const r = await raceTimeout(
        sched.queueDownload(song, info || null, opts || null),
        9 * 60 * 1000,
        { ok: false, path: '', error: '下载超时' }
      )
      if (r && r.error === '下载超时') {
        log('dl', 'ensureCached 兜底超时(9min) ' + id + '（底层任务未取消，仍可能在后台完成）' +
          ' 等待 ' + Math.round((Date.now() - t0) / 1000) + 's')
      }
      return r
    } catch (e) {
      return { ok: false, path: '', error: '缓存异常: ' + ((e && e.message) || e) }
    }
  })()

  sched.setWait(id, p)
  p.then(function (r) {
    sched.clearWait(id, p)
    if (r && r.ok) {
      sched.setDone(id, r.path)
      log('cache', '缓存就绪 ' + id + ' ' + Math.round((r.size || 0) / 1024) + 'KB')
    }
  })
  return p
}
