// 播放器（拆分自 player.js）：起播/暂停/seek/倍速重开与自然连播。

import config from '../../core/infra/config.js'
import { fmtDur } from '../../core/infra/format.js'
import { log } from '../../core/infra/log.js'
import { getSongDetail } from '../ncm/api.js'
import { cachedPath, ensureCached, touchPlayCache } from './download.js'
import { enrich, record } from './history.js'
import { playFile, stop } from './sound.js'
import { persist } from './player-persist.js'
import { shuffleNext, shufflePrev } from './player-shuffle.js'
import { ensureStreamUrl, kickCache, needLocal, progressStatus } from './player-source.js'
import { BIGQ, END_DEDUP_MS, S, SAVE_MS, SAVE_MS_BIGQ, URL_FRESH_MS, activeList, emit, inShuffle, stopTimer } from './player-state.js'


export function requestEnd() {
  const now = Date.now()
  if (now - S.endAt < END_DEDUP_MS) return
  S.endAt = now
  S.isPlaying = false
  stopTimer()
  log('player', '播放结束: ' + S.cur.name)
  handleEnded()
}

/* 「退出时暂停音乐」（config.pauseOnExit，默认开，设置页可关）：退出前调一次，幂等。
 * 必须主动暂停的原因：SoundPlayer 是**独立的系统进程**（guardian_run 守护），应用退出
 * （closeApp/onDestroy）不会带走它 —— 不 stop 的话音乐会在退出后继续放，而那时应用已经不在了。
 * 走 pause（toggle 的暂停分支）而不是 stopPlay：暂停保留当前进度，下次打开按 ▶ 从原处续播。
 * 兜底超时 800ms：调用方会 await 它，原生调用万一卡住也不能把「退出」卡死。 */
export function pauseForExit() {
  if (!config.get('pauseOnExit')) return Promise.resolve(false)

  // 先作废在途的播放启动（playAt / 续播的每个 await 之后都会对 gen）—— 否则「点歌刚发出、
  // 还没出声」时退出，那个流程会在我们 stop 之后才把原生播放开起来
  
  S.gen++
  if (!S.cur.id || S.paused) return Promise.resolve(false) 
  log('player', '退出前暂停: ' + S.cur.name)
  const job = toggle().then(function () { return true }, function () { return false })
  return Promise.race([job, new Promise(function (res) {
    setTimeout(function () { res(false) }, 800)
  })])
}

// 墙钟推算当前播放位置：**必须乘倍速**（1.5x 时媒体位置走得比墙钟快）
function elapsed() {
  return S.baseMs + (Date.now() - S.startedAt) * S.rate
}

function startTimer() {
  stopTimer()
  S.timer = setInterval(function () {
    if (S.paused) return
    const el = elapsed()
    S.positionMs = el
    if (S.cur.durationMs && el > S.cur.durationMs + 500) {
      S.positionMs = S.cur.durationMs
      // EndChanged 的兜底：事件万一不来，墙钟也会连播
      requestEnd() 
      return
    }

    // 流播起播比本地慢（冷 CDN 实测 ~6s）：出声前挂着「缓冲中...」，首个 position 事件会清它；
    // 事件万一不来，3 秒后也清掉，别一直占着时间位
    
    if (S.status === '缓冲中...' && Date.now() - S.startedAt > 3000) S.status = ''
    emit()

    // 播放中定期存位置快照（被强杀/待机自动关机时「上次播放状态」最多丢这么久；正常退出有 flushNow 精确存）
    
    const gap = S.queue.length > BIGQ ? SAVE_MS_BIGQ : SAVE_MS
    if (Date.now() - S.lastSaveAt >= gap) persist()
  }, 500)
}

/* 统一的出声入口：本地文件与在线直链都走 playFile（直链同样认位置与倍速，实测定案）。
 * locator: 本地绝对路径或 http 直链；kind: 'file' | 'stream'；my: 调用方代次（缺省当前 gen）。
 * ⚠ 本函数是**破坏性**的：先 stop() 再 playFile —— 失败时旧播放也已经没了。 */
