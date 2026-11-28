// 播放器（拆分自 player.js）：取到可播地址并起播（本地文件优先 → 直链流播 → 等缓存）。

import { log } from '../../core/infra/log.js'
import { ensureCached, resolveUrl } from './download.js'
import { currentQuality } from './quality.js'
import { KICK_MS, S, URL_TTL_MS, emit } from './player-state.js'


// 下载进度回调工厂（限流 ~500ms 一次，别把渲染打爆）：只在「还是当前曲目」时更新；
// showStatus=true 才占用播放页的时间位置（用户正在等），后台补缓存只更新 hint
export function progressStatus(songId, showStatus) {
  let last = 0
  return function (done, total, speed) {
    if (String(S.cur.id) !== String(songId)) return
    const now = Date.now()
    if (now - last < 500 && total && done < total) return
    last = now
    const pct = total ? Math.floor((done / total) * 100) : 0
    const mb = speed > 0 ? ' ' + (speed / (1024 * 1024)).toFixed(1) + 'M/s' : ''
    if (showStatus) S.status = total ? '缓冲中 ' + pct + '%' : '缓冲中 ' + Math.round(done / 1024) + 'KB'
    S.hint = '缓冲中' + mb + ' (' + Math.round(done / 1024) + 'KB)' 
    emit()
  }
}

// 「需要当前曲目的完整本地文件」的兜底（直链拿不到 / 流播起播失败才用），有缓存直接给、没有就等后台缓存下完；
// ensureCached 不缓存失败结果，所以流播途中缓存失败会在这里重试
export async function needLocal() {
  if (S.localPath) return { ok: true, path: S.localPath }
  if (!S.cur.id) return { ok: false, error: '没有歌曲' }
  const id = S.cur.id
  S.hint = '缓冲中...'
  S.status = '缓冲中 0%'
  S.loading = true
  emit()
  const r = await ensureCached(S.cur, null, { onProgress: progressStatus(id, true) })

  // 等待期间切歌了：别把上一首的路径写到当前曲头上
  if (String(S.cur.id) !== String(id)) {
    log('player', 'needLocal 期间已切歌，丢弃结果 id=' + id)
    return { ok: false, error: '已切歌' }
  }
  S.loading = false
  if (!r || !r.ok) {
    S.hint = (r && r.error) || '缓存失败'
    S.status = '缓冲失败'
    emit()
    return r || { ok: false, error: '缓存失败' }
  }
  S.localPath = r.path
  S.status = ''
  emit()
  return r
}

export async function ensureStreamUrl() {
  if (!S.cur.id) return null
  const id = S.cur.id
  const q = currentQuality('play')
  if (S.streamUrl && String(S.streamUrl.id) === String(id) && S.streamUrl.q === q &&
      Date.now() - S.streamUrl.at < URL_TTL_MS) {
    return S.streamUrl
  }
  if (S.streamUrlJob && String(S.streamUrlJob.id) === String(id) && S.streamUrlJob.q === q) {
    return S.streamUrlJob.p
  }
  const job = { id: id, q: q, p: null }
  job.p = resolveUrl(id, q).then(function (info) {
    if (S.streamUrlJob === job) S.streamUrlJob = null
    if (!info || !info.url) return null
    const rec = Object.assign({}, info, { id: id, q: q, at: Date.now() })
    S.streamUrl = rec
    log('player', '直链就绪 id=' + id + ' br=' + (info.br || '') +
      ' lvl=' + (info.level || '-') + ' q=' + q)
    return rec
  }, function (e) {
    if (S.streamUrlJob === job) S.streamUrlJob = null
    log('player', '直链失败 id=' + id + ': ' + ((e && e.message) || e))
    return null
  })
  S.streamUrlJob = job
  return job.p
}

// 后台补**播放缓存**（流播也要把整首存下来）：走 play 通道 → 落 $dataDir/cache、按播放音质、
// 受「缓存上限」LRU 滚动、**不**出现在「本地下载」里（缓存与下载分家）。
// KICK_MS 内同曲只踢一次（反复 seek 别反复入队）；不喂直链：让下载层自己重新解析（播放档的直链可能已经太老）
export function kickCache() {
  if (!S.cur.id) return
  const id = S.cur.id
  if (String(S.cacheKick.id) === String(id) && Date.now() - S.cacheKick.at < KICK_MS) return
  S.cacheKick = { id: id, at: Date.now() }
  const job = ensureCached(S.cur, null, { onProgress: progressStatus(id, false) })
  job.then(function (r) {
    if (r && r.ok && String(S.cur.id) === String(id)) {
      S.localPath = r.path
      emit()
    }
  })
}