

// 直链解析：走 v1 直链接口（level 参数，含 hires 档），按音质档位逐级降级（见 quality.js），最低 128k 兜底
import { getSongUrl } from '../ncm/api.js'
import { resolveLevels } from './quality.js'

// 返回 {url, br, size, type, level} 或 null（VIP/受限歌）；qualityKey 缺省 = 下载档（currentQuality('down')）。
// info.level 只是服务端的档位标签（实测不可靠）：仅进日志，落盘元数据仍按请求档记 q
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