async function startSource(locator, posMs, kind, my) {

  // 先断掉「自己在播」的守卫：这次 stop() 触发的 EndChanged / 迟到事件必须被忽略
  S.paused = true
  S.isPlaying = false
  S.uuid = ''
  stopTimer()
  await stop()
  if (my !== undefined && my !== S.gen) return false
  const u = await playFile(locator, posMs || 0, S.rate)
  // 别把别人的任务 uuid 记到自己头上
  if (my !== undefined && my !== S.gen) return false 
  S.uuid = u || ''
  S.baseMs = posMs || 0
  S.startedAt = Date.now()
  S.positionMs = S.baseMs
  S.paused = false
  S.isPlaying = true
  S.srcMode = kind
  if (kind === 'file') {
    S.localPath = locator
    S.status = '' 
  }

  // 流播保留当前的「缓冲中...」：出声由首个 position 事件确认（tick 另有 3s 看门狗）
  startTimer()
  emit()
  return true
}

/* seek / 续播（▶）/ 改倍速的统一流程：有本地文件 → 本地定位；没有 → 直链流式定位（同时后台补缓存）；
 * 直链也拿不到 → 回退「等整首下载」；流播起播失败 → 同样回退等下载。
 * 入口 ++gen：用户动作里最后一次赢（连点 seek / seek 撞暂停都不会被旧流程抢回去）。 */
export async function reopenAt(posMs, label) {
  const my = ++S.gen
  if (!S.cur.id) return false
  const pos = Math.max(0, Math.round(posMs || 0))

  let kind = ''
  let locator = ''
  if (S.localPath) {
    kind = 'file'
    locator = S.localPath
  } else {

    // 磁盘缓存优先（loadLastState / 接管回灌后 localPath 是空的，但文件可能还在）
    const hit = await cachedPath(S.cur.id)
    if (my !== S.gen) return false
    if (hit) {
      S.localPath = hit
      kind = 'file'
      locator = hit
    } else {
      const info = await ensureStreamUrl()
      if (my !== S.gen) return false
      if (info && info.url) {
        kind = 'stream'
        locator = info.url
        kickCache() 
      } else {

        // 直链拿不到（受限 / 网络差）→ 回退旧行为：等整首下载
        const l = await needLocal()
        if (my !== S.gen) return false
        if (l && l.ok) {
          kind = 'file'
          locator = l.path
        } else {
          S.hint = (l && l.error) || '无法播放'
          S.status = '歌曲受限'
          emit()
          return false
        }
      }
    }
  }

  if (kind === 'stream') {

    // 解析直链要 200ms~3s，且 startSource 会先 stop 掉当前声音 —— 要有反馈
    S.status = '缓冲中...'
    S.hint = '缓冲中...'
    emit()
  }
  let ok = false
  try {
    ok = await startSource(locator, pos, kind, my)
  } catch (e) {
    log('player', '起播失败(' + kind + '): ' + ((e && e.message) || e))
  }
  if (ok) {
    S.hint = label || S.hint
    emit()
    return true
  }
  if (my !== S.gen) return false

  if (kind === 'stream') {
    const l = await needLocal()
    if (my !== S.gen) return false
    if (l && l.ok) {
      try {
        if (await startSource(l.path, pos, 'file', my)) {
          S.hint = label || S.hint
          emit()
          return true
        }
      } catch (e2) {
        log('player', '回退本地起播失败: ' + ((e2 && e2.message) || e2))
      }
    }
  }
  if (my !== S.gen) return false
  S.paused = true
  S.isPlaying = false
  stopTimer()
  S.hint = '播放失败，按 ▶ 重试'
  S.status = '播放失败'
  emit()
  persist()
  return false
}

async function handleEnded() {
  const total = activeList().length
  if (total === 0) return
  if (S.loopMode === 'single') {
    S.hint = '单曲循环'
    await playAt(S.index)
    return
  }
  if (inShuffle()) {
    const n = shuffleNext(S.index)
    if (n >= 0) await playAt(n)
    return
  }

  if (S.index < total - 1) {
    await playAt(S.index + 1)
    return
  }

  if (S.loopMode === 'list_loop') {
    await playAt(0)
    return
  }
  S.isPlaying = false
  S.paused = false
  S.hint = '播放结束'
  S.status = ''
  stopTimer()
  emit()
  persist(0) 
}

