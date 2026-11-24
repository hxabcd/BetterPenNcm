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
 * **「缓存」与「下载」分家**（两条通道，同一套「每 track 一个目录」布局，见 docs/存储重构.md §2）：
 *   | kind | 谁产生 | 音质 | 目录 | LRU | 出现在「本地下载」 |
 *   |---|---|---|---|---|---|
 *   | `cache`    | 播放时自动（play 通道） | **播放音质** | `data/cache/<id>/` | 受「缓存上限」滚动 | **否** |
 *   | `download` | 用户主动（batch 通道）  | **下载音质** | `data/downloads/<id>/` | 永久 | **是** |
 *   - 每个曲目目录里固定是 `track.<ext>`（+ `.part` 残片）/ `cover.jpg`；
 *     元数据与歌词在状态库的 `track_meta` / `track_lyric`（utils/media.js 统一读写）；
 *   - 队列项的 `kind` 决定落到哪个目录、完成时写哪条 `track_meta`（kind 1=下载 / 2=缓存）、
 *     如何收尾（download 完成 → 删掉同 id 的 cache **目录**，避免同一首占两份空间）；
 *   - 播放请求（ensureCached）也可以**提权**批量项：提权只改调度通道（lane），
 *     **不改编排队列项的 kind** —— 用户点下的下载不会因为被提权就变成缓存；
 *   - 缓存完成 → 触发 cache.enforceCacheLimit()（按播放顺序 LRU 滚动）。
 *
 * **下载提交协议（2026-11 稳定性改动，改这块前先看）**：
 *   - 开始下载前 `begin` 先写基础元数据（n/a/d/c + `p` 本次档位 + `z` 预期大小 +
 *     `f` 下载前是否有旧文件），完成后再 `put` 写实际 b/y/q 并清 p/z；
 *     写库失败重试一次，仍失败只记日志（文件是真相，启动对账会再补），不判下载失败；
 *   - 判重必须 `metaReady`（有歌名、无 p、有 q/y/b 之一）。缺元数据的旧行先就地补，
 *     **不重新拉音频**；只有「只有 p、没有档位/码率」这种证据不足的行才重下一次；
 *   - 退出：`stopForExit` 取消队列 + pkill 活跃 curl，`.part` 与 `dl_pending` 保留；
 *     下次启动 `reconcileDownloads` 把已下满的残片转正、补元数据，再续传 `dl_pending`。
 *
 * 对外接口：
 *   - resolveUrl(id)      直链解析（**按设置音质档位**逐级回退，走 v1 接口的 level 参数，见 quality.js）
 *   - cachedPath(id)      任意本地命中（下载优先，其次播放缓存；.flac/.mp3 都探，存在且 >30KB）
 *   - dlPath(id)          只探「下载目录」（「已下载」判定 / 升质比较用）
 *   - ensureCached(song)  播放通道：确保本地有完整文件（没有就缓存到 cache/）；单并发、最新请求优先
 *   - downloadSongs(ss)   用户通道：批量下载 → {total, ok, failed, skipped, cancelled, error}
 *   - estimateBytes(ss)   粗估一批歌按当前下载档的体积（列表页空间预检用）
 *   - deleteCached(id)    删单条**下载**（整个 `downloads/<id>/` 目录 + 归属/本地库挂点）
 *   - cancelDownload()    取消批量下载（当前片下完即停，.part 保留可续传）
 */
import { fetchToFile, promotePart, transportMode, stopFetching, resetFetching, killPartFetch } from './fetcher.js'
import {
  musicDir,
  putMeta, warmMeta, dropMeta, beginMeta,
  putPlayMeta, warmPlayMeta, dropPlayMeta, beginPlayMeta,
  touchPlayMeta, enforceCacheLimit
} from './cache.js'
import { currentQuality, qualityInfo, qualityRank, nominalBr } from './quality.js'
import { saveSongExtras, dropLocalSong, loadIndex, indexOf } from './localmeta.js'
import { markUser, markPlaylist, markSkippedExisting, clearOrigin } from './dlorigin.js'
import { log } from '../../core/infra/log.js'
import { raceTimeout, sleep } from '../../core/infra/util.js'
import { fileSize, fileExists, readNames, readText, rmQuiet } from '../../core/platform/fsutil.js'
import { trackDir } from '../../core/infra/paths.js'
import { getStorage, setStorage, removeStorage, KEY_DL_PENDING } from '../../core/infra/store.js'
import { isOffline } from '../../core/infra/net/status.js'
import { listTracks } from './media.js'
import { resolveUrl } from './source.js'
import {
  altPath, purgeInDir, songPath, prepareTrackDir, cachedPath, dlPath, playCachePath
} from './files.js'
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

