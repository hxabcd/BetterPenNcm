/**
 * 媒体源层 —— 对外门面。
 *
 * 本文件只保留三样东西：
 *   1. **对外 API**（下面的 export 列表，其它模块的 import 保持稳定）；
 *   2. **编排**：ensureCached / downloadSongs / downloadOne / deleteCached 等跨模块流程；
 *   3. 本地文件变更钩子（player.js 注册）。
 * 队列与调度在 scheduler.js，活动快照/任务清单在 tasks.js，路径探测在 files.js，
 * 直链解析在 source.js，进度转发在 progress.js，下载传输在 fetcher.js。
 *
 * 当前播放路径：播放不再等整首下完，点歌先用直链出声（player.js 统一走
 * `playFile(直链, pos, rate)`，本地文件也是同一条路），下载退居幕后做缓存。
 * 两条通道（详见 scheduler.js 头部）：
 *   - **play 通道**（ensureCached）：播放要用的缓存，**最新请求优先**（新请求作废旧的等者）
 *   - **batch 通道**（downloadSongs）：用户主动下载（播放器页「下载」/ 列表多选下载），
 *     FIFO 不淘汰、重试不丢；播放通道优先调度，整体仍是单并发（不跟流播抢带宽）
 *
 * **「缓存」与「下载」分家**（两个目录两张元数据表）：
 *   | kind | 谁产生 | 音质 | 目录 | LRU | 出现在「本地下载」 |
 *   |---|---|---|---|---|---|
 *   | `cache`    | 播放时自动（play 通道） | **播放音质** | `$dataDir/cache` | 受「缓存上限」滚动 | **否** |
 *   | `download` | 用户主动（batch 通道）  | **下载音质** | `$dataDir/music` | 永久 | **是** |
 *   - 队列项的 `kind` 决定落到哪个目录、用哪张元数据表、完成后如何收尾
 *     （download 完成 → 删掉同 id 的 cache 副本，避免同一首占两份空间）；
 *   - 播放请求（ensureCached）也可以**提权**批量项：提权只改调度通道（lane），
 *     **不改编排队列项的 kind** —— 用户点下的下载不会因为被提权就变成缓存；
 *   - 缓存完成 → 触发 cache.enforceCacheLimit()（按播放顺序 LRU 滚动）。
 *
 * 对外接口：
 *   - resolveUrl(id)      直链解析（**按设置音质档位**逐级回退，走 v1 接口的 level 参数，见 quality.js）
 *   - cachedPath(id)      任意本地命中（下载优先，其次播放缓存；.flac/.mp3 都探，存在且 >30KB）
 *   - dlPath(id)          只探「下载目录」（「已下载」判定 / 升质比较用）
 *   - ensureCached(song)  播放通道：确保本地有完整文件（没有就缓存到 cache/）；单并发、最新请求优先
 *   - downloadSongs(ss)   用户通道：批量下载 → {total, ok, failed, skipped, cancelled, error}
 *   - estimateBytes(ss)   粗估一批歌按当前下载档的体积（列表页空间预检用）
 *   - deleteCached(id)    删单条**下载**（文件 + 元数据）
 *   - cancelDownload()    取消批量下载（当前片下完即停，.part 保留可续传）
 */
import { fetchToFile, promotePart, transportMode } from './fetcher.js'
import {
  musicDir, playCacheDir,
  putMeta, metaOf, loadMeta, dropMeta, markPending,
  putPlayMeta, playMetaOf, loadPlayMeta, dropPlayMeta, markPlayPending,
  touchPlayMeta, enforceCacheLimit
} from './cache.js'
import { currentQuality, qualityRank, nominalBr } from './quality.js'
import { saveSongExtras, dropLocalSong } from './localmeta.js'
import { markUser, markPlaylist, markSkippedExisting, clearOrigin } from './dlorigin.js'
import { log } from '../log.js'
import { raceTimeout } from '../util.js'
import { ensureDir, fileSize, rmQuiet } from '../fsutil.js'
import { resolveUrl } from './source.js'
import { altPath, dirOf, purgeInDir, songPath, cachedPath, dlPath, playCachePath } from './files.js'
import { addProgressHook } from './progress.js'
import * as sched from './scheduler.js'
import * as tasks from './tasks.js'

/* ================= 对外 re-export（API 面与拆分前一致） ================= */

// 直链解析 / 本地探测（实现分别在 source.js / files.js）
export { resolveUrl, cachedPath, dlPath, playCachePath }

