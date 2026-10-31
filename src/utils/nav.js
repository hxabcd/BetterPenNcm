/**
 * 页面导航（路由层）—— 把平台的「页面 key 单实例 + 回退式 navTo」补成标准的「压栈 / 出栈」语义。
 *
 * 平台模型（S7 端 libfalcon.so 的 FalconApp::launchPage 反汇编 + 设备端 jsfm-nvue 生命周期分发实证）：
 *   - 一个 page key 在 app 内只有**一个实例**，页面栈是实例序列；
 *   - navTo(key, params) 命中「已在栈里」的 key 时：把该页**上面的页面全部销毁**（逐页 FalconPage::autoPop()，
 *     默认开启且本项目从未关闭），把旧实例挪回栈顶，只补发 onNewOptions —— **不重新挂载**；
 *     命中「当前页」时只原地补发 onNewOptions；
 *   - finish() 关闭当前页，露出栈里前一个页面。
 * 也就是说平台的 navTo 是「回到 / 重进那一页」，不是「再开一层」。而本工程页面代码（mounted 里读参数、
 * 返回用 $page.finish()）是按标准 push/pop 写的 —— 直接用平台语义就会出现「层级退回」：目标页恰好已在栈里时，
 * 中间层被销毁、旧实例参数不更新，返回落错层。
 *
 * 本模块的解法：**逻辑页 → 实例槽位**。
 *   - 页面代码只认识**逻辑页名**（app.json 里该 .vue 的基础 key）：go('list', params) 表达「压入一层 list」。
 *   - 每个逻辑页在 app.json 里预编译若干别名 key（同一 .vue 各编译一份 `.falcon_/<key>.js.bin`，
 *     别名模块只是 re-export，产物只有几百字节），作为该逻辑页的实例槽位。
 *   - go() 总是挑一个**当前不在栈里**的槽位 navTo —— 平台必然走「新建实例」分支，于是得到真正的 push；
 *     返回（finish）关闭当前页得到 pop，**不会销毁调用页**。
 *   - 实例存活由页面生命周期记账（App.onPageLifeCycle 主通道 + pageFrameMixin 挂载时 attachPage 兜底）。
 *   - player 是全局目的地页，保留平台语义（已在栈中则回退到它），其余页一律压栈。
 *   - 连点合并：同一逻辑页 + 同一参数在 500ms 内重复 go() 只生效一次（S7 慢，用户「没反应再点一下」
 *     很常见；不合并会让同一页真叠两层）。日志 `dup-ignore` 可查。
 *   - 槽位耗尽（同一逻辑页同时开得太多，正常流程不应出现，见 docs/页面导航.md 的边界说明）时
 *     复用**最上层**的同类实例（平台只弹掉它上面的页面，代价最小），记 `degrade` 日志；
 *     此时页面 mounted 已读过旧参数，内容可能不是最新参数 —— 属异常路径，优先加槽位。
 *   - `scripts/theme_verify.py` 会巡检逻辑页名与槽位配置。
 *
 * 参数通道：真机 navTo 的参数不可靠（见 git 历史与 PenMusic 实证），仍走本模块的 pending 记录：
 * 按**槽位 key** 记账，另按**逻辑页名**兜底（兼容页面里写死逻辑页名的写法）；
 * pending 覆盖式、不消费，以兼容「页面会挂两遍」。
 */
import { log } from './log.js'

/**
 * 逻辑页 → 实例槽位表。
 *   slots[0] 必须与逻辑页同名（app.json 基础 key），其余为 app.json 里的别名 key；
 *   reuse: true = 全局目的地页，命中栈内实例时按平台语义回退，不再叠新层。
 *
 * 槽位数按「可能同时存活的不同视图」估计：同一逻辑页的重复视图也各占一层（标准 push 语义）。
 * 高频往返/可循环互相跳转的页（list / songinfo / album / artist）给 6 个（artist↔album、
 * songinfo↔artist 循环是最容易堆深的路径），playlists 4 个，其余 1~3 个。
 * 新增页面：在 app.json 注册基础 key + 槽位 key，并在这里登记；`python scripts/theme_verify.py` 会校验一致性。
 */
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

/** 槽位 key → 逻辑页（由 PAGES 反推，避免手写两份） */
const SLOT_LOGICAL = {}
for (const logical in PAGES) {
  const def = PAGES[logical]
  for (let i = 0; i < def.slots.length; i++) SLOT_LOGICAL[def.slots[i]] = logical
}

/** 当前存活的页面实例：[{ page, key, logical }]（挂载 / 页面 load 顺序，低 → 高） */
const LIVE = []
/** 已选中、尚未确认加载的槽位：slotKey -> true（防 navTo 失败后槽位永久占用） */
const RESERVED = {}
/** 槽位预留的超时计时器：slotKey -> handle（与 RESERVED 分开存，句柄值 0 也不会被当空闲） */
const RESERVE_TIMERS = {}
/** 参数通道（见文件头）：按槽位 key 与逻辑页名各记一份 */
const PENDING_BY_KEY = {}
const PENDING_BY_LOGICAL = {}
/** 连点合并：logical -> { sig, ts }。同一逻辑页 + 同一参数在 DEDUPE_MS 内重复 go() 只生效一次 */
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

