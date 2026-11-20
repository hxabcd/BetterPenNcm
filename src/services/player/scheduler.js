/**
 * 媒体源层之一：下载调度器。
 *
 * 两条通道、单并发：
 *   - **play 通道**（queueDownload / ensureCached）：播放要用的缓存，最新请求优先
 *     （新请求作废旧的等者）
 *   - **batch 通道**（enqueueBatch / downloadSongs）：用户主动下载，FIFO 不淘汰、重试不丢；
 *     播放通道优先调度，整体仍是单并发（不跟流播抢带宽）
 *
 * 去重的三层（同一首歌不会被下两遍）：
 *   1) inflight（正在跑）/ ensureWait（播放侧包装层，排队期）：后到的任何请求直接搭车；
 *      进度经 progressHooks 转发（不然播放的回调拿不到，界面停在「缓冲中 0%」）。
 *      ⚠️ 两张表必须分开，否则 queueDownload 会搭上「自己的调用者」形成自await死锁 ——
 *      详见 inflight/ensureWait 声明处的血泪注释
 *   2) 在 waiting 队列里（播放通道排队中）→ 合并等待者
 *   3) 在 batch 队列里（批量排队中）：播放请求 → **提权**挪进播放通道（不然点播要排在
 *      几十首批量后面）；批量请求 → 合并等待者
 *
 * 真正的下载动作（downloadOne）与「文件变更通知」「活动快照」都不在这里 ——
 * 前者由 download.js 门面经 wireScheduler 注入，后两者经 tasks.js 的公开函数写入，
 * 避免循环依赖。
 */
import { log } from '../log.js'
import { purgeInDir } from './files.js'
import { playCacheDir } from './cache.js'
import { addProgressHook, dropProgressHooks, fireProgress } from './progress.js'
import { currentQuality } from './quality.js'
import * as tasks from './tasks.js'

/* ---- 注入点（download.js 门面在模块加载时调用） ---- */
let downloadOneImpl = null
let notifyFileChangedImpl = function () {}

export function wireScheduler(iface) {
  downloadOneImpl = iface.downloadOne
  if (iface.notifyFileChanged) notifyFileChangedImpl = iface.notifyFileChanged
  tasks.wireTasks({
    runningItem: function () {
      return runningW
    },
    getQueues: function () {
      return [waiting, batch]
    },
    batchToken: function () {
      return batchToken
    },
    takeQueued: takeQueued,
    resolveItem: resolveItem
  })
}

/* ---- 状态表 ---- */

const inflight = {} // id(String) -> Promise（**正在运行**的队列项的 promise，pump 登记；同 id 后到请求搭车）
const ensureWait = {} // id(String) -> Promise（ensureCached 的包装 promise，含「还没轮到跑」的排队期）
/* ⚠️ inflight 与 ensureWait 必须分开（真机血泪）：
   ensureCached 的包装 promise p 内部会调 queueDownload；如果 p 也登记进 inflight，
   queueDownload 查 inflight 时会查到 **它自己的调用者 p** → return p → p 等自己 → 死锁
   （表现：只有「未命中缓存」的歌会卡在「缓冲中 0%」永不返回；缓存命中的歌在更早的
   分支就返回所以一切正常，极具迷惑性）。两张表：inflight = 跑着的项（可供任何人搭车）；
   ensureWait = 包装层去重（只给 ensureCached/enqueueBatch 入口用，queueDownload 不许看）。 */
const doneCache = {} // id(String) -> path（本会话内已确认完整的缓存）

let running = false
const waiting = [] // play 通道 [{lane:'play', song, info, opts, qk, token?, counted?, resolvers}]
const batch = [] // batch 通道 [{lane:'batch', song, info:null, opts, qk, token, counted:true, resolvers}]
let batchToken = 0 // 批量下载代次：cancelDownload() 时 +1，旧 token 的批量项作废
let runningW = null // 当前在跑的队列项（任务清单/cancelTask 找它打中止标记）

/* ---- 对门面暴露的只读/定向操作（ensureCached / download.js 用） ---- */

export function getDone(id) {
  return doneCache[id] || ''
}

export function setDone(id, path) {
  if (path) doneCache[id] = path
}

