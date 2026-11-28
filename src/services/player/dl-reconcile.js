// 媒体源层（拆分自 download.js）：启动对账（boot 里 await；只做原生 fs + SQLite，不联网）。
import { loadIndex, indexOf } from './localmeta.js'
import { listTracks } from './media.js'
import { trackDir } from '../../core/infra/paths.js'
import { readNames, rmQuiet } from '../../core/platform/fsutil.js'
import {
  metaReady, metaNeedsRetry, repairMeta, finishCompletePart, storeOf
} from './dl-meta.js'
import { purgeCacheCopy } from './dl-song.js'
import { log } from '../../core/infra/log.js'

function songFromIndex(id) {
  const rec = indexOf(String(id))
  if (!rec) return { id: id }
  const names = []
  const ars = rec.ars || []
  for (let i = 0; i < ars.length; i++) {
    if (ars[i] && ars[i].n) names.push(ars[i].n)
  }
  return {
    id: id,
    name: rec.n || '',
    artist: names.join(' / '),
    album: (rec.al && rec.al.n) || '',
    cover: (rec.al && rec.al.c) || '',
    durationMs: rec.d || 0
  }
}

/* 启动对账（boot 里 await；只做原生 fs + SQLite，不联网）：
 *   - 有正式音频但元数据不全且没有下载中标记 → 就地补成完成态；
 *   - 有正式音频但还带着 p → 只补歌名/歌手等显示字段，**保留 p**（这份音频可能是升级前的旧文件，
 *     下次下载要靠 p 决定「续传还是重下」）；
 *   - 只有残片且已下满（rc=0 或 z 达标）→ 直接转正 + 写完成态 */
export async function reconcileDownloads() {
  const out = { scanned: 0, repaired: 0, promoted: 0, cleaned: 0 }
  try {
    await loadIndex() 
  } catch (e) {}
  let tracks = []
  try {
    tracks = await listTracks('download')
  } catch (e) {
    return out
  }
  for (let i = 0; i < tracks.length; i++) {
    const it = tracks[i]
    const id = String(it.id)
    out.scanned++
    const meta = it.meta || null
    if (it.size > 0) {
      if (!metaReady(meta)) {
        const song = songFromIndex(id)
        if (song.name) {
          if (meta && meta.p && metaNeedsRetry(meta)) {

            // 下载未收尾且证据不足：只补显示字段，保留 p/z/f（下次下载据此续传或重下）
            await storeOf('download').begin(song, meta.p, meta.z || 0, meta.f !== 1)
          } else {
            const rec = await repairMeta(song, it.path, meta, 'download')
            if (rec && metaReady(rec)) out.repaired++
          }
        }
      }
    } else if (meta && meta.p) {
      const fin = await finishCompletePart(songFromIndex(id), 'download', meta.p, meta)
      if (fin) {
        out.promoted++
        try {
          await purgeCacheCopy(id) 
        } catch (e) {}
      }
    }

    // 清掉没有 .part 的 .rc/.cur（.part 还在时留给续传/转正）
    try {
      const dir = trackDir(id, 'download')
      const names = await readNames(dir)
      let hasPart = false
      for (let j = 0; j < names.length; j++) {
        if (names[j].slice(-5) === '.part') {
          hasPart = true
          break
        }
      }
      if (!hasPart) {
        for (let j = 0; j < names.length; j++) {
          const n = names[j]
          if (n.slice(-3) === '.rc' || n.slice(-4) === '.cur') {
            await rmQuiet(dir + '/' + n)
            out.cleaned++
          }
        }
      }
    } catch (e) {}
  }
  if (out.repaired || out.promoted || out.cleaned) {
    log('dl', '启动对账：扫描 ' + out.scanned + ' 首，补元数据 ' + out.repaired +
      '，转正残片 ' + out.promoted + '，清临时文件 ' + out.cleaned)
  }
  return out
}
