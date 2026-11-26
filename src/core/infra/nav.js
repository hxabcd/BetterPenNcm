
// 页面导航（路由层）：逻辑页名 → 实例槽位。
// 平台 navTo 语义（S7 端 libfalcon.so 的 FalconApp::launchPage 反汇编 + 设备端生命周期分发实证）：
//   - 一个 page key 在 app 内只有一个实例，页面栈是实例序列；
//   - navTo(key) 命中「已在栈里」的 key 时，把该页上面的页面全部销毁、旧实例挪回栈顶，
//     只补发 onNewOptions —— 不重新挂载；命中当前页则原地补发；
//   - finish() 关闭当前页，露出栈里前一个页面。
//   即 navTo 是「回到那一页」不是「再开一层」：页面只写 go('<逻辑页名>')、返回只写 this.$page.finish()。
// 参数通道：真机 navTo 的参数不可靠，本模块按槽位 key 记账（另按逻辑页名兜底，兼容写死页名的写法）；
// pending 覆盖式、不消费，以兼容「页面会挂两遍」。
import { log } from './log.js'
import { markVisible, dropPage } from './vis.js'

// 逻辑页 → 实例槽位表。
//   slots[0] 必须与逻辑页同名（app.json 基础 key），其余为 app.json 里的别名 key；
//   reuse: true = 全局目的地页，命中栈内实例时按平台语义回退，不再叠新层。
// 槽位数按「可能同时存活的不同视图」估计：同一逻辑页的重复视图也各占一层（标准 push 语义）。
// 高频往返/可循环互相跳转的页（list / songinfo / album / artist）给 6 个（artist↔album、
// songinfo↔artist 循环是最容易堆深的路径），playlists 4 个，其余 1~3 个。
// 新增页面：在 app.json 注册基础 key + 槽位 key，并在这里登记；scripts/theme_verify.py 会校验一致性。
const PAGES = {
  // 根页（不可作为导航目标；保留登记供静态检查识别）
  index: { slots: ['index'], reuse: true },

  // 播放页：全局目的地 —— 已在栈中时回退到它（点行为「回播放页」，不叠第二层播放页）
  player: { slots: ['player'], reuse: true },

  playlists: { slots: ['playlists', 'playlists2', 'playlists3', 'playlists4'] }, // 浏览 / 添加到歌单选择 / 歌手专辑
  list: { slots: ['list', 'list2', 'list3', 'list4', 'list5', 'list6'] }, // 搜索 / 歌单曲目 / 歌手曲目 / 历史…
  songinfo: { slots: ['songinfo', 'songinfo2', 'songinfo3', 'songinfo4', 'songinfo5', 'songinfo6'] },
  album: { slots: ['album', 'album2', 'album3', 'album4', 'album5', 'album6'] },
  artist: { slots: ['artist', 'artist2', 'artist3', 'artist4', 'artist5', 'artist6'] },
  queue: { slots: ['queue', 'queue2'] }, // 播放页 ↔ 队列会互相往返，需要第二层

  playeropts: { slots: ['playeropts'] },
  setdl: { slots: ['setdl'] },
  setlook: { slots: ['setlook'] },
  plinfo: { slots: ['plinfo', 'plinfo2'] },
  login: { slots: ['login'] },
  settings: { slots: ['settings'] },
  account: { slots: ['account'] },
  storage: { slots: ['storage'] },
  downloads: { slots: ['downloads'] },
  dlplaylists: { slots: ['dlplaylists'] },
  dltracks: { slots: ['dltracks', 'dltracks2'] },
  dlartists: { slots: ['dlartists'] },
  dlalbums: { slots: ['dlalbums'] },
  dlqueue: { slots: ['dlqueue'] },
}

// 槽位 key → 逻辑页（由 PAGES 反推，避免手写两份）
const SLOT_LOGICAL = {}
for (const logical in PAGES) {
  const def = PAGES[logical]
  for (let i = 0; i < def.slots.length; i++) SLOT_LOGICAL[def.slots[i]] = logical
}

// 当前存活的页面实例：[{ page, key, logical }]（挂载 / 页面 load 顺序，低 → 高）
const LIVE = []

// 已选中、尚未确认加载的槽位：slotKey -> true（防 navTo 失败后槽位永久占用）
const RESERVED = {}

// 槽位预留的超时计时器：slotKey -> handle（与 RESERVED 分开存，句柄值 0 也不会被当空闲）
const RESERVE_TIMERS = {}

// 参数通道（见文件头）：按槽位 key 与逻辑页名各记一份
const PENDING_BY_KEY = {}
const PENDING_BY_LOGICAL = {}