// 下载调度器（实现见 scheduler.js）
export { cancelDownload } from './scheduler.js'

/* ---- 下载调度器的注入与门面接线 ----
 * scheduler 需要「真正的下载动作」与「文件变更通知」；两边的相互引用都收敛在这里，
 * 调度器与任务模块之间零循环依赖。 */
sched.wireScheduler({
  downloadOne: downloadOne,
  notifyFileChanged: notifyFileChanged
})

// 活动快照 / 任务清单 / 订阅（实现见 tasks.js）
export { dlState, onDl, offDl, dlTasks, ackFinished, cancelTask } from './tasks.js'

/* ---------------- 本地文件变更通知（player.js 用） ----------------
 * 删缓存 / 升质重下都会让 player 手里的 localPath 失效（文件没了或换成了新内容）；
 * player.js 注册钩子清掉对应曲目的 localPath（见其底部）。**在 promise resolve 之前调**，
 * 保证随后各调用方写 localPath 的顺序仍然正确。 */

const fileChangedHooks = []

/** 注册钩子：fn(songIdString)。**数组追加**（架构优化）——
 *  旧实现是单槽覆盖，第二个注册者会无声顶掉第一个；现在多注册者共存。
 *  同一函数重复注册会被忽略并记日志（防同一模块挂两遍时回调翻倍）。 */
export function setFileChangedHook(fn) {
  if (typeof fn !== 'function') return
  for (let i = 0; i < fileChangedHooks.length; i++) {
    if (fileChangedHooks[i] === fn) {
      log('dl', 'setFileChangedHook 重复注册（同名函数），已忽略')
      return
    }
  }
  fileChangedHooks.push(fn)
}

function notifyFileChanged(id) {
  if (!fileChangedHooks.length) return
  for (let i = 0; i < fileChangedHooks.length; i++) {
    try {
      fileChangedHooks[i](String(id))
    } catch (e) {}
  }
}

/* ================= 用户下载通道（batch） ================= */

/**
 * 已有缓存是否达到当前下载档（true = 跳过不重下）。
 *  - 无元数据 → 视为达标：老缓存/元数据没写上的不误重下（宁可保持现状）。
 *    ⚠ 取舍：降级拿到的低码率（请求无损实际只给 320k）与「q 记的是请求档」叠加后，
 *    这类文件也被永久视为达标 —— 想升质的唯一途径是先删（下载页多选删）再下。
 *    **Hi-Res 档尤其依赖这个取舍**：账号没有该档权益时，请求 hires 会静默退到
 *    exhigh（回包 level='exhigh'），文件仍按 q='hires' 记 → 之后不再重试；
 *    哪天开了权益想真升质，同样得先删再下。
 *  - 有 q（下载档 key）→ 比档位名次（≥ 即达标）
 *  - 无 q（本功能之前的老数据）→ 按「容器 + 实际码率」反推已达档位。
 *    **别拿 meta.b 与 nominalBr 比**：真机实测无损实际 br=947180，比名义 999000 小，
 *    会比出「未达标」而把每首老无损缓存白重下一次（设计校验抓的）。
 */
function metaSatisfies(meta, key) {
  if (!meta) return true
  if (meta.q) return qualityRank(meta.q) >= qualityRank(key)
  const target = qualityRank(key)
  if (meta.y === 'flac') return target <= qualityRank('lossless') // 老数据只有 16bit flac：够无损，不够 Hi-Res
  const b = meta.b || 0
  if (!b) return true
  if (b >= 320000) return target <= qualityRank('exhigh')
  if (b >= 192000) return target <= qualityRank('higher')
  return target <= qualityRank('standard')
}

/**
 * 某首歌是否已**下载**（播放器页「下载」键显示完成图标用）：下载目录有文件 + 档位达标。
 * ⚠ 只有播放缓存（cache/）不算已下载 —— 那是「听过」，不是「下过」。
 */
export async function isDownloaded(songId) {
  await loadMeta()
  const hit = await dlPath(songId)
  if (!hit) return false
  return metaSatisfies(metaOf(songId), currentQuality('down'))
}

