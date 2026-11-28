// 本地歌单索引：记录落 local_index.db 的 playlist + playlist_track（base_ids / remote_ids 是两个 JSON 数组列）。
// addedAt / updateTime / lastSyncAt / meta 在库里没有对应列，只活在内存里（重启后 addedAt 按 pulled_at 回填）。
//
// **A / D 一律相对本地文件计算，不相对 baseIds**（对外口径）：
//   A（新增）= remoteIds − 本地已下载；D（移除）= baseIds − remoteIds，且本地有文件。
//   所以「加入索引前歌单里就已有、但一直没下载」的曲目，打开本地歌单列表立刻就是 A。
// 分类不维护孤儿表：由 dlorigin.js 的归属标记 + 本模块的「是否被任一索引歌单引用」动态派生，
// 所以移出索引只删记录、不碰文件。

export { loadLists, allLists, isIndexed, indexedCount, addList, removeList, removeListLocal, listHasSong } from './lists-record.js'

export { pullList, pullAll, syncList, downloadAll } from './lists-sync.js'

export { referencedIds, classifyWithRefs, splitDownloads, playlistView, listSummary } from './lists-views.js'