export async function playAt(i) {
  // i 是「生效队列」的下标（随机模式 = 临时队列；页面显示的也是它）
  const s = activeList()[i] 
  if (!s) return
  const my = ++S.gen
  S.cur = s
  S.index = i
  S.durationMs = s.durationMs || 0
  S.paused = false
  S.isPlaying = false
  S.loading = true
  S.srcMode = ''
  S.localPath = ''
  S.uuid = '' 
  S.cacheKick = { id: '', at: 0 } 
  S.hint = '准备中...'
  S.status = '准备中...'

  // 切歌即重置时钟、停掉旧 tick：出声（startSource 会重启计时器）之前的空窗里，
  // 旧 baseMs/startedAt 会算出上一首的进度，甚至对新歌提前触发「播完」判定
  
  stopTimer()
  S.baseMs = 0
  S.startedAt = Date.now()
  S.positionMs = 0
  emit()
  // 上次播放状态：切歌瞬间就记上新歌（位置 0），即便随后播放失败也算「选过它」
  persist(0) 

  // 搜索接口不带封面（只有 picId）、本地下载页的条目可能缺时长 —— 都用详情接口补；带竞态校验
  if (!s.cover || !s.durationMs) {
    getSongDetail(s.id)
      .then(function (d) {
        if (!d) return
        enrich(d) 
        if (S.cur.id !== d.id || my !== S.gen) return
        const needCover = !S.cur.cover && d.cover
        const needDur = !S.durationMs && d.durationMs
        if (!needCover && !needDur) return
        if (needCover) S.cur = d
        else S.cur = Object.assign({}, S.cur, d) 

        // **模块级 durationMs 也要补**：startTimer 的播完判定、seekTo、快照/进度环都用它 ——
        // 不补的话「从本地下载页点播缺时长的老缓存」永远不自动连播、进度条也拖不动
        
        if (needDur) S.durationMs = d.durationMs
        emit()
        persist() 
      })
      .catch(function () {})
  }

  const hit = await cachedPath(s.id)
  if (my !== S.gen) return
  if (hit) {
    S.localPath = hit
    S.loading = false
    S.hint = '本地缓存播放'
    await startSource(hit, 0, 'file', my)
    log('player', '播放中(缓存): ' + s.name + ' rate=' + S.rate + ' mode=' + S.loopMode)
    if (S.cur.id === s.id) record(S.cur) 
    // 记「最近播放」：缓存上限 LRU 按它决定先淘汰谁（下载目录的条目不受影响）
    touchPlayCache(s.id) 
    return
  }

  // 取直链：用「播放音质」档（ensureStreamUrl 内部按 currentQuality('play') 解析）；
  // 同曲 TTL 内的直链走内存复用（seek/续播/改倍速也都吃这一份）
  

  const info = await ensureStreamUrl()
  if (my !== S.gen) return
  if (!info) {
    S.hint = '歌曲受限，暂无直链'
    S.status = '歌曲受限'
    S.loading = false
    S.isPlaying = false
    emit()
    log('player', '受限: ' + s.name)
    return
  }

  // 流式播放：playFile 直链同样认位置与倍速（实测），不再有「倍速≠1 先缓存」
  let streamed = false
  S.hint = '缓冲中...'
  S.status = '缓冲中...'
  emit()
  try {
    streamed = await startSource(info.url, 0, 'stream', my)
  } catch (e) {
    log('player', '流式不可用，转下载: ' + ((e && e.message) || e))
  }
  if (my !== S.gen) return
  if (streamed) {
    S.loading = false
    S.hint = S.rate === 1 ? '流式播放' : '流式播放 ' + S.rate + 'x'
    log('player', '流式播放: ' + s.name + ' br=' + (info.br || '') +
      ' lvl=' + (info.level || '-') + ' rate=' + S.rate + ' mode=' + S.loopMode)
    if (S.cur.id === s.id) record(S.cur) 
  }

  // 后台**播放缓存**（落 cache/、按播放音质）：本地 seek/续播要用，也让下次播放秒开；
  // ⚠ 它**不是**「下载」—— 不进「本地下载」列表，且受设置项「缓存上限」按播放顺序 LRU 滚动。
  // 缓存档 = 播放档，这份直链天然可复用；只有太老（>2 分钟，首包会 403）才传 null 让下载层重解析
  

  

  const fresh = Date.now() - (info.at || 0) < URL_FRESH_MS
  const job = ensureCached(s, fresh ? info : null, { onProgress: progressStatus(s.id, !streamed) })
  job.then(function (r) {
    if (r && r.ok && S.cur.id === s.id) {
      S.localPath = r.path
      emit()
    }
  })

  if (streamed) {
    emit()
    return
  }

  S.hint = S.rate === 1 ? '缓冲中...' : '倍速 ' + S.rate + 'x'
  S.status = '缓冲中 0%'
  emit()
  const r = await job
  if (my !== S.gen) return
  if (!r.ok) {
    S.hint = r.error || '无法播放'
    S.status = '下载失败'
    S.loading = false
    S.isPlaying = false
    emit()
    log('player', '不可播: ' + s.name + ' ' + (r.error || ''))
    return
  }
  S.localPath = r.path
  S.loading = false
  S.hint = '已缓存 ' + Math.round((r.size || 0) / 1024) + 'KB'
  await startSource(r.path, 0, 'file', my)
  log('player', '播放中(下载): ' + s.name + ' rate=' + S.rate + ' mode=' + S.loopMode)
  if (S.cur.id === s.id) record(S.cur) 
}

