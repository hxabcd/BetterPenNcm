// 媒体源层（拆分自 download.js）：元数据判重 / 就地补写 / 完整残片转正。
// 纯文件与状态库操作，不联网；downloadSongs、downloadOne、启动对账三处共用。
import { qualityRank } from './quality.js'
import {
  putMeta, warmMeta, beginMeta,
  putPlayMeta, warmPlayMeta, beginPlayMeta
} from './cache.js'
import { toKind } from '../../core/infra/paths.js'
import { songPath, altPath } from './files.js'
import { promotePart, killPartFetch } from './fetcher.js'
import { fileSize, readText, rmQuiet } from '../../core/platform/fsutil.js'
import { MIN_AUDIO_BYTES } from './media.js'
import { log } from '../../core/infra/log.js'

/* 已有缓存是否达到当前下载档（true = 跳过不重下）。
 *   - 无元数据 → 视为达标：老缓存/元数据没写上的不误重下。
 *   - 有 q（下载档 key）→ 比档位名次（≥ 即达标）。
 *   - 无 q（本功能之前的老数据）→ 按「容器 + 实际码率」反推已达档位。
 *   ⚠ 降级拿到的低码率（请求无损实际只给 320k）与「q 记的是请求档」叠加后，这类文件也会被永久视为达标
 *     —— 想升质的唯一途径是先删（下载页多选删）再下；Hi-Res 档尤其如此（账号无权益时请求 hires 会静默退到
 *     exhigh，回包 level='exhigh'，文件仍按 q='hires' 记 → 之后不再重试）。
 *   ⚠ **别拿 meta.b 与 nominalBr 比**：真机实测无损实际 br=947180，比名义 999000 小，
 *     会比出「未达标」而把每首老无损缓存白重下一次 */
export function metaSatisfies(meta, key) {
  if (!meta) return true
  if (meta.q) return qualityRank(meta.q) >= qualityRank(key)
  const target = qualityRank(key)
  if (meta.y === 'flac') return target <= qualityRank('lossless') 
  const b = meta.b || 0
  if (!b) return true
  if (b >= 320000) return target <= qualityRank('exhigh')
  if (b >= 192000) return target <= qualityRank('higher')
  return target <= qualityRank('standard')
}
// **跳过判定必须用它**：只看文件在不在（老逻辑）会把「有歌没名字」的行永远当成已完成，既不重下也不修
export function metaReady(m) {
  return !!(m && m.n && !m.p && (m.q || m.y || m.b))
}

// 这条元数据是否「证据不足，必须重新下一次」：p 还在（上次没走完）+ 没有 q 也没有 b → 光看 y（容器）
// 判不出这份文件到底是不是本次要的档位。f === 1 表示下载开始时盘上没有旧文件，那这份音频就是本次下的、
// p 可以当实际档位；f 为 0/缺省（升级、或旧版本留下的行）则不能拿 p 冒充，先重下一次
export function metaNeedsRetry(m) {
  if (!(m && m.p)) return false
  if (m.q || m.b) return false
  return m.f !== 1
}

export function storeOf(kd) {
  return toKind(kd) === 'download'
    ? { put: putMeta, of: warmMeta, begin: beginMeta }
    : { put: putPlayMeta, of: warmPlayMeta, begin: beginPlayMeta }
}

/* 就地补元数据（**不重新拉音频**）：文件已经在盘上，只是 track_meta 缺字段/还带着 p。
 * q 的取法：已有 q / b（老条目，或升级失败留下的旧档）→ 以盘上这份文件为准，**绝不能用 p**
 * （p 记的是这次想升到的档，不是文件实际的档）；什么都没有且 begin 记了 f=1 → 用 p 回填档位；
 * 其余（只有 y、f=0/缺省）→ q 留空，由 metaNeedsRetry 决定是否重下 */
export async function repairMeta(song, hitPath, meta, kind) {
  const kd = toKind(kind)
  if (metaReady(meta)) return meta
  if (!song || !song.id) return null
  const store = storeOf(kd)
  const ext = /\.flac$/i.test(String(hitPath || '')) ? 'flac' : 'mp3'
  const q = (meta && (meta.q || (meta.f === 1 ? (meta.p || '') : ''))) || ''
  for (let i = 0; i < 2; i++) {
    try {
      const r = await store.put(song, 0, ext, q)
      if (r && r.ok) {
        log('dl', '就地补元数据 ' + song.id + '[' + kd + '] 档=' + (q || '未知') + ' 容器=' + ext)
        return r.rec
      }
    } catch (e) {}
  }
  log('dl', '元数据修复失败 ' + song.id + '[' + kd + ']')
  return null
}

/* 上一次下载其实已经把 .part 写满，只是没来得及 mv/promote 就退出/被系统掐掉。
 * 认「下满」的两条证据：curl 自己写的 .rc=0，或 begin 记下的预期大小 z（≥99%）；只有 p === qk 才认
 * （跨档残片仍由 downloadOne 丢弃） */
export async function finishCompletePart(song, kd, qk, prev) {
  if (!song || !song.id || !prev || prev.p !== qk) return null
  const z = prev.z || 0
  for (let i = 0; i < 2; i++) {
    const ext = i === 0 ? 'mp3' : 'flac'
    const part = songPath(song.id, ext, kd) + '.part'
    const size = await fileSize(part)
    if (!(size > MIN_AUDIO_BYTES)) continue
    const rc = String(await readText(part + '.rc')).trim()
    if (!(rc === '0' || (z > 0 && size >= z * 0.99))) continue
    const finalPath = songPath(song.id, ext, kd)
    const had = (await fileSize(finalPath)) > 0
    const alt = altPath(song.id, ext, kd)
    const altHad = (await fileSize(alt)) > 0

    // 先杀掉可能还在写这个 .part 的旧 curl：否则 mv 之后它仍会往同一个 inode 追加，
    // 正式文件会在「校验通过」之后被写坏
    
    await killPartFetch(part)
    const moved = await promotePart(part, finalPath)
    if (!moved) continue
    await rmQuiet(part + '.rc')
    await rmQuiet(part + '.cur')
    await rmQuiet(alt)
    const store = storeOf(kd)
    let rec = null
    for (let k = 0; k < 2; k++) {
      try {

        // 码率未知：清掉旧文件的 b（旧文件的码率可能属于旧档位，别张冠李戴）
        const r = await store.put(song, 0, ext, qk, { clearBr: true })
        if (r && r.ok) {
          rec = r.rec
          break
        }
      } catch (e) {}
    }
    log('dl', '完整残片直接转正 ' + song.id + '[' + kd + '] ' +
      Math.round(size / 1024) + 'KB 档=' + qk)
    return {
      ok: true,
      path: finalPath,
      size: size,
      ext: ext,
      fromPart: true,
      metaOk: !!rec,
      replaced: had || altHad
    }
  }
  return null
}
