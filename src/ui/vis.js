

// 页面可见性 API 的转发层：实现在 core/infra/vis.js（可见性事实由 nav.js 写入，UI 只是消费者；
// 写在 ui 会构成 infra→ui 反向依赖，分层 R6）。保留本路径是为了不改既有 import。
export {
  markVisible,
  dropPage,
  isVisible,
  onVisChange,
  bindPageVis,
  pageOf
} from '../core/infra/vis.js'
