

// 单步超时护栏：下载/落库流程里任何一步的 promise 永久挂起（import/exec/HTTP/存储都见过挂死的
// 先例），都会把 pump 的 running 钉死 —— 之后所有缓存/seek/续播全卡在「缓冲中」。
// 这里给每个高危 await 一个上限：超时按 fallback 走，让队列继续；只挡挂死，不改正常路径。
// ⚠ 超时 ≠ 取消：超时只是让调用方拿到 fallback，被放弃的 promise 仍在后台继续跑完（含写缓存等
// 副作用 —— 缓存写入幂等，不会产生坏数据）。调用方若在超时后重试同一目标，后台那次可能仍在进行；
// 互斥靠各调用链自己的去重表兜底（如 download.js 的 inflight / ensureWait）
export function raceTimeout(p, ms, fallback) {
  return new Promise(function (resolve) {
    let done = false
    const t = setTimeout(function () {
      if (done) return
      done = true
      resolve(fallback)
    }, ms)
    Promise.resolve(p).then(
      function (v) {
        if (done) return
        done = true
        clearTimeout(t)
        resolve(v)
      },
      function () {
        if (done) return
        done = true
        clearTimeout(t)
        resolve(fallback)
      }
    )
  })
}

export function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms)
  })
}