export function delDone(id) {
  delete doneCache[id]
}

export function getWait(id) {
  return ensureWait[id] || null
}

export function setWait(id, p) {
  ensureWait[id] = p
}

export function clearWait(id, p) {
  if (ensureWait[id] === p) delete ensureWait[id]
}

export function getFlight(id) {
  return inflight[id] || null
}

/** 替换下载动作（PC 侧冒烟测试用：注入可控的假 downloadOne） */
export function setDownloaderForTest(fn) {
  downloadOneImpl = fn
}

/** 当前在跑的队列项（tasks 的任务清单与 PC 侧冒烟测试都用它） */
export function runningItem() {
  return runningW
}

/** 整库/局部失效用：清两张表（回调通知由门面做） */
export function clearPathTables() {
  const keys = Object.keys(doneCache)
  for (let i = 0; i < keys.length; i++) delete doneCache[keys[i]]
  const wk = Object.keys(ensureWait)
  for (let i = 0; i < wk.length; i++) delete ensureWait[wk[i]]
  return keys.length
}

/* ---- 队列项运行参数（pump 启动项时装配） ---- */

/**
 * 队列项的运行参数：
 *   - 进度：userProgress（调用方自己的，仅播放通道有）+ progressHooks 转发
 *   - 批量项额外回写活动快照（dlState 的 pct）
 *   - shouldAbort：带 token 的项（批量/被提权的批量项）受 cancelDownload 的协作式取消
 */
function buildOpts(w, userProgress) {
  const id = String(w.song.id)
  let onProgress
  if (w.counted) {
    // counted = 批量入的项（含被提权到播放通道的）：进度回写活动快照，
    // 下载页/首页卡的「NN%」才有得看（提权项也算，不然它跑的时候 pct 停在 0）
    onProgress = function (done, total, speed) {
      tasks.activityPct(total ? Math.floor((done / total) * 100) : 0)
      fireProgress(id, done, total, speed)
    }
  } else {
    onProgress = function (done, total, speed) {
      if (userProgress) {
        try {
          userProgress(done, total, speed)
        } catch (e) {}
      }
      fireProgress(id, done, total, speed)
    }
  }
  const opts = { onProgress: onProgress }
  if (w.token !== undefined) {
    opts.shouldAbort = function () {
      // 整批取消（token 代次）或单任务中断（cancelTask 打的 abort 标记）
      return !!(w.abort || w.token < batchToken)
    }
  }
  return opts
}

/* ---- 结算 ---- */

export function resolveItem(w, r) {
  for (let i = 0; i < w.resolvers.length; i++) {
    try {
      w.resolvers[i](r)
    } catch (e) {}
  }
}

/** 从队列里摘一个同 id 的项；onlyCounted = 只摘批量任务项（cancelTask 用） */
export function takeQueued(id, onlyCounted) {
  const lanes = [waiting, batch]
  for (let L = 0; L < lanes.length; L++) {
    const arr = lanes[L]
    for (let i = 0; i < arr.length; i++) {
      if (String(arr[i].song.id) === id && (!onlyCounted || arr[i].counted)) {
        const w = arr.splice(i, 1)[0]
        dropProgressHooks(id)
        return w
      }
    }
  }
  return null
}

/* ---- 调度泵 ---- */

/**
 * 调度：播放通道优先，其次批量；单并发。
 * 批量项被取消（token 落后）→ 直接作废；否则装配进度回调与 shouldAbort 后开跑。
 */
