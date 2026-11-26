

// 曲目级动作的共享入口 —— 各页左栏「下一首播放」「收藏到歌单」都走这里（5 个页面共用，各写一遍会漂移）。
// 各页只负责取到曲目对象数组（顺序 = 用户看到的顺序）与 toast 文案；这里只做「发起动作 + 返回结果」，
// 不碰 UI 状态（不 showToast、不改 multi）—— 页面拿返回值自己决定提示什么、要不要退出多选。
import { go } from '../../core/infra/nav.js'
import { player } from '../../services/player/player.js'

// 跳到歌单选择页（pages/playlists 的 pick 模式），把这几首加进去：单首时把曲名带过去当副题，
// 多首只报数量（副题由选择页按 pickIds 自己算）；返回实际带过去的曲目数（0 = 没有可加的曲目）。
// 选择态 = playlists 的第二层实例：nav.js 分配一个当前不在栈里的槽位 key 再 navTo，平台必然新建实例
// （不弹掉调用页，也不复用栈里的浏览态）；返回用 $page.finish()
export function toPlaylist(songs) {
  const list = songs || []
  const ids = []
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    if (s && s.id) ids.push(s.id)
  }
  if (!ids.length) return 0
  const pname = ids.length === 1 ? (list[0] && list[0].name) || '' : ''
  go('playlists', { pick: ids.join(','), pname: pname })
  return ids.length
}

// 插到当前播放队列的「下一首」。返回 player.insertNext 的结果 {ok, added, dup, played}；
// played=true 表示队列本来是空的、直接起播了
export function playNext(songs) {
  return player.insertNext((songs || []).slice())
}

export function playNextText(r) {
  const x = r || {}
  if (x.played) return '队列为空，已开始播放'
  if (x.added > 0) return '已插入下一首 ' + x.added + ' 首' + (x.dup ? '（' + x.dup + ' 首已在队列）' : '')
  if (x.dup > 0) return '已在播放队列里'
  return ''
}
