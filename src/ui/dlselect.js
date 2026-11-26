

// 多选下载的**选择集纯函数**（业务文案/空间预检在 services/player/download.js）。
// 状态机（选中集合、rail、两次点按确认）维护在各页自己的 data 里，这里只放纯函数。
// 选中集合的增删查全部**返回新数组**：平台不认动态 key，集合一律整体替换（平台坑 4）。
export function selHas(ids, id) {
  return ids.indexOf(id) >= 0
}

export function selToggle(ids, id) {
  const next = ids.slice()
  const i = next.indexOf(id)
  if (i >= 0) next.splice(i, 1)
  else next.push(id)
  return next
}

// 是否全选 —— 全工程唯一公式。第二个参数是**计数**不是数组：口径由调用方定
// （mixin 传本批行数；list 页传整单总数，「全不选」才不会因翻页翻回「全选」）。
export function selAllPicked(ids, totalCount) {
  const n = Number(totalCount) || 0
  return n > 0 && ids.length >= n
}

export function selAllIds(songs) {
  const out = []
  const list = songs || []
  for (let i = 0; i < list.length; i++) {
    if (list[i]) out.push(list[i].id)
  }
  return out
}

// 按**列表顺序**取出选中的歌曲对象（下载队列的顺序 = 用户看到的顺序）
export function selPicked(ids, songs) {
  const out = []
  const list = songs || []
  for (let i = 0; i < list.length; i++) {
    if (list[i] && selHas(ids, list[i].id)) out.push(list[i])
  }
  return out
}
