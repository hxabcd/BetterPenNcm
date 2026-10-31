/**
 * 播放历史（纯本地记录）—— 模块级单例 + storage 持久化
 *
 * 设计要点：
 *   - **去重**：同一首歌重复播放 → 保留最近一次（移除旧条目、unshift 到最前并刷新 at）
 *   - **记录点**在 player.js playAt() 的三个「真正出声」分支（缓存命中 / 流播成功 /
 *     下载完成）；暂停续播、seek、改倍速不算新播放，不经过那里
 *   - **enrich**：搜索结果的详情接口（getSongDetail）回来后补上缺失字段（封面等），
 *     不动 at、不新增条目 —— 记录点在出声瞬间必须同步快照，详情是异步的
 *   - 落盘是**串行 + 合并写**：record 在 playAt 调用栈里同步执行，连点快切时
 *     不能每次都整份 JSON.stringify + setStorage（一次在飞 + 一次补写）
 *   - 写入失败静默降级（内存仍有效，与 store.js 同策略）。MAX=200：真机日志里
 *     len 超 ~60KB 或切歌有可感卡顿就把 MAX 降到 100（加载时已按 MAX 截断，无需迁移）
 *   - 变更广播 $falcon.trigger('bpncm:playhist')：首页卡片据此刷新。
 *     历史列表页**刻意不订阅**（重建 50 行会重下封面、滚动位置可能被打回顶部），
 *     见 list.vue 的说明
 */
import { getStorage, setStorage } from '../store.js'
import { log } from '../log.js'

const KEY = 'bpncm_playhist'
const MAX = 200

let items = [] // 新 → 旧
let loaded = false
let loadPromise = null

/* ---- 落盘：串行 + 合并写（writing 期间新的 persist 只置 dirty，写完补一次）---- */
let writing = false
let dirty = false

async function persist() {
  if (writing) {
    dirty = true
    return
  }
  writing = true
  try {
    do {
      dirty = false
      let raw = ''
      try {
        raw = JSON.stringify(items)
      } catch (e) {
        break
      }
      let ok = false
      try {
        ok = await setStorage(KEY, raw)
      } catch (e) {
        ok = false
      }
      log('hist', '写入 n=' + items.length + ' len=' + raw.length + (ok ? '' : ' 失败'))
    } while (dirty)
  } finally {
    writing = false
  }
}

function notify() {
  try {
    /* global $falcon */
    $falcon.trigger('bpncm:playhist')
  } catch (e) {}
}

/** 提取要存的字段（歌曲对象 → 历史条目）。at = 记录时间，列表默认排序就是它 */
function slim(s) {
  const aliases = []
  if (s.aliases && s.aliases.length) {
    for (let i = 0; i < s.aliases.length; i++) aliases.push(s.aliases[i])
  }
  return {
    id: s.id,
    name: s.name || '',
    artist: s.artist || '',
    album: s.album || '',
    albumId: s.albumId || 0,
    cover: s.cover || '',
    durationMs: s.durationMs || 0,
    fee: s.fee === undefined ? 0 : s.fee,
    aliases: aliases,
    at: Date.now()
  }
}

/** 把 src 里有、it 里为空的字段补进 it（record 时用旧条目补、enrich 时用详情数据补）。返回是否补过 */
function fillFrom(it, src) {
  if (!src) return false
  let changed = false
  if (!it.cover && src.cover) {
    it.cover = src.cover
    changed = true
  }
  if (!it.album && src.album) {
    it.album = src.album
    changed = true
  }
  if (!it.albumId && src.albumId) {
    it.albumId = src.albumId
    changed = true
  }
  if (!it.durationMs && src.durationMs) {
    it.durationMs = src.durationMs
    changed = true
  }
  if (!it.fee && src.fee) {
    it.fee = src.fee
    changed = true
  }
  if ((!it.aliases || !it.aliases.length) && src.aliases && src.aliases.length) {
    it.aliases = src.aliases.slice ? src.aliases.slice() : src.aliases
    changed = true
  }
  return changed
}

/** 是否已加载（首页卡片用它区分「未加载 '—'」与「空 '暂无记录'」） */
export function isLoaded() {
  return loaded
}

