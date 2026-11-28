// 本地音乐库：已下载歌曲的完整元数据索引 + 歌词。
//
// 索引落 local_index.db 的 track / track_artist / album / artist 四张表；读写模型见 core/platform/db.js：
// boot 时整库灌内存、查询都在内存里（不分叉），写走单条 upsert（代价与库规模无关；旧实现整张表塞进
// store/local_index.json，一条改动就重写 62KB）。
// 歌词落状态库 state.db 的 track_lyric 表（{v, lrc, tlyric, yrc, pureMusic}，读写走 media.js），
// 对外按形状 {l, t, pm, y} 给调用方（player/lyric.js 依赖这个形状）。cache 通道的歌**不存歌词**：
// 它们会被 LRU 滚掉，留下就是孤儿数据。
//
// **「已索引」判据**：track 表里 name 非空的行才算本地库的曲目。下载归属（dlorigin.js）会给
// 「没有索引记录的老文件」单独补写 track.dl_origin，那种行 name 是空的 —— 不能当成「有详情可用」

export {
  songIdOf, loadIndex, indexOf, putIndex, dropIndex, lyricOf, putLyric, dropLyric,
  dropLocalSong, clearLocalLibrary, saveSongExtras
} from './meta2-index.js'

export {
  localSongInfo, localArtistView, localAlbumView, localArtistList, localAlbumList, localStats
} from './meta2-views.js'
