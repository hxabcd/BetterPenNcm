import { sleep } from '../../core/infra/util.js'
import { fileSize, rmQuiet } from '../../core/platform/fsutil.js'
import { download as httpDownload } from '../../core/infra/net/request.js'
import { ensureParentDir } from './fetch-common.js'

// 回退通道：运行时内建 http.download（整文件一次；失败删掉半截，避免被当成缓存）。
// **不支持取消**：整文件一次调用没法中途停；调用后若已取消则判为 aborted，由上层删文件。
export async function builtinFetch(opts) {
  const path = opts.outPath
  try {
    await ensureParentDir(path)
    await httpDownload({ url: opts.url, outPath: path })
    let size = await fileSize(path)

    // http.download 返回时最后 4KB 可能还没 flush（实测 1KB 首查 0、1MB 少 4096，100ms 后完整）。
    // 该通道只在 curl 不可用时启用；短暂等待后再交给上层做 90% 校验，避免 4KB 缺口被当成完整文件。
    
    for (let i = 0; i < 2 && (!size || (opts.total && size < opts.total)); i++) {
      await sleep(50)
      size = await fileSize(path)
    }
    if (opts.onProgress) opts.onProgress(size, opts.total || 0, 0)
    if (opts.shouldAbort && opts.shouldAbort()) {
      return { ok: false, size: size, mode: 'builtin', aborted: true, error: '已取消' }
    }
    return { ok: true, size: size, mode: 'builtin', error: '' }
  } catch (e) {
    // 清残留半截，避免被当成缓存
    await rmQuiet(path) 
    return { ok: false, size: 0, mode: 'builtin', error: '下载失败: ' + ((e && e.message) || e) }
  }
}
