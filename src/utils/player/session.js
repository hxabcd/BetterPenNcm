/**
 * 上次播放状态（播放器会话快照）—— storage 单 key 落盘，boot 时由 player.loadLastState 恢复
 *
 * **播放器记录上次播放状态，首页「正在播放」卡片从播放器取数据**。
 * 记录内容 = 播放队列 + 当前曲 + 下标 + 播放位置（+ 保存瞬间是否在出声，仅供日志）。
 * 恢复态**一律暂停**：卡片/播放页显示上次的歌与进度，按 ▶ 才从上次位置
 * 继续，开应用不会突然出声。
 *
 * 与 history.js 的分工：历史是「听过什么」的流水（去重、上限 200、可被详情接口补字段），
 * 这里是「听到哪儿了」的快照（队列顺序 + 位置 + 进度），生命周期不同，各存各的 key。
 *
 * 落盘同 history.js 的**串行 + 合并写**：写盘期间来的新快照只留最新一份、写完补一次，
 * setStorage 永远不并发（播放中每 15 秒一次位置快照，切歌/暂停/seek 由 player 即时触发）。
 * 队列超过 MAXQ 时只存当前曲附近的窗口（大歌单别每次写几百 KB）；恢复后下标仍指向同一首，
 * 窗口外的歌不在了（队列页会短一截）—— 比拖慢每次写盘划算。
 *
 * 随机模式（假随机）的**临时队列另存一份 id 序列**（rec.shuffle，见 slimShuffle）：快照里的
 * queue 始终是原始队列，随机顺序只是它的一份排列。id 很小（≈队列体积的 1/10），
 * 恢复时按 id 映射回歌曲对象即可，代价可忽略。
 */
import { getStorage, setStorage, removeStorage } from '../store.js'
import { log } from '../log.js'

const KEY = 'bpncm_player_state'
const MAXQ = 500 // 队列最多存这么多首
const WIN_BEFORE = 200 // 窗口以当前曲为界，前面保留的条数（后面就是 MAXQ - WIN_BEFORE）

/** 歌曲对象 → 快照条目（够队列页/播放页/恢复播放用即可，别存整包原始 JSON） */
export function slimSong(s) {
  if (!s || !s.id) return null
  const o = {
    id: s.id,
    name: s.name || '',
    artist: s.artist || '',
    album: s.album || '',
    albumId: s.albumId || 0,
    cover: s.cover || '',
    durationMs: s.durationMs || 0,
    fee: s.fee === undefined ? 0 : s.fee
  }
  if (s.aliases && s.aliases.length) o.aliases = s.aliases.slice ? s.aliases.slice() : s.aliases
  return o
}

/** 下标夹紧到 [0, n-1] */
function clampIndex(i, n) {
  if (!(i >= 0)) i = 0
  if (i > n - 1) i = n - 1
  return i
}

/** 窗口起点：以当前下标附近 WIN_BEFORE 条为界，最多 max 条（队列与随机 id 序列共用同一规则） */
function windowStart(n, i, max) {
  if (n <= max) return 0
  let start = i - WIN_BEFORE
  if (start < 0) start = 0
  if (start > n - max) start = n - max
  return start
}

/**
 * 队列快照：返回 {list, index}，index 是当前曲在 list 里的新下标。
 * 队列超过 MAXQ 时取当前曲附近的窗口（列表项无效的会被剔除，index 随之重指）。
 */
export function slimQueue(queue, index) {
  const n = (queue && queue.length) || 0
  if (!n) return { list: [], index: 0 }
  const i = clampIndex(index, n)
  const start = windowStart(n, i, MAXQ)
  const end = Math.min(n, start + MAXQ)
  const list = []
  let newIndex = -1
  for (let k = start; k < end; k++) {
    const it = slimSong(queue[k])
    if (!it) continue
    if (k === i) newIndex = list.length
    list.push(it)
  }
  if (newIndex < 0) newIndex = 0
  return { list: list, index: newIndex }
}