// 连点合并：logical -> { sig, ts }。同一逻辑页 + 同一参数在 DEDUPE_MS 内重复 go() 只生效一次
const LAST_GO = {}

const RESERVE_TIMEOUT_MS = 5000
const DEDUPE_MS = 500

function paramsSig(p) {
  try {
    return JSON.stringify(p || {})
  } catch (e) {
    return ''
  }
}

function liveIndexOf(page) {
  for (let i = 0; i < LIVE.length; i++) if (LIVE[i].page === page) return i
  return -1
}

function slotBusy(slot) {
  if (RESERVED[slot]) return true
  for (let i = 0; i < LIVE.length; i++) if (LIVE[i].key === slot) return true
  return false
}

// 最上层的同类实例 key（LIVE 顺序 = 压栈顺序；槽位耗尽时复用它，弹掉的层最少）
function topLiveSlot(def) {
  for (let i = LIVE.length - 1; i >= 0; i--) {
    for (let j = 0; j < def.slots.length; j++) {
      if (def.slots[j] === LIVE[i].key) return LIVE[i].key
    }
  }
  return ''
}

function pickSlot(def) {
  for (let i = 0; i < def.slots.length; i++) {
    if (!slotBusy(def.slots[i])) return def.slots[i]
  }
  return ''
}

function reserve(slot) {
  RESERVED[slot] = true
  RESERVE_TIMERS[slot] = setTimeout(function () {
    release(slot)
    log('nav', 'reserve-timeout ' + slot)
  }, RESERVE_TIMEOUT_MS)
}

function release(slot) {
  const t = RESERVE_TIMERS[slot]
  if (t) {
    try {
      clearTimeout(t)
    } catch (e) {}
    delete RESERVE_TIMERS[slot]
  }
  delete RESERVED[slot]
}

function setPending(key, logical, params) {
  const p = params || {}
  PENDING_BY_KEY[key] = p
  PENDING_BY_LOGICAL[logical] = p
}

// 底层 navTo。返回 false 表示同步抛错（调用方据此立即释放预留槽位）
function navRaw(key, params) {
  try {
    /* global $falcon */
    $falcon.navTo(key, params || {})
    return true
  } catch (e) {
    log('nav', 'navTo 异常 ' + key + ': ' + ((e && e.message) || e))
    return false
  }
}

// 压入一层逻辑页。params 供目标页 paramsFor() 读取。
// 页面代码只传逻辑页名（app.json 基础 key），实例槽位由本模块分配
export function go(page, params) {
  const logical = String(page || '')
  const def = PAGES[logical]
  const p = params || {}
  if (!def) {

    log('nav', 'go ' + logical + ' (未登记逻辑页，直接 navTo)')
    setPending(logical, logical, p)
    navRaw(logical, p)
    return
  }

  // 连点合并：同一逻辑页 + 同一参数、且上一次 go() 在其槽位加载完成前（DEDUPE_MS 内）又点了一次
  // → 忽略后一发。S7 交互慢，「点一下没反应再点一下」很常见；旧平台语义第二次是复用不会叠层，
  // 新语义下不合并会让同页真叠两层（每层页面组件树可达数百 KB）
  const sig = paramsSig(p)
  const last = LAST_GO[logical]
  const now = Date.now()
  if (last && last.sig === sig && now - last.ts < DEDUPE_MS) {
    log('nav', 'go ' + logical + ' (dup-ignore: ' + (now - last.ts) + 'ms 内连点)')
    return
  }
  LAST_GO[logical] = { sig: sig, ts: now }

  const base = def.slots[0]
  if (def.reuse) {
    setPending(base, logical, p)
    log('nav', 'go ' + logical + ' -> ' + base + ' (reuse)')
    navRaw(base, p)
    return
  }
  const slot = pickSlot(def)
  if (!slot) {
    // 槽位耗尽（正常流程不应出现）：复用最上层的同类实例 —— 平台只会弹掉它上面的页面，
    // 比退回最旧实例（会弹掉 8~11 层）代价小得多。注意页面 mounted 才读参数，
    // 复用实例的内容可能停在旧参数；日志可据此排查，必要时加槽位
    const top = topLiveSlot(def)
    const target = top || base
    setPending(target, logical, p)
    log('nav', 'go ' + logical + ' (degrade: 槽位耗尽 → 复用最上层同类实例 ' + target +
      '；会弹掉其上层页面且内容可能停留在旧参数)')
    navRaw(target, p)
    return
  }
  reserve(slot)
  setPending(slot, logical, p)
  log('nav', 'go ' + logical + ' -> ' + slot + ' (push)')
  if (!navRaw(slot, p)) release(slot) 
}

