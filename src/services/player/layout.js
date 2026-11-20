/**
 * 播放页布局常量 —— 样式与几何算式的**唯一真源**
 *
 * 为什么要有这个文件：本平台**没有元素测量 API**（`getBoundingClientRect / offsetLeft /
 * offsetParent` 都不保证存在，量不到返回 0）——社区应用 PenMusic 为此专门写了踩坑注释。
 * 所以「点哪跳哪」这类需要绝对坐标的交互，只能由布局常量反推。
 *
 * 约定：下面的数值单位是 **vh**（1vh = 2.4px，1020×240 实测）。
 * pages/player 的 LESS 里写的数值必须与这里**成对维护** —— 改一处要改两处，
 * LESS 那边有对应注释点出数字来源。
 */

export const VH = 2.4 // 1vh = 2.4px（1020×240 逻辑视口）
export const SCREEN_W = 1020
export const SCREEN_H = 240
/** 左侧操作栏宽度（vh）——与 NavRail.vue 的 .rail width 成对维护
 *  （2026-10-30 起全应用统一为播放页设计稿的 60px = 25vh；旧值 28vh 已废弃） */
export const RAIL_W = 25

export const PLY = {
  PAD_V: 2, // 页面上下内边距
  PAD_H: 2, // 页面左右内边距
  LEFT_W: 110, // 左列宽（封面 + 控制行所在列）—— 控制按钮要够大，列必须够宽。
  //               三调：96 → 106 → 110。控制行实宽 5×20 + 间距 2×4 = 108，
  //               列内左右各余 1vh 居中。
  //               ⚠ LESS 里这个宽度必须写 px（264px）：值 > 100 的 vh 宽度会被平台截到
  //               100vh（240px），控制行塞不进 → 按钮被压扁（见 player.vue 的 .ply-left）
  // 封面是固定正方形，边长由「左列可用高 − 控制行 − 间距」推出（当前 70vh）
  // （推导链写在 player.vue 的 .ply-coverbox 注释里），所以这里没有 COVER 常量。
  CTRL_H: 20, // 控制行高 = 控制按钮直径
  CTRL_GAP: 2, // 控制按钮之间的间距
  COVER_GAP: 2, // 封面与控制行之间的间距
  // 封面与控制按钮之间多留 1vh，从封面边长里扣（71 → 70），左列总高不变
  GAP: 3, // 左右列间距
  TITLE_H: 16, // 右列顶部「歌名·歌手 + 已播/总长」行高
  PROGRESS_H: 5, // 收起态底部只读进度条贴底所占的高度
  // ---- 进度浮窗 ----
  SEEK_PAD_H: 6, // 浮窗左右内边距
  SEEK_BTN: 23, // 左侧圆形收起按钮直径
  SEEK_GAP: 6, // 圆形按钮与进度条之间的间距
  SEEK_BAR_H: 22, // 右侧圆角矩形进度条（外框）高度
  SEEK_LINE_PAD: 6, // 进度条外框的内边距（真正可拖的那根线在里面）
  SEEK_BOTTOM: 8 // 浮窗距内容区底部
}

/**
 * 歌词行盒（行盒冻结：高度固定，切行/拖动时不跳动）
 *
 * **整首一次铺完**，没有「渲染窗口」。窗口方案的闪烁根因是窗口跟着当前行一挪、
 * 内容瞬间多/少一行与 translateY 过渡叠加；没有窗口这一步就自然不存在了。
 * 铺全部行之所以不卡，是因为行盒极轻，且 LyricPanel 的 rowsAll 只跟歌词/翻译开关有关、
 * 不跟播放进度 —— 换行时 v-for 的数组引用不变，渲染器不必重建行节点。
 *
 * ⚠ 但「整首铺开」是 `config.lyricFull=true` 时的行为。另有
 * **省性能模式**（lyricFull=false）：只铺**当前行 ±3 行（共 7 行）**并禁用拖动
 * （窗口与位移都在 LyricPanel 里，这里没有对应常量）。可视区 180px ÷ 行盒 38.4px ≈ 4.7 行，
 * 所以 7 行铺得满。
 */
export const LYRIC = {
  // 行盒高度按「主文本行高 ≈ 9.6vh、译文行高 ≈ 7.2vh」留余量：
  // 主文本行盒的余量（13 - 9.6）就是**条目之间的行距**；
  // 原文与译文之间的间距由 LyricPanel 里 .lp-main 的 margin-bottom 单独控制（已调小）。
  MAIN_H: 16, // 每行主文本的行盒高（容纳选中行的加大字号 + 撑开行距）
  TRANS_H: 7 // 翻译行高（仅该行有译文时叠加；行高已在 mainStyle 里收紧，这里相应收小）
}

/** 歌词可视区高度（vh）——右列扣掉标题行与底部进度条 */
export function lyricViewH() {
  return 100 - PLY.PAD_V * 2 - PLY.TITLE_H - PLY.PROGRESS_H
}

/** 歌词可视区高度（px） */
export function lyricViewPx() {
  return lyricViewH() * VH
}

/**
 * 进度条**可拖那根线**的几何（px）——**由常量反推，不测量元素**。
 *
 * 注意算的是「线」而不是「外框」：外框（.ply-seektrack）里还有一层内边距，
 * 线在里面。手柄与填充都是相对**线**定位的（.ply-seekline 设了 position:relative），
 * 所以这里必须给出线自身的宽，否则手柄会整体偏移。
 *
 * 从左往右：内容区左 | 浮窗内边距 | 圆钮 | 间距 | 外框内边距 | ←线→ | 外框内边距 | 浮窗内边距
 */
export function seekGeometry() {
  const railW = RAIL_W * VH
  const contentW = SCREEN_W - railW
  const leftInset = (PLY.SEEK_PAD_H + PLY.SEEK_BTN + PLY.SEEK_GAP + PLY.SEEK_LINE_PAD) * VH
  const rightInset = (PLY.SEEK_PAD_H + PLY.SEEK_LINE_PAD) * VH
  return {
    x: railW + leftInset,
    w: Math.max(1, contentW - leftInset - rightInset)
  }
}

/**
 * 屏幕尺寸：优先读 $falcon.env，读不到/不合理就退回 1020×240。
 * PenMusic 的坑：env 里可能是竖屏值，要按 max/min 纠正成横向。
 */
export function screenSize() {
  let w = SCREEN_W
  let h = SCREEN_H
  try {
    /* global $falcon */
    const e = $falcon.env || {}
    const ew = Number(e.screenWidth || e.width) || 0
    const eh = Number(e.screenHeight || e.height) || 0
    if (ew > 0 && eh > 0) {
      w = Math.max(ew, eh)
      h = Math.min(ew, eh)
    }
  } catch (err) {}
  return { w: w, h: h }
}