export async function toggle() {
  if (!S.cur.id) return
  if (S.paused) {

    // 续播：有本地用本地、没有就直链定位起播（不再等整首下载）
    const ok = await reopenAt(S.positionMs, '继续播放')
    if (ok) persist()
  } else {
    const pos = S.positionMs
    S.paused = true
    S.isPlaying = false
    // 作废在途的启动流程（seek/续播回来时别把播放又开起来）
    S.gen++ 
    // 这次 stop 的结束事件不该被认成「播完」
    S.uuid = '' 
    S.status = ''
    await stop()
    S.baseMs = pos
    stopTimer()
    S.hint = '已暂停 @' + fmtDur(pos)
    emit()
    persist() 
  }
}

export async function stopPlay() {
  stopTimer()
  S.gen++ 
  S.uuid = ''
  S.paused = false
  S.isPlaying = false
  S.positionMs = 0
  S.baseMs = 0
  S.status = ''
  await stop()
  S.hint = '已停止'
  emit()
  // 停在 0（上面刚置零）：恢复后按 ▶ 是重播这首
  persist() 
}

// 原生在线流可直接定位（playFile(url, pos, rate) 实测定案）：有本地文件用文件、没有就直链流式定位；
// 直链拿不到才回退等缓存（见 reopenAt）
export async function seekTo(ms) {
  if (!S.cur.id || !S.cur.durationMs) return
  let pos = Math.max(0, Math.min(S.cur.durationMs - 500, Math.round(ms)))
  if (pos < 0) pos = 0
  const ok = await reopenAt(pos, '跳转 @' + fmtDur(pos))
  if (ok) {
    persist()
    log('player', 'seek -> ' + pos + ' (' + S.srcMode + ' @' + S.rate + 'x)')
  }
}

// 手动上一/下一**始终环绕**（与自动连播不同：顺序播放只在自然播完到尾时停，手动点则从尾绕到首）
function stepIndex(dir) {
  const total = activeList().length
  if (total === 0) return -1
  if (total === 1) return 0
  if (inShuffle()) return dir > 0 ? shuffleNext(S.index) : shufflePrev(S.index)
  let n = S.index + dir
  if (n < 0) n = total - 1
  if (n >= total) n = 0
  return n
}

export function next() {
  const n = stepIndex(1)
  if (n >= 0) playAt(n)
}

export function prev() {
  const n = stepIndex(-1)
  if (n >= 0) playAt(n)
}