// 目标页 onLoad / mounted 里调用：navTo options 优先，空则回退 pending。
// page 可以传槽位 key（`$page.$pageName`，精确）或逻辑页名（兼容写死页名的页面）
export function paramsFor(page, options) {
  const o = options || {}
  try {
    if (Object.keys(o).length > 0) return o
  } catch (e) {}
  const key = String(page || '')
  if (PENDING_BY_KEY[key]) return PENDING_BY_KEY[key]
  if (PENDING_BY_LOGICAL[key]) return PENDING_BY_LOGICAL[key]
  return {}
}

function noteLive(page) {
  if (!page) return
  const key = String(page.$pageName || '')
  if (!key) return
  release(key)
  if (liveIndexOf(page) < 0) {
    LIVE.push({ page: page, key: key, logical: SLOT_LOGICAL[key] || '' })
    log('nav', 'page-load ' + key + ' live=' + LIVE.length + ' ' + stackKeysJson())
  }
  // 新页面进栈 = 它一定在最上面：标为可见（hide 通道万一漏派发，这里也能救回来）
  markVisible(page, true, 'load')
}

function noteDead(page) {
  if (!page) return
  const i = liveIndexOf(page)
  if (i < 0) return
  const key = LIVE[i].key
  LIVE.splice(i, 1)
  log('nav', 'page-unload ' + key + ' live=' + LIVE.length + ' ' + stackKeysJson())

  // 退栈后新的栈顶是「刚露出来」的那一页：重新标可见。
  // 兜底价值：若平台在某些路径上只派发 hide、不派发对应的 show，被盖住的页会永远停在
  // 不可见状态（页面不刷新）—— 这一句保证任何一次退栈都能把栈顶救回来
  if (LIVE.length) markVisible(LIVE[LIVE.length - 1].page, true, 'top')
  dropPage(page)
}

function noteOptions(page) {
  if (!page) return
  log('nav', 'page-options ' + String(page.$pageName || ''))
}

// app 级页面生命周期（app.js 的 onPageLifeCycle 转发）：主记账通道。
// options = { page, lifeCycle }，lifeCycle: load | newOptions | show | hide | unload
export function noteLifeCycle(options) {
  try {
    const o = options || {}
    const page = o.page
    if (!page) return
    if (o.lifeCycle === 'load') noteLive(page)
    else if (o.lifeCycle === 'unload') noteDead(page)
    else if (o.lifeCycle === 'newOptions') noteOptions(page)
    else if (o.lifeCycle === 'show') markVisible(page, true, 'show')
    else if (o.lifeCycle === 'hide') markVisible(page, false, 'hide')
  } catch (e) {
    log('nav', '生命周期记账异常: ' + ((e && e.message) || e))
  }
}

// 页面根实例挂载时调用（pageFrameMixin）：兜底记账 —— App.onPageLifeCycle 若不可用，
// 页面挂载 + `$page.on('unload')` 也能维持槽位占用与释放。按 page 对象身份去重，
// 「页面会挂两遍」/双通道同时记账都是幂等的。
// 只认页面根实例（`$root === vm`）；若平台把页面组件套在 wrapper 下该判定不成立，
// 兜底不生效（主通道仍覆盖），首次成功/跳过各打一条 [nav] 日志便于真机核对
let attachOkLogged = false
let attachSkipLogged = false
export function attachPage(vm) {
  try {
    if (!vm || !vm.$root || vm.$root !== vm) {
      if (!attachSkipLogged) {
        attachSkipLogged = true
        log('nav', 'attach-skip（非页面根实例；兜底通道未生效，主通道仍记账）')
      }
      return
    }
    const page = vm.$page
    if (!page || typeof page.on !== 'function') return
    noteLive(page)
    page.on('unload', function () {
      noteDead(page)
    })
    if (!attachOkLogged) {
      attachOkLogged = true
      log('nav', 'attach-ok（页面挂载兜底记账生效）')
    }
  } catch (e) {
    log('nav', 'attachPage 异常: ' + ((e && e.message) || e))
  }
}

function stackKeysJson() {
  const out = []
  for (let i = 0; i < LIVE.length; i++) out.push(LIVE[i].key)
  return '[' + out.join(',') + ']'
}

// 当前页面栈的槽位 key（低 → 高）。只读副本，供探针与日志核对
export function stackKeys() {
  const out = []
  for (let i = 0; i < LIVE.length; i++) out.push(LIVE[i].key)
  return out
}
