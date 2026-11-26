

// 下载调度：两条通道、单并发 —— play 通道（播放要用的缓存，最新请求优先，新请求作废旧等者）
// 与 batch 通道（用户主动下载，FIFO 不淘汰、重试不丢）；播放通道优先调度，整体单并发（不跟流播抢带宽）。
// 去重三层：inflight/ensureWait 搭车 → waiting 队列里合并等待者 → batch 队列里播放请求提权、批量请求合并。
// 真正的下载动作（downloadOne）与文件变更通知/活动快照都不在这里：前者由 download.js 门面经 wireScheduler 注入，后两者经 tasks.js 写入，避免循环依赖。
import { log } from '../../core/infra/log.js'
import { purgeTrack } from './files.js'
import { playCacheDir } from './cache.js'
import { addProgressHook, dropProgressHooks, fireProgress } from './progress.js'
import { currentQuality } from './quality.js'
import * as tasks from './tasks.js'

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

// inflight = 正在跑的队列项（pump 登记，同 id 后到请求搭车）；ensureWait = ensureCached 的包装 promise（含还没轮到跑的排队期）
// ⚠ 两张表必须分开：包装 promise 内部会调 queueDownload，若它登记进 inflight，queueDownload 查到的
// 就是自己的调用者 → return 它 → 自 await 死锁（表现：只有未命中缓存的歌卡在「缓冲中 0%」，缓存命中的歌正常，极具迷惑性）
const inflight = {} 
const ensureWait = {} 

// 本会话内已确认完整的缓存：id -> path
const doneCache = {} 

let running = false
// play 通道队列项（新播放请求会清队作废旧项）
const waiting = [] 
// batch 通道队列项（FIFO，靠 token 协作式取消）
const batch = [] 
// 批量下载代次：cancelDownload() 时 +1，旧 token 的批量项作废
let batchToken = 0 
// 当前在跑的队列项（任务清单 / cancelTask 找它打中止标记）
let runningW = null 

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

export function setDownloaderForTest(fn) {
  downloadOneImpl = fn
}

export function runningItem() {
  return runningW
}

export function clearPathTables() {
  const keys = Object.keys(doneCache)
  for (let i = 0; i < keys.length; i++) delete doneCache[keys[i]]
  const wk = Object.keys(ensureWait)
  for (let i = 0; i < wk.length; i++) delete ensureWait[wk[i]]
  return keys.length
}

function buildOpts(w, userProgress) {
  const id = String(w.song.id)
  let onProgress
  if (w.counted) {

    // counted = 批量入的项（含被提权到播放通道的）：进度要回写活动快照，下载页/首页卡的 NN% 才有得看
    // （提权项也算，不然它跑的时候 pct 停在 0）
    
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

export function resolveItem(w, r) {
  for (let i = 0; i < w.resolvers.length; i++) {
    try {
      w.resolvers[i](r)
    } catch (e) {}
  }
}

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
  runningW = w 
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
        // 旧文件被顶掉：player 的 localPath 可能已失效
        if (r.replaced) notifyFileChangedImpl(rid) 
      } else if (!(r && r.aborted)) {

        // 播放通道的失败没有 toast（只有批量项有）——留一条日志便于排查
        log('dl', (w.counted ? '批量' : '播放') + '下载未完成 ' + rid + '：' + ((r && r.error) || '未知'))
      }
      if (w.counted) {
        // counted = 批量通道入的项（提权到播放通道后仍是它）：活动计数只认一次

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

// 播放通道入队。去重：正在下载（inflight）→ 搭车；已在播放队列 → 合并等待者；
// 在批量队列里还没开跑 → 提权搬进播放通道（用户点播的歌不该排在几十首批量后面）。
// 新请求作废旧播放请求（最新优先）；被顶掉的批量项以 superseded 结算，由 downloadSongs 重排。
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

      // 同一首已在队列：合并等待者（各 resolve 都会调到，Promise 取第一次），不作废
      
      addProgressHook(id, opts && opts.onProgress)
      return new Promise(function (resolve) {
        waiting[i].resolvers.push(resolve)
      })
    }
  }
  addProgressHook(id, opts && opts.onProgress)

  // 新请求作废旧播放请求（最新优先）：先清队，再决定是提权还是新建。
  // 被顶掉的若是批量项（counted）：计入 cancelled，否则「下载中 k/N」永远到不了 N
  

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

  // ⚠ 清队之后再查一次 waiting：两次调用交错在「清队」前后时，后者的 resolver 必须挂到清队后留下的项上，
  // 否则会连着新建第二个同 id 项（双份写）
  

  
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
      // 播放通道 = 边听边存：cache/ 目录 + 播放音质（与流播那份直链同档）
      kind: 'cache', 
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

// 批量通道入队（用户主动下载）：正在下载 → 搭车；ensureWait 有 → 搭车；批量/播放队列已有 → 合并等待者；
// 否则新建队列项（计入活动快照）。同 id 绝不重复下载。
export function enqueueBatch(song, qk) {
  const id = String(song.id)
  const old = inflight[id]
  if (old) return old
  // 播放侧还在排队/解析中的同一首：搭它的车（只下一次）
  const wait = ensureWait[id] 
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
    // 用户下载：下载目录 + 下载音质；提权到播放通道只改 lane，kind 不变
    kind: 'download', 
    song: song,
    info: null,
    opts: null,
    qk: qk,
    token: batchToken,
    // 活动计数认它（提权到播放通道后也认）
    counted: true, 
    resolvers: []
  }
  const p = new Promise(function (resolve) {
    item.resolvers.push(resolve)
  })
  batch.push(item)
  pump()
  return p
}

// 取消批量下载：代次 +1，队列里未开始的全部作废；正在下的下完当前片即停（.part 保留）。
// setStopping 只做「正在停止…」的乐观反馈（真停靠片间检查，最坏要等当前片结束）。
export function cancelDownload() {
  if (!tasks.isActive() && !batch.length && !running) return
  batchToken++
  if (tasks.isActive()) tasks.setStopping(true)
  log('dl', '取消批量下载 token=' + batchToken + '（队列剩 ' + batch.length + '，运行中=' + running + '）')
  // 没在跑：直接把队列里的作废项结算掉（settleActivity 一并收尾）
  if (!running) pump() 
}

// 应用退出用：清空播放通道排队项 + 给正在跑的项打 abort 标记。
// cancelDownload 只管批量通道（token 代次），播放通道的排队项没有 token；不在这里摘掉的话 pump 会在退出过程中继续起新的缓存下载。
// 正在跑的 curl 由 fetcher 的 stopFetching() 负责杀掉，本函数只保证「不再起新的」。
export function abortPlayQueue() {
  while (waiting.length) {
    const w = waiting.shift()
    dropProgressHooks(String(w.song.id))
    resolveItem(w, { ok: false, path: '', size: 0, aborted: true, error: '应用退出' })
  }
  if (runningW) runningW.abort = true
}

// 等当前队列项收尾（退出链用）：轮询 50ms，超时返回 false，绝不把退出卡死。
export function waitIdle(ms) {
  if (!running) return Promise.resolve(true)
  return new Promise(function (resolve) {
    const t0 = Date.now()
    const iv = setInterval(function () {
      if (!running) {
        clearInterval(iv)
        resolve(true)
        return
      }
      if (Date.now() - t0 >= ms) {
        clearInterval(iv)
        resolve(false)
      }
    }, 50)
  })
}

export function purgePlayCache(id) {
  return purgeTrack(id, 'cache')
}
