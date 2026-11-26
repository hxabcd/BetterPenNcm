

// 播放页布局常量 —— 样式与几何算式的唯一真源。
// 本平台**没有元素测量 API**（getBoundingClientRect / offsetLeft / offsetParent 都不保证存在，量不到返回 0），
// 所以「点哪跳哪」这类需要绝对坐标的交互，只能由布局常量反推。
// 数值单位是 **vh**（S7 1vh=2.4px / X3S·X5 1vh=2.54px，见 core/platform/viewport.js）；
// pages/player 的 LESS 里写的数值必须与这里**成对维护** —— 改一处要改两处。
import { screenSize, vhPx, isNarrow, RAIL_W, vh } from '../../core/platform/viewport.js'

export { screenSize, vhPx, isNarrow }

export const PLY = {
  // 页面上下内边距
  PAD_V: 2, 
  // 页面左右内边距
  PAD_H: 2, 
  // 左列宽（封面 + 控制行所在列）：控制行实宽 5×20 + 间距 2×4 = 108，列内左右各余 1vh 居中。
  // ⚠ LESS 里这个宽度必须写 px（264px）：值 > 100 的 vh 宽度会被平台静默截到 100vh（240px），控制行塞不进 → 按钮被压扁
  LEFT_W: 110, 

  // 封面是固定正方形，边长由「左列可用高 − 控制行 − 间距」推出（当前 70vh），所以这里没有 COVER 常量
  

  // 封面与控制按钮之间多留 1vh，从封面边长里扣（71 → 70），左列总高不变
  

  
  // 控制行高 = 控制按钮直径
  CTRL_H: 20, 
  // 控制按钮之间的间距
  CTRL_GAP: 2, 
  // 封面与控制行之间的间距
  COVER_GAP: 2, 

  // 左右列间距
  GAP: 3, 
  // 右列顶部「歌名·歌手 + 已播/总长」行高
  TITLE_H: 16, 
  // 收起态底部只读进度条贴底所占的高度
  PROGRESS_H: 5, 

  // 进度浮窗：左右内边距
  SEEK_PAD_H: 6, 
  // 左侧圆形收起按钮直径
  SEEK_BTN: 23, 
  // 圆形按钮与进度条之间的间距
  SEEK_GAP: 6, 
  // 右侧圆角矩形进度条（外框）高度
  SEEK_BAR_H: 22, 
  // 进度条外框的内边距（真正可拖的那根线在里面）
  SEEK_LINE_PAD: 6, 
  // 浮窗距内容区底部
  SEEK_BOTTOM: 8 
}

// 歌词行盒（行盒冻结：高度固定，切行/拖动时不跳动）。
// **整首一次铺完**，没有「渲染窗口」：窗口跟着当前行一挪，内容瞬间多/少一行与 translateY 过渡叠加就是闪烁根因。
// 铺全部行之所以不卡，是行盒极轻、LyricBoard 的 rowsAll 只跟歌词/翻译开关有关，换行时 v-for 的数组引用不变。
// 「整首铺开」是 config.lyricFull=true 时的行为；另有省性能模式（lyricFull=false）：只铺当前行 ±3 行（共 7 行）并禁用拖动，
// 可视区 180px ÷ 行盒 38.4px ≈ 4.7 行，所以 7 行铺得满。
export const LYRIC = {

  // 主文本行盒按「主文本行高 ≈ 9.6vh、译文行高 ≈ 7.2vh」留余量：主文本行盒的余量（13 - 9.6）就是条目之间的行距
  

  // 每行主文本的行盒高（容纳选中行的加大字号 + 撑开行距）
  MAIN_H: 16, 
  // 翻译行高（仅该行有译文时叠加；行高已在 mainStyle 里收紧，这里相应收小）
  TRANS_H: 7 
}

// 歌词可视区高度（vh）——右列扣掉标题行与底部进度条
export function lyricViewH() {
  return 100 - PLY.PAD_V * 2 - PLY.TITLE_H - PLY.PROGRESS_H
}

// 歌词可视区高度（px）
export function lyricViewPx() {
  return lyricViewH() * vhPx()
}

// 进度条**可拖那根线**的几何（px）——**由常量反推，不测量元素**。
// 注意算的是「线」而不是「外框」：外框里还有一层内边距，线在里面；手柄与填充都是相对线定位，
// 所以这里必须给出线自身的宽，否则手柄会整体偏移。
// 从左往右：内容区左 | 浮窗内边距 | 圆钮 | 间距 | 外框内边距 | ←线→ | 外框内边距 | 浮窗内边距
export function seekGeometry() {
  const s = screenSize()
  const railW = vh(RAIL_W)
  const contentW = s.w - railW
  const leftInset = vh(PLY.SEEK_PAD_H + PLY.SEEK_BTN + PLY.SEEK_GAP + PLY.SEEK_LINE_PAD)
  const rightInset = vh(PLY.SEEK_PAD_H + PLY.SEEK_LINE_PAD)
  return {
    x: railW + leftInset,
    w: Math.max(1, contentW - leftInset - rightInset)
  }
}