function pump() {
  if (running) return
  let w = null
  while (true) {
    w = waiting.shift() || batch.shift()
    if (!w) break
    if (w.lane === 'batch') {
      if (w.token < batchToken) {
        // 已取消（还没开跑就作废）：计入 cancelled 与任务清单，别让「下载中 k/N」永远到不了 N
        tasks.activityBump('cancelled')
        tasks.finishTask(w, 'cancelled', '已取消')
        tasks.emitNow()
        resolveItem(w, { ok: false, path: '', size: 0, aborted: true, error: '已取消' })
        w = null
        continue
      }
      tasks.activityCur(w.song.id, w.song.name)
      w.opts = buildOpts(w, null)
    } else {
      const user = w.opts || {}
      w.opts = buildOpts(w, user.onProgress)
      if (w.counted) {
        // 被提权到播放通道的批量项：活动快照也要点亮（否则播放页下载键不亮、顶栏没有进度）
        tasks.activityCur(w.song.id, w.song.name)
      }
    }
    break
  }
  if (!w) {
    tasks.settleActivity()
    return
  }
  running = true
  runningW = w // 任务清单/cancelTask 找当前在跑的项
  const rid = String(w.song.id)
  log('dl', '启动 ' + rid + (w.counted ? '（批量）' : '（播放）'))
  // 「在飞」登记：同 id 的后到请求（播放/批量）搭这趟车，绝不会重复下载（跨通道去重的权威表）
  const jobP = new Promise(function (resolve) {
    w.resolvers.push(resolve)
  })
  inflight[rid] = jobP
  downloadOneImpl(w.song, w.info, w.opts, w.qk, w.kind)
    .then(function (r) {
      if (inflight[rid] === jobP) delete inflight[rid]
      dropProgressHooks(rid)
      if (r && r.ok) {
        doneCache[rid] = r.path
        if (r.replaced) notifyFileChangedImpl(rid) // 旧文件被顶掉：player 的 localPath 可能已失效
      } else if (!(r && r.aborted)) {
        // 播放通道的失败原先完全静默（只有批量项有 toast）——留一条日志便于排查
        log('dl', (w.counted ? '批量' : '播放') + '下载未完成 ' + rid + '：' + ((r && r.error) || '未知'))
      }
      if (w.counted) {
        // counted = 批量通道入的项（被提权到播放通道后仍是它）：活动计数只认一次
        if (r && r.ok) {
          tasks.activityBump('done')
          tasks.finishTask(w, 'done')
        } else if (r && r.aborted) {
          tasks.activityBump('cancelled')
          tasks.finishTask(w, 'cancelled', r.error)
        } else {
          tasks.activityBump('failed')
          tasks.finishTask(w, 'failed', r && r.error)
        }
        tasks.activityCur('', '')
        tasks.emitNow()
      }
      resolveItem(w, r)
    })
    .catch(function (e) {
      if (inflight[rid] === jobP) delete inflight[rid]
      dropProgressHooks(rid)
      if (w.counted) {
        tasks.activityBump('failed')
        tasks.finishTask(w, 'failed', (e && e.message) || String(e))
        tasks.emitNow()
      }
      resolveItem(w, { ok: false, path: '', error: (e && e.message) || String(e) })
    })
    .then(function () {
      running = false
      runningW = null
      pump()
    })
}

/* ---- 入队 ---- */

/**
 * 播放通道排队（流式播放时抢带宽，所以串行；被顶掉的旧请求以 `superseded` 结算 ——
 * 批量搭车到播放项的那份结果据此重排，见 downloadSongs）。
 * 去重：正在下载（inflight）→ 搭车；已在播放队列 → 合并等待者；
 * 在批量队列里还没开跑 → **提权**搬进播放通道（用户点播的歌不该排在批量下载后面）。
 */