/** 懒加载（幂等，只读一次）；boot 里 await 它，页面侧可随时读 */
export function load() {
  if (!loadPromise) {
    loadPromise = (async function () {
      try {
        const raw = await getStorage(KEY)
        if (raw) {
          const arr = JSON.parse(raw)
          if (arr && arr.length) {
            const out = []
            for (let i = 0; i < arr.length && out.length < MAX; i++) {
              const it = arr[i]
              if (it && it.id) out.push(it) // 滤掉脏数据
            }
            items = out
          }
        }
      } catch (e) {
        log('hist', '读取失败，按空历史处理: ' + ((e && e.message) || e))
      }
      loaded = true
      log('hist', '载入 n=' + items.length)
      notify() // 首页可能已挂载（它首读时还是未加载态）
      return items
    })()
  }
  return loadPromise
}

/**
 * 记录一次播放：同 id 去重（旧条目移到最前并刷新 at）。
 * **绝不抛出** —— 它在 player.playAt 的调用栈里同步执行；落盘异步、失败静默。
 */
export function record(song) {
  try {
    if (!song || !song.id) return
    let old = null
    const out = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === song.id) {
        if (!old) old = items[i] // 去重：同 id 只留最近一次（旧条目留给新快照补缺）
        continue
      }
      out.push(items[i])
    }
    const it = slim(song)
    if (old) fillFrom(it, old) // 新快照缺的字段（如搜索结果没拿到封面）用旧的补
    out.unshift(it)
    if (out.length > MAX) out.length = MAX
    items = out
    notify()
    persist()
    log('hist', '记录: ' + it.name + '（共 ' + items.length + '）')
  } catch (e) {
    log('hist', '记录失败: ' + ((e && e.message) || e))
  }
}

/** 详情接口回来后补条目缺失字段（封面/时长/别名…）；只在该 id 已在历史里时生效 */
export function enrich(song) {
  try {
    if (!song || !song.id || !items.length) return
    let hit = null
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === song.id) {
        hit = items[i]
        break
      }
    }
    if (!hit) return
    if (fillFrom(hit, song)) {
      notify()
      persist()
      log('hist', '补全: ' + hit.name)
    }
  } catch (e) {}
}

/** 历史列表（新 → 旧）的**浅拷贝** —— 页面不要就地改条目（那是单例里的同一份对象） */
export function list() {
  return items.slice()
}

/**
 * 今天听过多少首（首页「播放历史」卡副行用，改成这个）。
 *
 * 口径 = **本地日期**的 00:00 起算，只数 `at` 落在今天的条目；条目天然按 at 倒序（record 只 unshift、
 * enrich 不动 at、remove 保序），所以扫到第一条更早的就能提前收工。
 * ⚠ 上限受 MAX(=200) 约束：一天内播超过 200 首会封顶，计数不会更大（真要精确得另存日计数）。
 */
export function countToday(now) {
  try {
    const d = new Date(now === undefined || now === null ? Date.now() : now)
    d.setHours(0, 0, 0, 0)
    const t0 = d.getTime()
    let n = 0
    for (let i = 0; i < items.length; i++) {
      if (items[i].at >= t0) n++
      else break
    }
    return n
  } catch (e) {
    return 0
  }
}

/** 清空（发布事件让首页卡片归零 —— 它正压在本页下面） */
export function clear() {
  try {
    items = []
    notify()
    persist()
    log('hist', '清空')
  } catch (e) {}
}

/**
 * 移除若干条（曲目列表页多选「删除」在 kind=history 时用）。
 * **全选 + 删除 = 清空队列**。
 * 返回移除条数；无变更不写盘。
 */
export function remove(ids) {
  try {
    if (!ids || !ids.length) return 0
    const drop = {}
    for (let i = 0; i < ids.length; i++) drop[String(ids[i])] = 1
    const out = []
    for (let i = 0; i < items.length; i++) {
      if (!drop[String(items[i].id)]) out.push(items[i])
    }
    const n = items.length - out.length
    if (!n) return 0
    items = out
    notify()
    persist()
    log('hist', '移除 ' + n + ' 条（剩 ' + items.length + '）')
    return n
  } catch (e) {
    return 0
  }
}
