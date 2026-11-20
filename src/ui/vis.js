/**
 * 页面可见性 API（S3 起实现并入 ui/mixins/dlsub.js —— dlsub 是唯一把可见性与下载
 * 订阅组合使用的封装层，合一个 chunk 避免 aiot 打包器对同目录相对引用的分裂产物）。
 * 本文件保留为转发层：既有 import '../ui/vis.js' 的消费点（NowLyric/NowProgress/
 * LyricBoard/TimerPanel/index/player/queue）不必改。
 */
export {
  markVisible,
  dropPage,
  isVisible,
  onVisChange,
  bindPageVis,
  pageOf
} from './mixins/dlsub.js'
