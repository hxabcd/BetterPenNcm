/**
 * 页面可见性 API（转发层）
 *
 * 实现在 `core/infra/vis.js`：可见性事实由 `core/infra/nav.js` 写入，UI 只是消费者；
 * 放在 ui 会构成 infra→ui 反向依赖（分层 R6）。本文件保留既有 import 路径，
 * NowLyric / NowProgress / LyricBoard / TimerPanel / index / player / queue 不必改。
 */
export {
  markVisible,
  dropPage,
  isVisible,
  onVisChange,
  bindPageVis,
  pageOf
} from '../core/infra/vis.js'