/** UI 层注入用的门面（ui/mixins/dlsub.js 不直接 import services，见分层 R6）。
 *  页面：`bindDl(this, dlApi, fn)`。 */
export const dlApi = {
  onDl: tasks.onDl,
  offDl: tasks.offDl,
  dlState: tasks.dlState
}

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
  const hit = await dlPath(songId)
  if (!hit) return false
  return metaSatisfies(await warmMeta(songId), currentQuality('down'))
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
  activeBatches++
  const batch = []
  const src = songs || []
  for (let i = 0; i < src.length; i++) {
    if (src[i] && src[i].id) batch.push(src[i])
  }
  try {
    return await downloadSongsInner(songs, opts)
  } finally {
    activeBatches--
    // 正常结束 / 用户取消：只把自己这批从待续传快照里摘掉；退出（exiting）时全保留
    if (!exiting) await pendingDrop(batch)
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
      // 补写会清掉 p，downloadOne 就认不出上次留下的同档位 .part，续传进度白丢。
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

/* ================= 元数据就绪 / 就地修复 / 完整残片转正 ================= */

/**
 * 元数据是否「完整可用」：有歌名、没有下载中标记 `p`、且有档位/容器/码率之一。
 * **跳过判定必须用它**：只看文件在不在（老逻辑）会把「有歌没名字」的行永远当成已完成，
 * 既不重下也不修，只能靠下载总览页的 enrich 碰运气。
 */
function metaReady(m) {
  return !!(m && m.n && !m.p && (m.q || m.y || m.b))
}

/**
 * 这条元数据是否「证据不足，必须重新下一次」：
 * `p` 还在（上次没走完）+ 没有 q（档位）也没有 b（码率）→ 光看 y（容器）判不出
 * 这份文件到底是不是本次要的档位。`f === 1` 表示下载开始时盘上没有旧文件，
 * 那这份音频就是本次下的，p 可以当实际档位；f 为 0/缺省（升级、或旧版本留下的行）
 * 则不能拿 p 冒充，先重下一次，成功后 q 就齐了（只影响这类历史残留，不会常态重下）。
 */
function metaNeedsRetry(m) {
  if (!(m && m.p)) return false
  if (m.q || m.b) return false
  return m.f !== 1
}

/** 两条通道的元数据入口（写 / 读 / 下载开始标记） */
function storeOf(kd) {
  return kd === 'download'
    ? { put: putMeta, of: warmMeta, begin: beginMeta }
    : { put: putPlayMeta, of: warmPlayMeta, begin: beginPlayMeta }
}

/**
 * 就地补元数据（**不重新拉音频**）：文件已经在盘上，只是 track_meta 缺字段/还带着 `p`。
 *
 * q 的取法：
 *   - 已有 q / b（老条目，或升级失败留下的旧档）→ 以盘上这份文件为准，
 *     **绝不能用 `p`**：p 记的是这次想升到的档，不是文件实际的档；
 *   - 什么都没有，且 begin 记了 `f=1`（下载前没有旧文件）→ 用 `p` 回填档位；
 *   - 其余（只有 y、f=0/缺省）→ q 留空，由 metaNeedsRetry 决定是否重下。
 * 成功返回修复后的记录；失败返回 null（启动对账/下次下载再试）。
 */
async function repairMeta(song, hitPath, meta, kind) {
  const kd = kind === 'cache' ? 'cache' : 'download'
  if (metaReady(meta)) return meta
  if (!song || !song.id) return null
  const store = storeOf(kd)
  const ext = /\.flac$/i.test(String(hitPath || '')) ? 'flac' : 'mp3'
  const q = (meta && (meta.q || (meta.f === 1 ? (meta.p || '') : ''))) || ''
  for (let i = 0; i < 2; i++) {
    try {
      const r = await store.put(song, 0, ext, q)
      if (r && r.ok) {
        log('dl', '就地补元数据 ' + song.id + '[' + kd + '] 档=' + (q || '未知') + ' 容器=' + ext)
        return r.rec
      }
    } catch (e) {}
  }
  log('dl', '元数据修复失败 ' + song.id + '[' + kd + ']')
  return null
}

/**
 * 上一次下载其实已经把 `.part` 写满，只是没来得及 mv/promote 就退出/被系统掐掉。
 * 认「下满」的两条证据：curl 自己写的 `.rc=0`，或 begin 记下的预期大小 `z`（≥99%）。
 * 只有 `p === qk`（同一档位）才认；跨档残片仍由 downloadOne 丢弃。
 * 成功返回 {ok, path, size, fromPart, metaOk}；没残片/没下满返回 null。
 */
async function finishCompletePart(song, kd, qk, prev) {
  if (!song || !song.id || !prev || prev.p !== qk) return null
  const z = prev.z || 0
  for (let i = 0; i < 2; i++) {
    const ext = i === 0 ? 'mp3' : 'flac'
    const part = songPath(song.id, ext, kd) + '.part'
    const size = await fileSize(part)
    if (!(size > 30000)) continue
    const rc = String(await readText(part + '.rc')).trim()
    if (!(rc === '0' || (z > 0 && size >= z * 0.99))) continue
    const finalPath = songPath(song.id, ext, kd)
    const had = (await fileSize(finalPath)) > 0
    const alt = altPath(song.id, ext, kd)
    const altHad = (await fileSize(alt)) > 0
    // 先杀掉可能还在写这个 .part 的旧 curl：否则 mv 之后它仍会往同一个 inode 追加，
    // 正式文件会在「校验通过」之后被写坏。
    await killPartFetch(part)
    const moved = await promotePart(part, finalPath)
    if (!moved) continue
    await rmQuiet(part + '.rc')
    await rmQuiet(part + '.cur')
    await rmQuiet(alt)
    const store = storeOf(kd)
    let rec = null
    for (let k = 0; k < 2; k++) {
      try {
        // 码率未知：清掉旧文件的 b（旧文件的码率可能属于旧档位，别张冠李戴）
        const r = await store.put(song, 0, ext, qk, { clearBr: true })
        if (r && r.ok) {
          rec = r.rec
          break
        }
      } catch (e) {}
    }
    log('dl', '完整残片直接转正 ' + song.id + '[' + kd + '] ' +
      Math.round(size / 1024) + 'KB 档=' + qk)
    return {
      ok: true,
      path: finalPath,
      size: size,
      ext: ext,
      fromPart: true,
      metaOk: !!rec,
      replaced: had || altHad
    }
  }
  return null
}

/* ================= 批量队列持久化（退出/被强杀后下次接续） ================= */

const PENDING_MAX = 1000
let pendingMap = null
let activeBatches = 0
let exiting = false

function slimSong(s) {
  return {
    id: s.id,
    name: s.name || '',
    artist: s.artist || '',
    durationMs: s.durationMs || 0,
    cover: s.cover || ''
  }
}

async function pendingLoad() {
  if (pendingMap) return pendingMap
  pendingMap = {}
  try {
    const raw = await getStorage(KEY_DL_PENDING)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i]
          if (it && it.id) pendingMap[String(it.id)] = it
        }
      }
    }
  } catch (e) {}
  return pendingMap
}