/** 最上层的同类实例 key（LIVE 顺序 = 压栈顺序；槽位耗尽时复用它，弹掉的层最少） */
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

/** 底层 navTo。返回 false 表示同步抛错（调用方据此立即释放预留槽位） */
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

/**
 * 压入一层逻辑页。params 供目标页 `paramsFor()` 读取。
 * 页面代码只传**逻辑页名**（app.json 基础 key），实例槽位由本模块分配。
 */
export function go(page, params) {
  const logical = String(page || '')
  const def = PAGES[logical]
  const p = params || {}
  if (!def) {
    // 未登记的逻辑页（临时页 / 探针）：退回平台语义并留日志，静态自检会拦这种调用。
    log('nav', 'go ' + logical + ' (未登记逻辑页，直接 navTo)')
    setPending(logical, logical, p)
    navRaw(logical, p)
    return
  }
  // 连点合并：同一逻辑页 + 同一参数、且上一次 go() 在其槽位加载完成前（DEDUPE_MS 内）又点了一次
  // → 忽略后一发。S7 交互慢，「点一下没反应再点一下」很常见；旧平台语义第二次是复用不会叠层，
  // 新语义下不合并会让同页真叠两层（每层页面组件树可达数百 KB）。
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
    /* 槽位耗尽（正常流程不应出现，见 docs/页面导航.md）：复用**最上层**的同类实例 ——
       平台只会弹掉它上面的页面，比退回最旧实例（会弹掉 8~11 层）代价小得多。
       注意页面 mounted 才读参数，复用实例的内容可能停在旧参数；日志可据此排查，必要时加槽位。 */
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
  if (!navRaw(slot, p)) release(slot) // navTo 同步异常：立刻释放，不等超时
}

/**
 * 目标页 onLoad / mounted 里调用：navTo options 优先，空则回退 pending。
 * page 可以传**槽位 key**（`$page.$pageName`，精确）或**逻辑页名**（兼容写死页名的页面）。
 */
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

/* ================= 页面实例记账 ================= */

function noteLive(page) {
  if (!page) return
  const key = String(page.$pageName || '')
  if (!key) return
  release(key)
  if (liveIndexOf(page) < 0) {
    LIVE.push({ page: page, key: key, logical: SLOT_LOGICAL[key] || '' })
    log('nav', 'page-load ' + key + ' live=' + LIVE.length + ' ' + stackKeysJson())
  }
}

function noteDead(page) {
  if (!page) return
  const i = liveIndexOf(page)
  if (i < 0) return
  const key = LIVE[i].key
  LIVE.splice(i, 1)
  log('nav', 'page-unload ' + key + ' live=' + LIVE.length + ' ' + stackKeysJson())
}

function noteOptions(page) {
  if (!page) return
  log('nav', 'page-options ' + String(page.$pageName || ''))
}

/**
 * app 级页面生命周期（app.js 的 onPageLifeCycle 转发）：主记账通道。
 * options = { page, lifeCycle }，lifeCycle: load | newOptions | show | hide | unload
 */
export function noteLifeCycle(options) {
  try {
    const o = options || {}
    const page = o.page
    if (!page) return
    if (o.lifeCycle === 'load') noteLive(page)
    else if (o.lifeCycle === 'unload') noteDead(page)
    else if (o.lifeCycle === 'newOptions') noteOptions(page)
  } catch (e) {
    log('nav', '生命周期记账异常: ' + ((e && e.message) || e))
  }
}

/**
 * 页面根实例挂载时调用（pageFrameMixin）：兜底记账 —— App.onPageLifeCycle 若不可用，
 * 页面挂载 + `$page.on('unload')` 也能维持槽位占用与释放。按 page 对象身份去重，
 * 「页面会挂两遍」/双通道同时记账都是幂等的。
 * 只认页面根实例（`$root === vm`）；若平台把页面组件套在 wrapper 下该判定不成立，
 * 兜底不生效（主通道仍覆盖），首次成功/跳过各打一条 [nav] 日志便于真机核对。
 */
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

/* ================= 诊断（探针 / 日志用） ================= */

function stackKeysJson() {
  const out = []
  for (let i = 0; i < LIVE.length; i++) out.push(LIVE[i].key)
  return '[' + out.join(',') + ']'
}

/** 当前页面栈的槽位 key（低 → 高）。只读副本，供探针与日志核对。 */
export function stackKeys() {
  const out = []
  for (let i = 0; i < LIVE.length; i++) out.push(LIVE[i].key)
  return out
}

/** 逻辑页 → 槽位表（只读副本，供自检脚本 / 探针核对配置；目前无生产调用方，预留诊断） */
export function pageTable() {
  const out = {}
  for (const logical in PAGES) out[logical] = PAGES[logical].slots.slice()
  return out
}
