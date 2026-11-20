/**
 * 媒体源层之一：直链解析（从 download.js 拆出，实现零改动）。
 *
 * 按音质档位逐级降级（见 quality.js），最低 128k 兜底。
 * 走 v1 直链接口（`level` 参数，含 hires 档），回包带**实际档位** `level`。
 */
import { getSongUrl } from '../ncm/api.js'
import { resolveLevels } from './quality.js'

/**
 * 直链解析：按音质档位逐级降级（见 quality.js），最低 128k 兜底。
 * @param {string} qualityKey 指定档位（如播放档）；**缺省 = 下载档**（quality.js 的 currentQuality('down')）
 * 返回 {url, br, size, type, level} 或 null（VIP/受限歌）。
 * `info.level` 只是服务端的档位**标签**（实测不可靠，见 ncm/api.js 的说明）：仅进日志，
 * 落盘元数据仍按**请求档**记 q（取舍见 download.js 的 metaSatisfies）。
 */
export async function resolveUrl(songId, qualityKey) {
  const levels = resolveLevels(qualityKey)
  for (let i = 0; i < levels.length; i++) {
    try {
      const info = await getSongUrl(songId, levels[i])
      if (info && info.url) return info
    } catch (e) {}
  }
  return null
}
