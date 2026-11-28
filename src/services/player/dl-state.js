// 媒体源层（拆分自 download.js）：跨文件共享的模块级可变状态。
// ES module 在小程序里是同一实例，拆开后各文件 import 的都是这一份，不会出现两份副本。
export const st = {
  // 正在跑的 downloadSongs 批次数：pendingDrop 据此判断「是不是最后一批」
  activeBatches: 0,
  // 退出流程已开始：不再发详情/歌词请求、不再续传、不再存 dl_pending
  exiting: false
}