/**
 * 随机模式的临时队列 → id 序列（保持播放顺序）。窗口规则同 slimQueue（当前曲附近）；
 * id 很小，实际上很少触发上限。恢复时由 player.rebuildShuffle 按 id 映射回歌曲对象。
 */
export function slimShuffle(list, index) {
  const n = (list && list.length) || 0
  if (!n) return []
  const i = clampIndex(index, n)
  const start = windowStart(n, i, MAXQ)
  const end = Math.min(n, start + MAXQ)
  const out = []
  for (let k = start; k < end; k++) {
    if (list[k] && list[k].id) out.push(list[k].id)
  }
  return out
}

/* ---- 落盘：串行 + 合并写 ---- */
let writing = false
let pending = null // 写盘期间来的新快照只留最新一份
let wiping = false // 有一次「清空」请求等着处理（与写快照共用同一条串行通道）

async function write() {
  if (writing) return
  writing = true
  try {
    while (pending || wiping) {
      if (wiping) {
        wiping = false
        pending = null // 排队中的快照比「清空」更旧，写了等于白清
        try {
          await removeStorage(KEY)
        } catch (e) {}
        log('psession', '清空快照')
        continue
      }
      const rec = pending
      pending = null
      let raw = ''
      try {
        raw = JSON.stringify(rec)
      } catch (e) {
        break
      }
      let ok = false
      try {
        ok = await setStorage(KEY, raw)
      } catch (e) {
        ok = false
      }
      log('psession', '存: 第 ' + (rec.index + 1) + '/' + rec.queue.length + ' 首 @' +
        Math.round(rec.positionMs / 1000) + 's len=' + raw.length +
        (rec.shuffle ? ' 随机序 ' + rec.shuffle.length + ' 个 id' : '') + (ok ? '' : ' 失败'))
    }
  } finally {
    writing = false
  }
}

/** 保存一份快照（合并写：连续调用只有最新一份真正落盘）。**绝不抛出** —— player 在播放流程里调 */
export function save(rec) {
  if (!rec) return
  pending = rec
  try {
    write().catch(function (e) {
      log('psession', '写盘异常: ' + ((e && e.message) || e))
    })
  } catch (e) {
    log('psession', '写盘异常: ' + ((e && e.message) || e))
  }
}

/**
 * 清空已保存的快照（**播放队列被清空时必须调**）：
 * 不删的话下次启动 loadLastState 会把刚清空的旧队列恢复回来，用户看到「清完又回来了」。
 * 走 save 同一条串行通道，避免与正在进行的写盘互相覆盖。
 */
export function clear() {
  wiping = true
  try {
    write()['catch'](function (e) {
      log('psession', '清空异常: ' + ((e && e.message) || e))
    })
  } catch (e) {}
}

/** 读取上次快照；无记录/脏数据返回 null */
export async function load() {
  try {
    const raw = await getStorage(KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    const song = o && slimSong(o.song)
    if (!song) return null
    const queue = []
    if (o.queue && o.queue.length) {
      for (let i = 0; i < o.queue.length; i++) {
        const s = slimSong(o.queue[i])
        if (s) queue.push(s)
      }
    }
    if (!queue.length) queue.push(song)
    const shuffle = []
    if (o.shuffle && o.shuffle.length) {
      for (let i = 0; i < o.shuffle.length; i++) {
        const id = o.shuffle[i]
        if (id !== undefined && id !== null && id !== '') shuffle.push(id)
      }
    }
    return {
      song: song,
      queue: queue,
      index: typeof o.index === 'number' ? o.index : 0,
      positionMs: typeof o.positionMs === 'number' ? o.positionMs : 0,
      playing: !!o.playing,
      at: o.at || 0,
      shuffle: shuffle, // 随机模式的临时队列（id 序列），空数组 = 无
      src: typeof o.src === 'string' ? o.src : '' // 队列来源标记（'downloads' 等；老快照无此字段）
    }
  } catch (e) {
    log('psession', '读取失败，按无记录处理: ' + ((e && e.message) || e))
    return null
  }
}