export function queueDownload(song, info, opts) {
  const id = String(song.id)
  const old = inflight[id]
  log('dl', '入队(play) ' + id + (old ? '（搭车在飞下载）' : ''))
  if (old) {
    addProgressHook(id, opts && opts.onProgress)
    return old
  }
  for (let i = 0; i < waiting.length; i++) {
    if (String(waiting[i].song.id) === id) {
      // 同一首已在队列：合并等待者（各 resolve 都会调到，Promise 取第一次）。
      // **不作废**（旧实现同序：清队前的合并检查，搭车即可）
      addProgressHook(id, opts && opts.onProgress)
      return new Promise(function (resolve) {
        waiting[i].resolvers.push(resolve)
      })
    }
  }
  addProgressHook(id, opts && opts.onProgress)
  // 新请求作废旧播放请求（最新优先）——先清队，再决定是提权还是新建。
  // 被顶掉的若是批量项（counted）：计入 cancelled，否则「下载中 k/N」永远到不了 N
  // （downloadSongs 会把 superseded 的批量项重排一次，重排是新的一个计数，两边对得上）
  while (waiting.length) {
    const w = waiting.shift()
    if (w.counted) {
      tasks.activityBump('cancelled')
      tasks.activityCur('', '')
      tasks.emitNow()
    }
    dropProgressHooks(String(w.song.id))
    resolveItem(w, { ok: false, path: '', superseded: true, error: '已被新的播放请求取代' })
  }
  // ⚠ 清队之后再查一次 waiting（拆分后冒烟测试补的边界）：
  // 本函数两次调用交错在「清队」前后时（后者的进入点在前者清队之后），
  // 后者的 resolver 必须挂到清队后留下的项上，否则会连着新建第二个同 id 项（双份写）。
  // 旧单文件实现里这个位置的回查在清队之前、同 id 的先后到达从不触发，属等价性兜底。
  for (let i = 0; i < waiting.length; i++) {
    if (String(waiting[i].song.id) === id) {
      return new Promise(function (resolve) {
        waiting[i].resolvers.push(resolve)
      })
    }
  }
  let item = null
  for (let i = 0; i < batch.length; i++) {
    const b = batch[i]
    // 已取消（token 落后）的别提权：留给 pump 按取消结算
    if (String(b.song.id) === id && b.token >= batchToken) {
      item = batch.splice(i, 1)[0]
      item.lane = 'play'
      log('dl', '播放提权：' + id + ' 从批量队列挪到播放通道')
      break
    }
  }
  if (!item) {
    item = {
      lane: 'play',
      kind: 'cache', // 播放通道 = 边听边存：cache/ 目录 + **播放音质**（与流播那份直链同档）
      song: song,
      info: info || null,
      opts: opts || null,
      qk: currentQuality('play'),
      resolvers: []
    }
  }
  const p = new Promise(function (resolve) {
    item.resolvers.push(resolve)
  })
  waiting.push(item)
  pump()
  return p
}

/**
 * 用户批量通道入队。去重三层（同 id 绝不重复下载，见文件头的调度说明）：
 *   正在下载（inflight）→ 搭车；批量队列已有 → 合并等待者；播放队列排着 → 也搭车。
 * 否则新建队列项（计入活动快照）。
 */
export function enqueueBatch(song, qk) {
  const id = String(song.id)
  const old = inflight[id]
  if (old) return old
  const wait = ensureWait[id] // 播放侧还在排队/解析中的同一首：搭它的车（一次下载）
  if (wait) return wait
  for (let i = 0; i < batch.length; i++) {
    if (String(batch[i].song.id) === id) {
      return new Promise(function (resolve) {
        batch[i].resolvers.push(resolve)
      })
    }
  }
  for (let i = 0; i < waiting.length; i++) {
    if (String(waiting[i].song.id) === id) {
      return new Promise(function (resolve) {
        waiting[i].resolvers.push(resolve)
      })
    }
  }
  tasks.activityStart()
  const item = {
    lane: 'batch',
    kind: 'download', // 用户下载：music/ 目录 + **下载音质**；提权到播放通道也只改 lane，kind 不变
    song: song,
    info: null,
    opts: null,
    qk: qk,
    token: batchToken,
    counted: true, // 活动计数认它（提权到播放通道后也认）
    resolvers: []
  }
  const p = new Promise(function (resolve) {
    item.resolvers.push(resolve)
  })
  batch.push(item)
  pump()
  return p
}

/** 取消批量下载：代次 +1，队列里未开始的全部作废；正在下的下完当前片即停（.part 保留）。
 *  置 stopping 标志做「正在停止…」的乐观反馈（真正的停靠片间检查，最坏要等当前片结束）。 */
export function cancelDownload() {
  if (!tasks.isActive() && !batch.length && !running) return
  batchToken++
  if (tasks.isActive()) tasks.setStopping(true)
  log('dl', '取消批量下载 token=' + batchToken + '（队列剩 ' + batch.length + '，运行中=' + running + '）')
  if (!running) pump() // 没在跑：直接把队列里的作废项结算掉（settleActivity 一并收尾）
}

/* ---- 收尾 ---- */

/** 清播放缓存目录里某 id 的残留（download 完成后的「不留两份」用）；返回 {files, bytes} */
export function purgePlayCache(id) {
  return purgeInDir(playCacheDir(), id)
}
