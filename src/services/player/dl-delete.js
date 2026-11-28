// 媒体源层（拆分自 download.js）：下载目录的删除（单条 / 批量）与本地路径失效。
import { purgeTrack } from './files.js'
import { trackDir } from '../../core/infra/paths.js'
import { fileExists } from '../../core/platform/fsutil.js'
import { dropMeta } from './cache.js'
import { clearOrigin } from './dlorigin.js'
import { dropLocalSong } from './localmeta.js'
import { fileChangedHooks, notifyFileChanged } from './dl-hooks.js'
import { log } from '../../core/infra/log.js'
import * as sched from './scheduler.js'

/* 删单条**下载**（本地下载页的多选删除 / deleteBatch 逐首调用）：删掉整个 downloads/<id>/ 目录
 * （音频 + .part/.part.cur 残片 + cover.jpg 一次走；track_meta/歌词行随目录删除），再清归属标记与本地库挂点。
 * **只动 downloads/** —— 播放缓存不在这里出现，也不该被这个入口删掉（缓存由「缓存上限」LRU 与存储管理页回收）。
 * ok 以「目录确实不在了」为准（X3S 桥接层 rm 曾静默失败，不能只看删除前的计数）；失败时**保留元数据与归属标记**，
 * 避免留下「文件还在却没元数据」的行（列表上退化成「歌曲 <id>」，重新删除后无法补回）。
 * 返回 {ok, files, bytes}（bytes = 删掉的字节，UI 提示「释放 X」用）。边下边删的竞态不做处理。 */
export async function deleteCached(songId) {
  const id = String(songId)
  const r = await purgeTrack(id, 'download')

  // 目录还在 = 目录删除失败（残片/封面等删掉了也不算成功）→ 不动元数据，按失败返回
  const gone = !(await fileExists(trackDir(id, 'download')))
  if (!gone) {
    log('dl', '删除下载 ' + id + ' 失败：目录仍存在（rm 失败），保留元数据')
    return { ok: false, files: r.files, bytes: 0 }
  }
  await dropMeta(id)
  try {
    // 文件没了，归属标记一起清
    await clearOrigin(id) 
  } catch (e) {}
  try {
    // 本地库的索引挂点随文件一起走
    await dropLocalSong(id) 
  } catch (e) {}
  sched.delDone(id)
  sched.clearWait(id, sched.getWait(id))
  notifyFileChanged(id)
  log('dl', '删除下载 ' + id + '：整个目录 ' + r.files + ' 个文件 / ' + Math.round(r.bytes / 1024) + 'KB')
  return { ok: true, files: r.files, bytes: r.bytes }
}

// 进行中的批量删除（模块级单例：同一时间只允许一场）
const delJob = { running: false, ids: [], at: 0, done: 0, failed: 0, bytes: 0, files: 0, cur: '' }

// 批量删除的进度快照（页面轮询/订阅用）：running=false 表示没有进行中的批量删除；cur = 正在删的那首 id
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

/* 后台批量删除 N 首**下载**（本地下载页多选删除 / 本地删除歌单的孤儿清理共用）。
 * 在模块级跑、页面只乐观摘行：数百首时逐首删除（目录 rm + 三条 SQLite 写）要跑十几秒，页面 await 整批
 * 会长时间停在旧列表上「像没反应」；页面退栈后再继续 await 又会把删除绑死在那个实例上。
 * 每删完一首回调 onEach(id, r, st)，整批结束回调 onLast(st)；删除本身不依赖任何页面实例存活。
 * 数据安全：deleteCached 自包含，中途退出只意味着「剩下的没删」，不存在半删状态。
 * 返回 {running: false} = 已有一场在跑（批量入口先查 state 再决定是否调）。 */
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

/* 整库失效（存储管理页「清空音乐缓存」用）：先取消批量下载（正在下的往已删目录里写会把 .part 写坏 /
 * 提升失败），再作废 doneCache、通知 player 清 localPath。**不删文件** —— 文件删除仍由 cache.clearSongs() 做 */
export function forgetAll() {
  sched.cancelDownload()
  invalidateLocalPaths()
}

/* 只作废「本会话已确认的本地路径」与播放器手上的 localPath —— **不动下载队列**。
 * 用于清空**自动缓存**目录：正在播的那首文件被删后 fd 仍在（声音不断），但 localPath 已指向不存在的文件，
 * seek/续播会失败一次 → 先清掉让它们重新探测。（清**下载**目录仍用 forgetAll：那边文件被删，正在跑的下载必须一起取消） */
export function invalidateLocalPaths() {
  const n = sched.clearPathTables()
  if (fileChangedHooks.length) {
    try {
      // 空 id = 全部失效（player 的钩子按此清 localPath）
      notifyFileChanged('') 
    } catch (e) {}
  }
  log('dl', '本地路径失效：doneCache ' + n + ' 条已作废')
}
