/**
 * 触摸坐标提取（歌词拖动 / 进度条拖动共用）
 *
 * 移植自社区应用 PenMusic 的同名helper（`player.js` 顶部），它踩过的坑：
 * **不同固件/渲染器把坐标放在不同字段里，官方文档没写全**，所以要挨个兜。
 * 按「最可能是绝对坐标」到「可能是相对坐标」排序：
 *   changedTouches / touches / targetTouches 里的 pageX -> clientX -> screenX -> x
 *   再退到 event.data.*、event.detail.*，最后是事件对象本身。
 *
 * 关键：**坐标是绝对还是相对都不影响拖动** —— 拖动只用两点之差，
 * 只要一路取到的是同一个字段、同一个坐标系就 1:1 跟手。
 *
 * ⚠ 实机弄清了这个「绝对还是相对」（双击歌词跳行时踩到的）：
 *   同一次触摸 `pageY=124 / screenY=166`（另一处 `135/177`）—— 差值恒为 42px，
 *   正是**触发触摸的节点**（当时是歌词面板）顶边到屏幕顶边的距离。
 *   即本固件：**pageX/pageY 是「相对触发节点」的坐标，screenX/screenY 才是屏幕绝对的**。
 *   本函数按「最可能绝对」排序优先返回 pageY，所以调用方拿到的是**节点相对**值。
 *   → 「点哪跳哪」要用节点相对值算（PenMusic 的 ProgressBar 之所以能减常量是因为它的
 *     监听节点左边缘就在 x=0，横向两者恰好相等；竖向它没做绝对定位所以没暴露）。
 *   本项目用例：LyricPanel 的双击跳行直接用 pageY 减去自己的轨道位移即可，**不要再减面板顶边**。
 */

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

/** 便捷：{x, y}，取不到的分量为 NaN */
export function touchPoint(event) {
  return { x: touchAxis(event, 'x'), y: touchAxis(event, 'y') }
}
