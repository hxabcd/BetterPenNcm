/**
 * 多选下载的**选择集纯函数**（S3 从 multidl 拆出；下载文案/空间预检等业务函数
 * 在 services/player/download.js 的 dlText/startText/resultText/spaceCheck）。
 *
 * 状态机（选中集合、rail、两次点按确认）维护在各页自己的 data 里（本平台对
 * mixin 没有先例，不引入），这里只放**纯函数**——选中集合的增删查，全部
 * **返回新数组**（平台不认动态 key，选中集合一律整体替换，坑 4）。
 */
/* ---------------- 选中集合 ---------------- */

export function selHas(ids, id) {
  return ids.indexOf(id) >= 0
}

/** 勾选/取消（返回新数组） */
export function selToggle(ids, id) {
  const next = ids.slice()
  const i = next.indexOf(id)
  if (i >= 0) next.splice(i, 1)
  else next.push(id)
  return next
}

/** 是否全选（范围 = 当前已加载的行） */
export function selAllPicked(ids, songs) {
  const n = songs ? songs.length : 0
  return n > 0 && ids.length >= n
}

/** 全选：所有行的 id（新数组） */
export function selAllIds(songs) {
  const out = []
  const list = songs || []
  for (let i = 0; i < list.length; i++) {
    if (list[i]) out.push(list[i].id)
  }
  return out
}

/** 按**列表顺序**取出选中的歌曲对象（下载队列的顺序 = 用户看到的顺序） */
export function selPicked(ids, songs) {
  const out = []
  const list = songs || []
  for (let i = 0; i < list.length; i++) {
    if (list[i] && selHas(ids, list[i].id)) out.push(list[i])
  }
  return out
}
