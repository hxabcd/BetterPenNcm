/**
 * 媒体源层之一：批量下载的**活动快照、任务清单与订阅**（从 download.js 拆出）。
 *
 * 语义（与原实现一致）：
 *   - 「一次下载会话」= batch 通道上有活（入队到清空）；期间 total 只增不减，
 *     done/failed/cancelled 逐首累加；同一首被后来的请求搭车不重复计数（它只有一次下载）。
 *   - 「任务」= counted 项（用户下载通道入的；播放的后台缓存不算）。已完成（成功/失败/取消）
 *     留在 finishedTasks 里，**队列页展示一次后**由页面调 ackFinished() 清掉。
 *   - 只在内存里：应用重启即空（下载队列本身也不跨重启，未完成靠 .part 续传）。
 *
 * 与调度器（scheduler.js）的分工：本模块**不 import** 调度器（避免循环依赖）——
 * 通过 wireTasks(sched) 注入一组只读/定向操作接口（队列视图、找项、摘项、打中止标记）。
 */
import { log } from '../log.js'

/* ---- 活动快照 ---- */
const act = { active: false, total: 0, done: 0, failed: 0, cancelled: 0, stopping: false, curId: '', curName: '', pct: 0 }
const dlSubs = []
let lastDlEmit = 0

/* ---- 任务清单 ---- */
const FINISH_MAX = 50
let finishedTasks = [] // [{id, name, state:'done'|'failed'|'cancelled', error, at}] 新→旧

/* ---- 调度器接口（wireTasks 注入） ---- */
let sched = null

/** 由 download.js 在模块加载时注入调度器接口 */
export function wireTasks(iface) {
  sched = iface
}

/* ---- 调度器用的「活动」写入点（pump 侧调用） ---- */

/** 开一轮新会话：计数归零 + active 点亮（enqueueBatch 用） */
export function activityStart() {
  if (!act.active) {
    act.total = 0
    act.done = 0
    act.failed = 0
    act.cancelled = 0
  }
  act.active = true
  act.stopping = false
  act.total++
  emitDl(true)
}

/** 当前在跑的项点亮（pump 启动一个项时调用） */
export function activityCur(id, name) {
  act.curId = String(id)
  act.curName = name || ''
  act.pct = 0
  emitDl(true)
}

/** 进度回写（counted 项的 onProgress 用） */
export function activityPct(pct) {
  act.pct = pct
  emitDl(false)
}

/** 计数 +1（kind: 'done' | 'failed' | 'cancelled'） */
export function activityBump(kind) {
  if (kind === 'done') act.done++
  else if (kind === 'cancelled') act.cancelled++
  else act.failed++
}

export function setStopping(v) {
  act.stopping = !!v
  emitDl(true)
}

export function isActive() {
  return !!act.active
}

/** batch 通道清空后收尾一次（active → false） */
export function settleActivity() {
  if (!act.active) return
  act.active = false
  act.stopping = false
  act.curId = ''
  act.curName = ''
  act.pct = 0
  log('dl', '批量下载结束：成功 ' + act.done + ' 失败 ' + act.failed + ' 取消 ' + act.cancelled)
  emitDl(true)
}

/** 记一条已完成任务（只认 counted 项） */
export function finishTask(w, state, error) {
  if (!w || !w.counted) return
  finishedTasks.unshift({
    id: String(w.song.id),
    name: w.song.name || '',
    state: state,
    error: error || '',
    at: Date.now()
  })
  if (finishedTasks.length > FINISH_MAX) finishedTasks.length = FINISH_MAX
}

/* ---- 快照与订阅 ---- */

function snapshotDl() {
  return {
    active: act.active,
    total: act.total,
    done: act.done,
    failed: act.failed,
    cancelled: act.cancelled,
    stopping: act.stopping,
    curId: act.curId,
    curName: act.curName,
    pct: act.pct,
    finished: finishedTasks.length // 未查看的已完成任务数（下载页「下载队列」键的提示/高亮用）
  }
}

/** 当前下载活动快照（无活动时 active=false，其余字段无意义） */
export function dlState() {
  return snapshotDl()
}

/** 订阅下载活动变化（进度节流 ~400ms 一次；结构变化立即发）。返回句柄供 offDl */
export function onDl(fn) {
  dlSubs.push(fn)
  return fn
}

export function offDl(fn) {
  const i = dlSubs.indexOf(fn)
  if (i >= 0) dlSubs.splice(i, 1)
}

function emitDl(force) {
  const now = Date.now()
  if (!force && now - lastDlEmit < 400) return
  lastDlEmit = now
  const s = snapshotDl()
  for (let i = 0; i < dlSubs.length; i++) {
    try {
      dlSubs[i](s)
    } catch (e) {}
  }
}

/* ---- 任务清单页（下载队列页） ---- */

/**
 * 下载队列快照（下载队列页）：进行中 + 排队中（先播放通道的提权项、再批量队列）+ 已完成。
 * 已完成的由页面在离开时 ackFinished() 清掉（「展示一次后移除」）。
 */
export function dlTasks() {
  const out = { active: null, waiting: [], finished: finishedTasks.slice() }
  const run = sched && sched.runningItem()
  if (run && run.counted) {
    out.active = {
      id: String(run.song.id),
      name: run.song.name || '',
      pct: act.pct,
      stopping: !!(run.abort || run.token < (sched.batchToken() || 0))
    }
  }
  const queues = (sched && sched.getQueues()) || [[], []]
  const push = function (arr) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].counted) out.waiting.push({ id: String(arr[i].song.id), name: arr[i].song.name || '' })
    }
  }
  push(queues[0]) // 提权到播放通道的批量项排在前面（它们先跑）
  push(queues[1])
  return out
}

/** 队列页展示过后清掉已完成任务（「已完成的任务在展示一次后从队列中移除」） */
export function ackFinished() {
  if (!finishedTasks.length) return
  log('dl', '已完成任务出队 ' + finishedTasks.length + ' 条')
  finishedTasks = []
  emitDl(true)
}

/* ---- 单任务中断（下载队列页） ---- */

/**
 * 中断单个任务（下载队列页点行，两次确认后调）：
 *   - 正在跑的（批量或已提权）：打 abort 标记 → fetchToFile 片间停下（.part 保留可续传）
 *   - 排队中的：直接摘出队列按「已取消」结算
 * 返回是否命中一个任务。**不影响播放通道的后台缓存**（那不是任务）。
 */
export function cancelTask(songId) {
  if (!sched) return false
  const id = String(songId)
  const run = sched.runningItem()
  if (run && run.counted && String(run.song.id) === id) {
    run.abort = true
    emitDl(true)
    log('dl', '中断任务(进行中) ' + id)
    return true
  }
  const w = sched.takeQueued(id, true) // 只摘 counted（任务）项
  if (!w) return false
  act.cancelled++
  finishTask(w, 'cancelled', '已取消')
  emitDl(true)
  sched.resolveItem(w, { ok: false, path: '', size: 0, aborted: true, error: '已取消' })
  log('dl', '中断任务(排队中) ' + id)
  return true
}

/** emit 的强制触发（调度器结构变化时用；与 force=true 的 emitDl 等价） */
export function emitNow() {
  emitDl(true)
}
