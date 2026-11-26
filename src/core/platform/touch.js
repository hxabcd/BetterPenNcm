

// 触摸坐标提取（歌词拖动 / 进度条拖动共用）。
// **不同固件/渲染器把坐标放在不同字段里，官方文档没写全**，所以要挨个兜；按「最可能绝对」
// 到「可能是相对」排序：changedTouches / touches / targetTouches 里的 pageX → clientX → screenX → x，
// 再退到 event.data.*、event.detail.*，最后是事件对象本身。
// 拖动只用两点之差，只要一路取到同一字段、同一坐标系就 1:1 跟手。
//
// ⚠ 本固件实测（双击歌词跳行时踩到）：pageX/pageY 是**相对触发节点**的坐标，screenX/screenY
// 才是屏幕绝对的。同一次触摸 pageY=124 / screenY=166（另一处 135/177），差值恒为 42px ——
// 正是触发触摸的节点顶边到屏幕顶边的距离。本函数优先取 pageY，所以调用方拿到的是节点相对值：
// 「点哪跳哪」按节点相对值算，不要再减面板顶边。

const AXIS_KEYS = {
  x: ['pageX', 'clientX', 'screenX', 'x'],
  y: ['pageY', 'clientY', 'screenY', 'y']
}

function fromTouch(touch, axis) {
  if (!touch) return NaN
  const keys = AXIS_KEYS[axis]
  for (let i = 0; i < keys.length; i++) {
    const raw = touch[keys[i]]
    if (raw === undefined || raw === null) continue
    const n = Number(raw)
    if (isFinite(n)) return n
  }
  return NaN
}

function fromList(list, axis) {
  if (!list) return NaN
  const len = Number(list.length) || 0
  if (len > 0) {
    for (let i = 0; i < len; i++) {
      const n = fromTouch(list[i], axis)
      if (isFinite(n)) return n
    }
    return NaN
  }
  return fromTouch(list, axis)
}

/** 取触摸事件的 x / y；取不到返回 NaN */
export function touchAxis(event, axis) {
  if (!event) return NaN
  let n = fromList(event.changedTouches, axis)
  if (isFinite(n)) return n
  n = fromList(event.touches, axis)
  if (isFinite(n)) return n
  n = fromList(event.targetTouches, axis)
  if (isFinite(n)) return n
  const data = event.data
  if (data) {
    n = fromList(data.changedTouches, axis)
    if (isFinite(n)) return n
    n = fromList(data.touches, axis)
    if (isFinite(n)) return n
    n = fromTouch(data, axis)
    if (isFinite(n)) return n
  }
  const detail = event.detail
  if (detail) {
    n = fromTouch(detail, axis)
    if (isFinite(n)) return n
  }
  return fromTouch(event, axis)
}