/** 把本次入队的歌并进 `dl_pending`（同 id 覆盖；只留最近 1000 首） */
async function pendingAdd(list, qk, mode) {
  if (!list || !list.length) return
  const map = await pendingLoad()
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    if (!s || !s.id) continue
    map[String(s.id)] = Object.assign(slimSong(s), { q: qk || '', origin: mode, at: Date.now() })
  }
  const arr = Object.keys(map).map(function (k) { return map[k] })
  if (arr.length > PENDING_MAX) {
    arr.sort(function (a, b) { return (b.at || 0) - (a.at || 0) })
    arr.length = PENDING_MAX
  }
  try {
    await setStorage(KEY_DL_PENDING, JSON.stringify(arr))
  } catch (e) {}
}

/** 队列正常结束/用户取消时清空；退出时保留（下次启动续传） */
async function pendingClear() {
  pendingMap = null
  try {
    await removeStorage(KEY_DL_PENDING)
  } catch (e) {}
}

/**
 * 一批正常结束/被用户取消：只摘掉**这一批**的 id，不碰别的批次留下的待续传项
 * （例如上次被强杀的旧队列还没开始续传时，用户又手动下了一首）。
 */
async function pendingDrop(list) {
  if (!list || !list.length) return
  const map = await pendingLoad()
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id) delete map[String(list[i].id)]
  }
  // 还有别的批次在跑：把它们留在 map 里（下一次 pendingAdd 会合并写）
  if (activeBatches > 0) return
  const arr = Object.keys(map).map(function (k) { return map[k] })
  if (!arr.length) {
    await pendingClear()
    return
  }
  try {
    await setStorage(KEY_DL_PENDING, JSON.stringify(arr))
  } catch (e) {}
}