/**
 * 用户下载（播放器页「下载」键 / 列表多选下载 / 本地歌单「下载全部」/ 同步）：
 *   - 已达标缓存 → 跳过（skipped）
 *   - 缓存档位低于当前「下载档」→ 重下替换（升质；先下 .part 再 mv 顶替，失败不破坏旧文件）
 *   - 其余入 batch 队列（FIFO、不淘汰；单并发，播放通道优先）
 * 逐首 resolve 后汇总。返回 {total, ok, failed, skipped, cancelled, error, results}
 *   - results：[{id, status:'ok'|'skipped'|'failed'|'cancelled', existed}]，
 *     给调用方（本地歌单）判断哪些成功、哪些本来就存在
 *   - error：第一条失败原因（toast 用；VIP 受限、网络中断等）
 *   - 连接错误不传播异常：永远 resolve（页面 toast 才有落点）
 *
 * opts.origin：
 *   - 'manual'  （默认）用户自己的单曲：完成后写 user 归属
 *   - 'playlist' 本地索引歌单的「下载全部」/ 同步：完成后写 playlist 归属；
 *                跳过已存在文件时只给**没有标记**的补 user（遗留文件按用户资产处理，
 *                见 dlorigin.js）。归属只影响本地下载页的分类，不改变文件行为。
 */
