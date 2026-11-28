import * as media from '../../services/player/media.js'
import { cacheDir, downloadsDir, thumbsDir, trackFile } from '../../core/infra/paths.js'
import { readNames, statOf } from '../../core/platform/fsutil.js'
import { has, run as shRun } from '../../core/platform/exec.js'
import { log } from '../../core/infra/log.js'

// 把 media.listTracks 的条目归一成页面要的 Song 行（字段名与旧 listDir 完全一致）；meta 可能为 null（track_meta 缺失）→ 给默认值
function toRow(it) {
  const m = it.meta || null
  return {
    id: it.id,
    ext: it.ext || 'mp3',
    size: it.size || 0,
    mtime: it.mtime || 0,
    path: it.path || '',
    name: (m && m.n) || '',
    artist: (m && m.a) || '',
    br: (m && m.b) || 0,

    // 档位 key / 时长 / 封面 url（旧条目可能没有：给默认值，调用方兜底）
    qualityKey: (m && m.q) || '',
    durationMs: (m && m.d) || 0,
    cover: (m && m.c) || '',
    usedAt: (m && m.u) || 0
  }
}

// 列一条通道下的全部曲目（**按目录扫**：一个 id 一条记录，两种扩展名不会各成一条）
async function listDir(kind) {
  const list = await media.listTracks(kind)
  const out = []
  for (let i = 0; i < list.length; i++) {
    // 没有完整音频：不算这一条
    if (!(list[i].size > 0)) continue 
    out.push(toRow(list[i]))
  }
  return out
}

// 已下载歌曲清单（本地下载页用）
export async function listSongs() {
  return listDir('download')
}

// 播放缓存清单（LRU 滚动 / 缓存列表从这里取）
export async function listPlayCache() {
  return listDir('cache')
}

// 目录统计（下载 / 播放缓存 / 封面缩略图各 {count, bytes}）。
// 走 exec 一次调用（三条路径各一个 du -sk + 曲目目录计数）：逐目录 stat 在几百首时是几百次原生调用，du 一次 fork 就够。
// **计数口径**：songs/cache 只数「数字目录 + 里面有非空 track.mp3/flac」——.part 残片不算，cache/thumbs/ 不算（它不是曲目）；
// cache/thumbs/ 是浏览缩略图，单独算 covers，并从 cache 字节里扣掉（新布局下它在 cache/ 里面，du 会把两部分算在一起）。
// 与 listSongs/listPlayCache 的差别只在「1~30KB 的残次文件」：shell 侧只判非空，列表侧按 media.MIN_AUDIO_BYTES 判可播。
export async function stats() {
  const res = {
    // 下载（downloads/）
    songs: { count: 0, bytes: 0 }, 
    // 播放缓存（cache/，不含 thumbs/）
    cache: { count: 0, bytes: 0 }, 
    // 浏览缩略图（cache/thumbs/）
    covers: { count: 0, bytes: 0 } 
  }
  const okExec = await has('du')
  if (okExec) {
    try {
      const M = downloadsDir()
      const P = cacheDir()
      const C = thumbsDir()

      // 曲目计数：只数「数字目录 + 有非空 track.mp3/flac」，两种扩展名只计一次
      const trackCount = function (dir) {

        // 文件名从 paths.trackFile 取（扩展名集合 = media.AUDIO_EXT），别在这里重写一遍
        const hasAudio = media.AUDIO_EXT.map(function (ext) {
          const p = trackFile('0', ext)
          return '[ -s "$d/' + p.slice(p.lastIndexOf('/') + 1) + '" ]'
        }).join(' || ')
        return 'for d in "' + dir + '"/*/; do [ -d "$d" ] || continue; ' +
          'b=${d%/}; b=${b##*/}; case "$b" in ""|*[!0-9]*) continue; esac; ' +
          'if ' + hasAudio + '; then n=$((n+1)); fi; done'
      }
      const fileCount = function (dir) {
        return 'for f in "' + dir + '"/*; do [ -f "$f" ] && n=$((n+1)); done'
      }
      const one = function (tag, dir, isTrack) {
        return 'n=0; ' + (isTrack ? trackCount(dir) : fileCount(dir)) + '; ' +
          'echo "' + tag + ':$n:$(du -sk "' + dir + '" 2>/dev/null | cut -f1)"; '
      }
      // tag -> KB
      const kb = {} 
      {
        const r = await shRun(one('S', M, true) + one('P', P, true) + one('C', C, false), 20000)
        const lines = String((r && r.stdout) || '').split('\n')
        for (let i = 0; i < lines.length; i++) {
          // 目录不存在时 du 的 KB 列是空串（真机实测），第三段允许空

          const m = /^([SPC]):(\d+):(\d*)\s*$/.exec(lines[i].trim())
          if (!m) continue
          const count = parseInt(m[2], 10) || 0
          kb[m[1]] = parseInt(m[3], 10) || 0
          if (m[1] === 'S') res.songs.count = count
          else if (m[1] === 'P') res.cache.count = count
          else res.covers.count = count
        }
      }

      // cache 的 du 含 thumbs 子目录：扣掉，两条通道的字节才互不重叠
      const thumbsKb = kb.C || 0
      const cacheKb = Math.max((kb.P || 0) - thumbsKb, 0)
      res.covers.bytes = thumbsKb * 1024
      res.cache.bytes = cacheKb * 1024
      res.songs.bytes = (kb.S || 0) * 1024
      return res
    } catch (e) {
      log('cache', 'exec 统计失败: ' + ((e && e.message) || e))
    }
  }

  // 回退：fs 逐目录（慢但不失败）
  res.songs = await media.dirStats('download')
  res.cache = await media.dirStats('cache')
  {
    const dir = thumbsDir()
    const names = await readNames(dir)
    let bytes = 0
    for (let i = 0; i < names.length; i++) {
      const st = await statOf(dir + '/' + names[i])
      bytes += (st && st.size) || 0
    }
    res.covers = { count: names.length, bytes: bytes }
  }
  return res
}

// /userdisk 可用字节（exec df；不可用时 0）
export async function freeBytes() {
  const okExec = await has('df')
  if (!okExec) return 0
  try {
    const r = await shRun("df -k /userdisk 2>/dev/null | tail -1 | awk '{print $4}'", 10000)
    const kb = parseInt(String((r && r.stdout) || '').trim(), 10)
    return isNaN(kb) ? 0 : kb * 1024
  } catch (e) {
    return 0
  }
}