/**
 * 启动后续传上次没下完的队列（boot 在登录态就绪后调用，不 await）：
 * 已下完的会按 metaReady+metaSatisfies 自动跳过；离线则原样留着，下次启动再试。
 */
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
  await sleep(2000) // 让首页/播放恢复先起来，别抢启动带宽
  if (exiting) return { resumed: 0 }
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

/* ================= 退出收尾 ================= */

/**
 * 退出前收尾（index.vue 的退出链调用）：
 *   1) 取消批量队列（未开始的结算为 cancelled）
 *   2) 清播放通道排队项，别在退出过程中再起新的缓存下载
 *   3) 杀掉正在写的 curl（fetcher 按 `.part` 路径 pkill）
 *   4) 最多等 800ms 让当前项落地（`.part` 保留，下次续传）
 * **不清 dl_pending** —— 下次启动据此续传。
 */
export async function stopForExit() {
  if (exiting) return
  exiting = true
  try { sched.cancelDownload() } catch (e) {}
  try { sched.abortPlayQueue() } catch (e) {}
  try { await stopFetching() } catch (e) {}
  let idle = false
  try { idle = await sched.waitIdle(800) } catch (e) {}
  // 收尾后仍有未完成的：任务已按 cancelled 结算，.part 与 dl_pending 留给下次
  log('dl', '退出前停止下载（' + (idle ? '已收尾' : '超时，残片保留') + '）')
}

/** closeApp 失败（应用还活着）时复位退出标志，别让本次进程内的下载永久不可用 */
export function resetExit() {
  exiting = false
  try {
    resetFetching()
  } catch (e) {}
}

/* ================= 启动对账（不联网） ================= */

/** 索引里的离线曲目 → repairMeta 可用的 song 形状 */
function songFromIndex(id) {
  const rec = indexOf(String(id))
  if (!rec) return { id: id }
  const names = []
  const ars = rec.ars || []
  for (let i = 0; i < ars.length; i++) {
    if (ars[i] && ars[i].n) names.push(ars[i].n)
  }
  return {
    id: id,
    name: rec.n || '',
    artist: names.join(' / '),
    album: (rec.al && rec.al.n) || '',
    cover: (rec.al && rec.al.c) || '',
    durationMs: rec.d || 0
  }
}