export async function downloadSongs(songs, opts) {
  const mode = (opts && opts.origin === 'playlist') ? 'playlist' : 'manual'
  const list = []
  const src = songs || []
  for (let i = 0; i < src.length; i++) {
    if (src[i] && src[i].id) list.push(src[i])
  }
  const res = { total: list.length, ok: 0, failed: 0, skipped: 0, cancelled: 0, error: '', results: [] }
  if (!list.length) return res
  await loadMeta()
  const qk = currentQuality('down')
  const jobs = []
  for (let i = 0; i < list.length; i++) {
    const song = list[i]
    // ⚠ 只看**下载目录**：只有播放缓存（cache/）不算已下载，照样要走一趟正式下载
    // （下载档通常更高，且下载完成后会清掉 cache 里的副本，不留两份）
    const hit = await dlPath(song.id)
    if (hit && metaSatisfies(metaOf(song.id), qk)) {
      res.skipped++
      res.results.push({ id: song.id, status: 'skipped', existed: true })
      continue
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
  // 归属标记：ok → 按来源写；skipped → 歌单来源只给无标记的补 user（见 dlorigin.js）
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

/**
 * 粗估一批歌按「下载档」的总体积（字节；列表页/专辑页的空间预检用）：
 * Σ 档位名义码率/8 × 时长（时长缺失按 4 分钟估）。
 * ⚠ 纯估算：无损档名义 999k、Hi-Res 名义 2400k，都高于真实码率 → 偏大，宁可多提醒一次。
 */
export function estimateBytes(songs, qualityKey) {
  const br = nominalBr(qualityKey || currentQuality('down'))
  let ms = 0
  const list = songs || []
  for (let i = 0; i < list.length; i++) ms += (list[i] && list[i].durationMs) || 240000
  return Math.round((br / 8) * (ms / 1000))
}

/* ================= 落盘（downloadOne：两条通道共用的真正下载动作） ================= */

/**
 * 下载一首到目标目录并校验（分片 + 低速换节点 + 断线续传，见 fetcher.js）。
 * 校验：文件 ≥30KB，且不小于接口报告尺寸的 90%。
 * 不完整时：curl 通道保留 .part 供下次续传；回退通道删掉半截避免被当成缓存。
 * @param {string} qk   解析直链用的档位 key（也写进元数据的 q：升级判定的依据）
 * @param {string} kind 'cache'（边听边存 → cache/ + 播放缓存元数据表）|
 *                      'download'（用户下载 → music/ + 下载元数据表）；缺省按 cache
 * 收尾差异：download 完成 → 清掉同 id 的**缓存副本**（同一首不留两份）；
 *          cache 完成 → 触发「缓存上限」LRU 滚动。
 * 返回 {ok, path, size, replaced?, aborted?, error}
 */
async function downloadOne(song, info, opts, qk, kind) {
  const id = String(song.id)
  const kd = kind === 'download' ? 'download' : 'cache'
  const store = kd === 'download'
    ? { put: putMeta, of: metaOf, mark: markPending }
    : { put: putPlayMeta, of: playMetaOf, mark: markPlayPending }
  const t0 = Date.now()
  const since = function () {
    return Date.now() - t0
  }
  // 阶段日志（排查用，一次下载 4~5 行）：挂死时「最后一条」就是卡住的那一步
  log('dl', '取源 ' + id + ' ' + (song.name || '') + '[' + kd + ']' +
    (info && info.url ? '（复用播放直链）' : '（按' + qk + '解析）'))
  try {
    await ensureDir(dirOf(kd))
  } catch (e) {}

  let meta = info
  if (!meta || !meta.url) meta = await raceTimeout(resolveUrl(id, qk), 25000, null)
  if (!meta || !meta.url) {
    log('dl', '无直链 ' + id + '（或解析超时，' + since() + 'ms）')
    return { ok: false, path: '', error: '歌曲受限，暂无直链' }
  }
  log('dl', '直链就绪 ' + id + ' ' + (meta.type || 'mp3') + '/' + (meta.br || 0) +
    (meta.level ? ' lvl=' + meta.level : '') + '（' + since() + 'ms）')

  const finalPath = songPath(id, meta.type, kd)
  const hadOld = (await fileSize(finalPath)) > 0 // 升质重下：旧文件还在，下满 mv 才顶替
  const mode = await raceTimeout(transportMode(), 15000, 'builtin')
  const partPath = finalPath + '.part'
  // 续传残片只认同档位：用户中途改过音质的话，旧档的 .part 接上新档字节会写出
  // 「长度对、内容是垃圾」的文件（校验只查长度，拦不住）→ 档位对不上就丢弃重下。
  // 残片标记按目录分表：cache 用播放档、download 用下载档，互不干扰。
  const pv = (store.of(id) && store.of(id).p) || ''
  if ((await fileSize(partPath)) > 0 && pv !== qk) {
    log('dl', '丢弃跨档位的续传残片 ' + id + '[' + kd + ']（残片档=' + (pv || '未知') + ' 本次=' + qk + '）')
    await rmQuiet(partPath)
    await rmQuiet(partPath + '.cur')
  }
  if (mode === 'curl') {
    // 记下本次档位：中断后重来时靠它认残片（下载成功 put 会把 p 清掉）
    try {
      await raceTimeout(store.mark(id, qk), 8000, null)
    } catch (e) {}
  }
  const target = mode === 'curl' ? partPath : finalPath
  log('dl', '拉取开始 ' + id + ' mode=' + mode + '（' + since() + 'ms）')

  const r = await raceTimeout(
    fetchToFile({
      url: meta.url,
      outPath: target,
      total: meta.size || 0,
      onProgress: opts && opts.onProgress,
      shouldAbort: opts && opts.shouldAbort,
      // 低速 / 断线时重新取直链（换 CDN 节点）。
      // 格式漂移防护：降级链可能让新直链换了容器（flac→mp3），
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
  if (!r.ok || !size || size < 30000 || (want > 0 && size < want * 0.9)) {
    if (mode !== 'curl') await rmQuiet(finalPath) // 回退通道不留半截
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
  // ⚠ 反向也成立：请求无损/Hi-Res 但服务端降级成 mp3 时，旧的 .flac 会被这里删掉 ——
  // 即「降质替换」。判定层面已有取舍兜底（见 metaSatisfies 注释），这里不再额外防护。
  const alt = altPath(id, meta.type, kd)
  const altHad = (await fileSize(alt)) > 0
  await rmQuiet(alt)
  // 元数据（歌名/歌手/实际码率/档位/时长/封面）：显示与升级判定用；写进对应的表
  // （缓存表多带 u = lastUsed，LRU 排序键）。写失败不影响缓存本身（文件系统才是真相）
  try {
    await raceTimeout(store.put(song, meta.br, meta.type === 'flac' ? 'flac' : 'mp3', qk), 8000, null)
  } catch (e) {}

  if (kd === 'download') {
    // 用户已正式下载这首 → 清掉 cache/ 里的副本（同一首占两份空间没意义；
    // 缓存那份只是「听过的痕迹」，使命到此结束）。顺手清残留的 .part。
    const purged = await sched.purgePlayCache(id)
    if (purged.files > 0) {
      await dropPlayMeta(id)
      notifyFileChanged(id) // player 的 localPath 可能正指着刚被删的缓存文件
      log('dl', '下载完成，清掉播放缓存副本 ' + id + '：' + purged.files + ' 个 / ' +
        Math.round(purged.bytes / 1024) + 'KB')
    }
    // 元数据（歌手/专辑 id 等）+ 歌词落本地库（离线详情页/歌词用，见 localmeta.js）。
    // 两个 API 请求串行跟在下载后面，正常 <1s；护栏 30s，失败不影响下载结果
    // （老数据/失败项由 downloads 页 enrich 在线时补齐）。
    try {
      await raceTimeout(saveSongExtras(id), 30000, null)
    } catch (e) {}
  } else {
    // 边听边存：趁刚写入判断一次「缓存上限」，超了就从最久没播的开始滚掉
    enforceCacheLimit().catch(function () {})
  }
  return { ok: true, path: finalPath, size: size, replaced: hadOld || altHad }
}

/* ================= 播放通道：ensureCached ================= */

/**
 * 确保某首歌有完整本地文件（播放用）。返回 Promise<{ok, path, size, error}>
 *   - 磁盘已有 / 本会话已下过 → 立即返回
 *   - 正在下载（任意通道）→ 复用同一个 Promise
 *   - 否则排队（播放通道、最新优先）
 * 注意：**不重下低档缓存**（升质是用户下载通道的事）——播放要的只是「能播」。
 * opts.onProgress(done,total,speed) 只在真正下载时回调（供 UI 显示进度）。
 * 失败不缓存结果，下次调用会重试（半截 .part 会续传）。
 *
 * ⚠ 超时语义：下面的 9 分钟兜底超时**只放弃等待，
 * 不取消底层任务** —— 底层下载会继续跑完并写缓存（缓存幂等，不会产生坏数据；
 * 见 util.js raceTimeout 的语义说明）。超时发生时会打一条带 id 的日志，
 * 便于日后真机上出现「超时后行为怪」时定位。
 */
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
      // （超时只放弃等待、底层继续跑 —— 见本函数头的语义说明）
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

/* ================= 删除与失效 ================= */

/**
 * 删单条**下载**（本地下载页的多选删除，逐首调用）：文件（含 .part/.part.cur 续传残留）+ 元数据。
 * **只动 music/ 目录** —— 播放缓存不在这里出现，也不该被这个入口删掉
 * （缓存由「缓存上限」LRU 与存储管理页统一回收）。
 * 返回 {ok, files, bytes}（bytes = 实际删掉的字节，UI 提示「释放 X」用）。
 * 边下边删的竞态不做处理（同一首正在下载时删，文件会在下载完成后重新出现）。
 */
export async function deleteCached(songId) {
  const id = String(songId)
  const r = await purgeInDir(musicDir(), id)
  await dropMeta(id)
  try {
    await clearOrigin(id) // 文件没了，归属标记一起清（dlorigin.js）
  } catch (e) {}
  try {
    await dropLocalSong(id) // 本地库的索引 + 歌词随文件一起走（localmeta.js）
  } catch (e) {}
  sched.delDone(id)
  sched.clearWait(id, sched.getWait(id))
  notifyFileChanged(id)
  log('dl', '删除下载 ' + id + '：文件 ' + r.files + ' 个 / ' + Math.round(r.bytes / 1024) + 'KB')
  return { ok: r.files > 0, files: r.files, bytes: r.bytes }
}

/**
 * 整库失效（存储管理页「清空音乐缓存」用）：先取消批量下载（正在下的往已删目录里写
 * 会把 .part 写坏 / 提升失败），再作废 doneCache、通知 player 清 localPath。
 * **不删文件** —— 文件删除仍由 cache.clearSongs() 做（那边只管目录），两边合起来才干净。
 */
export function forgetAll() {
  sched.cancelDownload()
  invalidateLocalPaths()
}

/**
 * 只作废「本会话已确认的本地路径」与播放器手上的 localPath —— **不动下载队列**。
 * 用于清空**自动缓存**目录：正在播的那首文件被删后 fd 仍在（声音不断），
 * 但 localPath 已经指向不存在的文件，seek/续播会失败一次 → 先清掉让它们重新探测。
 * （清**下载**目录仍用 forgetAll：那边文件被删，正在跑的下载必须一起取消。）
 */
export function invalidateLocalPaths() {
  const n = sched.clearPathTables()
  if (fileChangedHooks.length) {
    try {
      notifyFileChanged('') // 空 id = 全部失效（player 的钩子按此清 localPath）
    } catch (e) {}
  }
  log('dl', '本地路径失效：doneCache ' + n + ' 条已作废')
}

/* ================= 播放缓存「最近使用」打点（player.js 用） ================= */

/**
 * 记一次「这首歌被播放了」（player.js 在真正出声的分支调）——「缓存上限」LRU 的排序键，
 * 满了先淘汰最久没播的。只更新**已存在**的缓存条目（还没缓存完的等写入时给初值），
 * 写盘 400ms 合并（连点切歌不反复整份写 storage）。
 * 下载目录（music/）的歌曲不进这张表，所以**手动下载的不受缓存滚动影响**。
 */
export const touchPlayCache = touchPlayMeta
