

// 缓存数据层 —— 两条媒体通道（downloads/ 与 cache/）的元数据、枚举、统计与清理。
// 两个音频概念、两个目录、同一套「每 track 一个目录」布局：
//   下载 download = data/downloads/<id>/（下载音质；出现在本地下载页/首页下载卡/播放页下载键；用户主动下，永久保留）
//   缓存 cache    = data/cache/<id>/（播放音质；不出现在任何下载清单；边听边存，受「缓存上限」LRU 滚动）
//   浏览缩略图    = data/cache/thumbs/（不属于任何曲目，可整体清空）
// 元数据在状态库 state.db 的 track_meta / track_lyric，读写都经 media.js；本模块只管内存快照与清理。
// 文件系统为真相、元数据可缺失：readdir 永远准，元数据只负责「显示得好看」与 LRU 排序，缺了不影响功能。
// 容量实测：fs.statfs 返回 {free,total} 但语义可疑（free>total），可用空间一律走 exec df，不可用时回退纯 fs。

export { musicDir, playCacheDir,
  loadMeta, metaOf, beginMeta, putMeta, markPending, dropMeta, clearMeta, warmMeta,
  loadPlayMeta, playMetaOf, beginPlayMeta, putPlayMeta, dropPlayMeta, clearPlayMeta, warmPlayMeta
} from './cache-meta.js'

export { touchPlayMeta } from './cache-touch.js'

export { listSongs, listPlayCache, stats, freeBytes } from './cache-scan.js'

export { clearSongs, clearPlayCache, clearCoverCache } from './cache-clean.js'

export { cacheLimitMb, cacheLimitBytes, setCacheProtectHook, enforceCacheLimit } from './cache-lru.js'