/**
 * 启动对账（boot 里 await；只做原生 fs + SQLite，不联网）：
 *   - 有正式音频但元数据不全 **且没有下载中标记** → 就地补成完成态；
 *   - 有正式音频但还带着 `p` → 只补歌名/歌手等显示字段，**保留 p**：
 *     这份音频可能是升级前的旧文件，下次下载要靠 p 决定「续传还是重下」；
 *   - 只有残片且已下满（rc=0 或 z 达标）→ 直接转正 + 写完成态；
 *   - 没有对应 `.part` 的 `.rc`/`.cur` → 清掉（上一次中断的临时文件）。
 * 返回 {scanned, repaired, promoted, cleaned} 供日志。
 */
export async function reconcileDownloads() {
  const out = { scanned: 0, repaired: 0, promoted: 0, cleaned: 0 }
  try {
    await loadIndex() // 离线补歌名用（歌手/专辑索引已在 boot 打开后载入内存）
  } catch (e) {}
  let tracks = []
  try {
    tracks = await listTracks('download')
  } catch (e) {
    return out
  }
  for (let i = 0; i < tracks.length; i++) {
    const it = tracks[i]
    const id = String(it.id)
    out.scanned++
    const meta = it.meta || null
    if (it.size > 0) {
      if (!metaReady(meta)) {
        const song = songFromIndex(id)
        if (song.name) {
          if (meta && meta.p && metaNeedsRetry(meta)) {
            // 下载未收尾且证据不足：只补显示字段，保留 p/z/f（下次下载据此续传或重下）
            await storeOf('download').begin(song, meta.p, meta.z || 0, meta.f !== 1)
          } else {
            const rec = await repairMeta(song, it.path, meta, 'download')
            if (rec && metaReady(rec)) out.repaired++
          }
        }
      }
    } else if (meta && meta.p) {
      const fin = await finishCompletePart(songFromIndex(id), 'download', meta.p, meta)
      if (fin) {
        out.promoted++
        try {
          await purgeCacheCopy(id) // 转正后同 id 的缓存副本没必要留着
        } catch (e) {}
      }
    }
    // 清掉没有 .part 的 .rc/.cur（`.part` 还在时留给续传/转正）
    try {
      const dir = trackDir(id, 'download')
      const names = await readNames(dir)
      let hasPart = false
      for (let j = 0; j < names.length; j++) {
        if (names[j].slice(-5) === '.part') {
          hasPart = true
          break
        }
      }
      if (!hasPart) {
        for (let j = 0; j < names.length; j++) {
          const n = names[j]
          if (n.slice(-3) === '.rc' || n.slice(-4) === '.cur') {
            await rmQuiet(dir + '/' + n)
            out.cleaned++
          }
        }
      }
    } catch (e) {}
  }
  if (out.repaired || out.promoted || out.cleaned) {
    log('dl', '启动对账：扫描 ' + out.scanned + ' 首，补元数据 ' + out.repaired +
      '，转正残片 ' + out.promoted + '，清临时文件 ' + out.cleaned)
  }
  return out
}

/* ================= 落盘（downloadOne：两条通道共用的真正下载动作） ================= */

/**
 * 下载一首到目标目录并校验（分片 + 低速换节点 + 断线续传，见 fetcher.js）。
 * 校验：文件 ≥30KB，且不小于接口报告尺寸的 90%。
 * 不完整时：curl 通道保留 .part 供下次续传；回退通道删掉半截避免被当成缓存。
 * @param {string} qk   解析直链用的档位 key（也写进元数据的 q：升级判定的依据）
 * @param {string} kind 'cache'（边听边存 → cache/<id>/）|
 *                      'download'（用户下载 → downloads/<id>/）；缺省按 cache
 * 收尾差异：download 完成 → 清掉同 id 的**缓存目录**（同一首不留两份）；
 *          cache 完成 → 触发「缓存上限」LRU 滚动。
 * 返回 {ok, path, size, replaced?, aborted?, error, metaOk?}；另有
 *   fromDisk / fromPart / repaired 等诊断字段（本地命中 / 残片转正 / 补元数据），
 *   调度器只认 ok/path/replaced，其余供日志与测试。
 */
