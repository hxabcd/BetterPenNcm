

// 视口几何 —— 页面布局视口的唯一真源（跨机型）。放在 platform 层是因为视口尺寸是平台事实：
// ui/ 的网格计算与 services/player/ 的播放页几何都要用它（分层 R6）。
// 三个机型族实测值：
//   S7  ：1020×240，1vh = 2.4px
//   X3S ：800×254（物理面板 480×800 竖屏，运行时按 /etc/miniapp/resources/cfg.json 的
//         800×254 横条居中渲染），1vh = 2.54px
//   X5  ：800×254，1vh = 2.54px
//
// ⚠ 不要读 `$falcon.env.deviceHeight` 当 CSS 视口高：它给的是物理面板尺寸（X3S 是 480），
// 页面实际只有 254 高；按 480 算 vh 会把整套布局放大一倍。
// ⚠ 宽度一律用 px：平台会静默截断 >100vh 的 **vh 宽度**（S7 上 172vh 渲染成 239px），
// 所以可能超过 100vh 的宽度只能给 px；给百分比则会随容器/机型漂移（2026-11-22 X3S 实测：
// 按百分比排的卡片在 800 宽下右沿溢出、末卡被裁）。

/** S7 基准视口（env 读不到时的兜底） */
export const SCREEN_W = 1020
export const SCREEN_H = 240

/** 左侧导航栏宽度（vh）：全应用统一的 25vh（60px@S7 / 63.5px@X3S） */
export const RAIL_W = 25

/** 窄屏族阈值：宽度 ≤ 900 视为 800 宽族（X3S / X5） */
const NARROW_W = 900

/** 窄屏族页面视口（实测 800×254） */
const NARROW_H = 254
const NARROW_VIEW_W = 800

/** 屏幕尺寸（**页面布局视口**）。读不到/不合理退回 1020×240。 */
export function screenSize() {
  let w = SCREEN_W
  let h = SCREEN_H
  try {
    /* global $falcon */
    const e = $falcon.env || {}
    const ew = Number(e.screenWidth || e.width || e.deviceWidth) || 0
    const eh = Number(e.screenHeight || e.height || e.deviceHeight) || 0
    if (ew > 0 && eh > 0) {
      w = Math.max(ew, eh)
      h = Math.min(ew, eh)
    }
  } catch (err) {}
  if (w > 0 && w <= NARROW_W) {
    w = NARROW_VIEW_W
    h = NARROW_H
  }
  return { w: w, h: h }
}

/** 1vh 的像素值（S7 2.4 / X3S·X5 2.54） */
export function vhPx() {
  return screenSize().h / 100
}

/** vh 数 → px（**宽度用它，别直接写 vh 宽度**，见文件头） */
export function vh(n) {
  return Math.round((Number(n) || 0) * vhPx())
}

/**
 * 是否窄屏族（X3S / X5，页面视口 800×254）：播放页三列装不下，改「控制区铺满 + 右侧抽屉」；
 * 卡片网格的列数也按这个族重算。
 */
export function isNarrow() {
  return screenSize().w <= NARROW_W
}

/**
 * 内容区宽度（px）= 视口宽 − 左栏。
 * `railVh` 默认 25（全应用统一的左栏宽）；播放页等自绘布局可传别的值。
 */
export function contentWidthPx(railVh) {
  const rail = vh(railVh === undefined ? RAIL_W : railVh)
  return Math.max(1, screenSize().w - rail)
}

/**
 * 卡片网格：按内容区宽度自动选列数（2/3/4），并给出该列数下每张卡的整数 px 宽。
 *
 * 卡宽在设计稿里是固定 vh（PlaylistCard 92.5vh）或百分比（AlbumCard），两者随机型都会失真 ——
 * 固定 vh 排「4 列」在 800 宽上放不下（末卡溢出被裁），百分比又随容器漂移。这里按「每张卡至少
 * minCardVh 宽」反推列数，再把剩余宽度均分成整数 px 交给卡片的 widthPx，末列永远不会顶出右沿。
 * S7（1020 宽）给 4 列、X3S/X5（800 宽）给 3 列。
 *
 * @param minCardVh 单张卡**最小可接受**宽度（vh）；小于它就换少一列
 * @param gapVh     卡间距（vh，默认 5）
 * @param padVh     列表左右内边距合计（vh，默认 7：左 6 + 右 1）
 * @param max       列数上限（默认 4；页面「列数」菜单选了值就传它）
 * @returns {cols, cardWpx}
 */
export function fitColumns(minCardVh, gapVh, padVh, max) {
  const px = vhPx()
  const gap = (gapVh === undefined ? 5 : gapVh) * px
  const cap = max || 4
  const minW = (minCardVh === undefined ? 76 : minCardVh) * px
  const avail = gridAvailPx(padVh)
  let cols = cap
  while (cols > 2) {

    // cols 张卡 + (cols-1) 个间距（末卡的右间距由列表 padding 吃掉）
    if (minW * cols + gap * (cols - 1) <= avail) break
    cols--
  }
  return { cols: cols, cardWpx: cardWidthPx(cols, gapVh, padVh) }
}

/** 网格可用宽（px）= 内容区 − 列表左右内边距 */
function gridAvailPx(padVh) {
  return Math.max(1, contentWidthPx() - (padVh === undefined ? 7 : padVh) * vhPx())
}

/**
 * 指定列数下每张卡的 px 宽（均分剩余宽度）。
 * 用户显式选了列数（如「列数 4」）但屏幕装不下时，卡就变窄 —— 不溢出、不裁切。
 */
export function cardWidthPx(cols, gapVh, padVh) {
  const px = vhPx()
  const n = cols === 2 ? 2 : cols === 3 ? 3 : 4
  const gap = (gapVh === undefined ? 5 : gapVh) * px
  return Math.max(1, Math.floor((gridAvailPx(padVh) - gap * (n - 1)) / n))
}
