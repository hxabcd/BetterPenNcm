// 歌单接口门面：实现按读/缓存/写职责拆在 pl-read.js / pl-cache.js / pl-write.js，
// 本文件只做汇总转发，调用方照旧从 playlist.js 导入。
export {
  roleOf,
  fetchUserPlaylists,
  fetchPlaylistTracks,
  fetchPlaylistInfo,
  fetchPlaylistAllSongs,
  TRACKS_CHUNK,
  fetchTracksMore
} from './pl-read.js'
export { loadUserPlaylists, invalidateUserPlaylists, cachedPlaylistRole, bumpCachedPlaylistCount } from './pl-cache.js'
export {
  addToPlaylist,
  addToPlaylistMany,
  removeFromPlaylist,
  setSubscribed,
  renamePlaylist,
  createPlaylist,
  fitPlaylistName,
  deletePlaylist
} from './pl-write.js'