/** 用户正式下载完成后，删掉同 id 的播放缓存副本（同一首不留两份） */
async function purgeCacheCopy(id) {
  const purged = await sched.purgePlayCache(id)
  if (purged.files > 0) {
    await dropPlayMeta(id)
    notifyFileChanged(id) // player 的 localPath 可能正指着刚被删的缓存文件
    log('dl', '下载完成，清掉播放缓存目录 ' + id + '：' + purged.files + ' 个文件 / ' +
      Math.round(purged.bytes / 1024) + 'KB')
  }
  return purged
}

/** 下载完成后的共同收尾（正常路径 / 完整残片转正都走这里） */
async function finalizeOne(id, kd) {
  if (kd === 'download') {
    // 用户已正式下载这首 → 删掉 cache/<id>/ 整个目录（同一首占两份空间没意义）
    await purgeCacheCopy(id)
    // 退出中不再发详情/歌词请求：应用马上就没了，留给下次启动的 downloads 页 enrich
    if (!exiting) {
      try {
        await raceTimeout(saveSongExtras(id), 30000, null)
      } catch (e) {}
    }
  } else if (!exiting) {
    // 边听边存：趁刚写入判断一次「缓存上限」，超了就从最久没播的开始滚掉
    enforceCacheLimit().catch(function () {})
  }
}

async function downloadOne(song, info, opts, qk, kind) {
  const id = String(song.id)
  const kd = kind === 'download' ? 'download' : 'cache'
  const store = storeOf(kd)
  const t0 = Date.now()
  const since = function () {
    return Date.now() - t0
  }
  // 阶段日志（排查用，一次下载 4~5 行）：挂死时「最后一条」就是卡住的那一步
  log('dl', '取源 ' + id + ' ' + (song.name || '') + '[' + kd + ']' +
    (info && info.url ? '（复用播放直链）' : '（按' + qk + '解析）'))
  // 目录准备：通道根 + `<root>/<id>/`（原生 fs，不 fork）。下载与元数据写入都要求它在
  try {
    await prepareTrackDir(id, kd)
  } catch (e) {}

  // 0) 上次中断但残片已经写满：不联网，直接转正 + 收尾（先于「已有音频」判断——
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
  const hadOld = !!donePath // 盘上已有完整音频 = 本次是升级（begin 记 f=0）
  const mode = await raceTimeout(transportMode(), 15000, 'builtin')
  const partPath = finalPath + '.part'
  // 续传残片只认同档位：用户中途改过音质的话，旧档的 .part 接上新档字节会写出
  // 「长度对、内容是垃圾」的文件（校验只查长度，拦不住）→ 档位对不上就丢弃重下。
  // **从盘上读**：进程重启后内存快照是空的，只看内存会把上次中断留下的 .part
  // 当跨档残片丢掉，白丢已下载的进度。
  const pv = (prev && prev.p) || ''
  if ((await fileSize(partPath)) > 0 && pv !== qk) {
    log('dl', '丢弃跨档位的续传残片 ' + id + '[' + kd + ']（残片档=' + (pv || '未知') + ' 本次=' + qk + '）')
    await rmQuiet(partPath)
    await rmQuiet(partPath + '.cur')
  }
  // 下载开始就先写基础元数据（歌名/歌手/时长/封面 + p + 预期大小 z）：
  // 之后任何时刻退出，都不会出现「有歌没名字」。升级时 begin 不碰旧的 q/b/y。
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
  const alt = altPath(id, ext, kd)
  const altHad = (await fileSize(alt)) > 0
  await rmQuiet(alt)
  // 完成态元数据：写 q/b/y 并清掉 p/z。落库失败重试一次；仍失败只记日志
  // （文件本身仍是真相，启动对账 / 下次下载会再补，不能因此判下载失败）。
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
 * 删单条**下载**（本地下载页的多选删除 / deleteBatch 逐首调用）：删掉整个
 * `downloads/<id>/` 目录（音频 + .part/.part.cur 残片 + cover.jpg 一次走；
 * track_meta/歌词行随目录删除），再清归属标记与本地库挂点。
 * **只动 downloads/** —— 播放缓存不在这里出现，也不该被这个入口删掉
 * （缓存由「缓存上限」LRU 与存储管理页统一回收）。
 * 返回 {ok, files, bytes}（bytes = 删掉的字节，UI 提示「释放 X」用）。
 * ok 以「目录确实不在了」为准（X3S 桥接层 rm 曾静默失败，不能只看删除前的计数）；
 * 失败时**保留元数据与归属标记**（回滚 dropMeta/clearOrigin），避免留下
 * 「文件还在却没元数据」的行（列表上退化成「歌曲 <id>」，重新删除后无法补回）。
 * 边下边删的竞态不做处理（同一首正在下载时删，文件会在下载完成后重新出现）。
 */
export async function deleteCached(songId) {
  const id = String(songId)
  const r = await purgeInDir(musicDir(), id)
  // 目录还在 = 目录删除失败（残片/封面等删掉了也不算成功）→ 不动元数据，按失败返回
  const gone = !(await fileExists(musicDir() + '/' + id))
  if (!gone) {
    log('dl', '删除下载 ' + id + ' 失败：目录仍存在（rm 失败），保留元数据')
    return { ok: false, files: r.files, bytes: 0 }
  }
  await dropMeta(id)
  try {
    await clearOrigin(id) // 文件没了，归属标记一起清（dlorigin.js）
  } catch (e) {}
  try {
    await dropLocalSong(id) // 本地库的索引挂点随文件一起走（localmeta.js）
  } catch (e) {}
  sched.delDone(id)
  sched.clearWait(id, sched.getWait(id))
  notifyFileChanged(id)
  log('dl', '删除下载 ' + id + '：整个目录 ' + r.files + ' 个文件 / ' + Math.round(r.bytes / 1024) + 'KB')
  return { ok: true, files: r.files, bytes: r.bytes }
}

/* ---- 后台批量删除（数百首不阻塞 UI：页面乐观摘行，删除在模块级继续跑） ---- */

/** 进行中的批量删除（模块级单例：同一时间只允许一场） */
const delJob = { running: false, ids: [], at: 0, done: 0, failed: 0, bytes: 0, files: 0, cur: '' }

/**
 * 批量删除的进度快照（页面轮询/订阅用）：running=false 表示没有进行中的批量删除。
 * cur = 正在删的那首 id（页面用它做「正在删除 k/N」文案）。
 */
export function deleteBatchState() {
  return {
    running: delJob.running,
    total: delJob.ids.length,
    done: delJob.done,
    failed: delJob.failed,
    bytes: delJob.bytes,
    files: delJob.files,
    cur: delJob.cur,
    at: delJob.at
  }
}

/**
 * 后台批量删除 N 首**下载**（本地下载页多选删除 / 本地删除歌单的孤儿清理共用）。
 *
 * 为什么在模块级跑而页面只乐观摘行：数百首时逐首删除（目录 rm + 三条 SQLite 写）
 * 要跑十几秒，页面若 await 整批再刷新，UI 会长时间停在旧列表上「像没反应」；
 * 而页面退栈后再继续 await 又会把删除绑死在那个实例上。
 * 这里把循环移进服务层单例：调用方立即返回（排队/并入），每删完一首回调一次
 * onEach（页面摘行、更新进度），删除本身不依赖任何页面实例存活。
 *
 * 数据安全：deleteCached 自包含（目录与 track_meta/归属/本地库挂点成对增删），
 * 中途退出页面/应用只意味着「剩下的没删」—— 下次进来按目录重扫仍在，不存在
 * 半删状态。调用方若需对账（如多选删除后重查列表），在 onLast 里自己调。
 *
 * @param {Array<string|number>} ids  要删除的曲目 id 列表（内部转字符串）
 * @param {{onEach?: Function, onLast?: Function}} hooks  可选回调：
 *   onEach(id, r, st)  —— 每首删完（r = deleteCached 返回，st = 当时的 deleteBatchState）
 *   onLast(st)         —— 整批结束（成功或全部失败都会调；st.failed 可判断有无失败）
 * @returns {running: boolean}  false = 已有一场在跑，本次并入未启动（批量入口先查 state 再决定是否调）
 */
export function deleteBatch(ids, hooks) {
  const h = hooks || {}
  if (delJob.running) return { running: false }
  const list = []
  const seen = {}
  for (let i = 0; i < (ids || []).length; i++) {
    const k = String(ids[i] || '')
    if (k && !seen[k]) {
      seen[k] = 1
      list.push(k)
    }
  }
  if (!list.length) return { running: false }
  delJob.running = true
  delJob.ids = list
  delJob.at = Date.now()
  delJob.done = 0
  delJob.failed = 0
  delJob.bytes = 0
  delJob.files = 0
  delJob.cur = ''
  ;(async function () {
    for (let i = 0; i < delJob.ids.length; i++) {
      const id = delJob.ids[i]
      delJob.cur = id
      let r = null
      try {
        r = await deleteCached(id)
      } catch (e) {
        r = { ok: false, files: 0, bytes: 0, error: (e && e.message) || String(e) }
      }
      delJob.cur = ''
      if (r && r.ok) {
        delJob.done++
        delJob.files += r.files || 0
        delJob.bytes += r.bytes || 0
      } else {
        delJob.failed++
      }
      if (h.onEach) {
        try {
          h.onEach(id, r, deleteBatchState())
        } catch (e) {}
      }
    }
    delJob.running = false
    delJob.cur = ''
    log('dl', '批量删除结束：成功 ' + delJob.done + ' 失败 ' + delJob.failed +
      ' / ' + delJob.files + ' 个文件 ' + Math.round(delJob.bytes / 1024) + 'KB')
    if (h.onLast) {
      try {
        h.onLast(deleteBatchState())
      } catch (e) {}
    }
  })()
  return { running: true }
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

/* ================= 下载文案与空间预检（S3 从 ui/dlselect 收编） =================
   这是下载域自己的业务知识（文案句式、档位标签、空间比对），UI 层不该持有；
   页面从本门面导入，与 downloadSongs 等同一来源。 */

/** 顶栏副题：'下载中 3/12 · 42%'；停止中给 '正在停止下载…'；无活动给 '' */
export function dlText(d) {
  if (!d || !d.active) return ''
  if (d.stopping) return '正在停止下载…'
  const k = d.done + d.failed + (d.cancelled || 0)
  const cur = k < d.total ? k + 1 : k
  return '下载中 ' + cur + '/' + d.total + (d.pct ? ' · ' + d.pct + '%' : '')
}

/** 开始下载的 toast：「开始下载 12 首（极高）」 */
export function startText(n) {
  return '开始下载 ' + n + ' 首（' + qualityInfo(currentQuality('down')).label + '）'
}

/** 完成 toast：成功下载数与失败数分开显示 */
export function resultText(r) {
  if (!r) return '下载结束'
  if (!r.ok && !r.failed && r.cancelled) return '下载已停止'
  if (!r.ok && !r.failed && !r.skipped) return '没有可下载的内容'
  return '成功下载 ' + (r.ok || 0) + ' 首（' + (r.failed || 0) + ' 首失败）'
}

/**
 * 粗估一批歌按当前下载档的体积并与可用空间比对。
 * 返回 {est, free, tight}；free=0 = 读不到 df（exec 不可用）→ tight 恒 false（不做判断）。
 */
export async function spaceCheck(songs) {
  const est = estimateBytes(songs)
  let free = 0
  try {
    free = await freeBytes()
  } catch (e) {
    free = 0
  }
  return { est: est, free: free, tight: free > 0 && est > free }
}

/**
 * 下载活动快照的签名（判重用）：快照 ~400ms 一发，页面不判重就是持续重渲染
 * （平台坑 16 同族）。字段口径 = 页面显示的全部来源：active/total/三态计数/
 * stopping/pct；finished 只进「本地下载总览」的刷新判定（那里自己在 sig 外补）。
 */
export function dlSig(d) {
  d = d || {}
  return (d.active ? 1 : 0) + '|' + d.total + '|' +
    (d.done + d.failed + (d.cancelled || 0)) + '|' + (d.stopping ? 1 : 0) + '|' + d.pct
}
