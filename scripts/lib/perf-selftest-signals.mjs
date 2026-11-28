export function runSignals({ sig, vis, eq, truthy, base }) {
  const f = sig.sigFeed(sig.viewSig)
  truthy('viewSig: 首帧判为变化', f(base))
  truthy('viewSig: 同一快照判为未变', !f(JSON.parse(JSON.stringify(base))))

  // 进度按 0.1% 一档量化（与播放页进度条显示精度对齐）：
  //   1000/200000 = 0.50%   vs   1020/200000 = 0.51% → 同一档 → 不该重渲染
  //   1000/200000 = 0.50%   vs   3000/200000 = 1.50% → 跨档 → 该重渲染
  truthy('viewSig: 0.1% 以内的进度差判为未变', !f({ ...base, positionMs: 1020 }))
  truthy('viewSig: 进度跨 0.1% 档判为变化', f({ ...base, positionMs: 3000 }))
  truthy('viewSig: 时间文本跨秒但进度档未变 → 仍判变化', f({ ...base, positionMs: 2100 }))
  truthy('viewSig: 换歌判为变化', f({ ...base, cur: { ...base.cur, id: 43 } }))
  truthy('viewSig: 换歌名判为变化', f({ ...base, cur: { ...base.cur, name: '新歌名' } }))
  truthy('viewSig: 换歌手判为变化', f({ ...base, cur: { ...base.cur, artist: '新歌手' } }))
  truthy('viewSig: 换封面判为变化', f({ ...base, cur: { ...base.cur, cover: 'file:///d.jpg' } }))
  truthy('viewSig: 暂停态变化判为变化', f({ ...base, paused: true }))
  truthy('viewSig: 循环模式变化判为变化', f({ ...base, loopMode: 'single' }))
  truthy('viewSig: 状态文案变化判为变化', f({ ...base, status: '缓冲中' }))

  {
// 进度量化：0.1% 一档 → 199999/200000 与 200000/200000 都应当落到 100.0
    const a = sig.viewSig({ ...base, positionMs: 199950 })
    const b = sig.viewSig({ ...base, positionMs: 199990 })
    eq('viewSig: 0.1% 以内的进度差视作同一档', a === b, true)
  }

  const qf = sig.sigFeed(sig.queueViewSig)
  truthy('queueViewSig: 首帧判为变化', qf(base))
  truthy('queueViewSig: 同一快照判为未变', !qf(JSON.parse(JSON.stringify(base))))
  truthy('queueViewSig: 队列变长判为变化', qf({ ...base, queue: base.queue.concat([{ id: 9 }]) }))
  truthy('queueViewSig: 队首换歌判为变化', qf({ ...base, queue: [{ id: 99 }].concat(base.queue.slice(1)) }))
  truthy('queueViewSig: 当前索引变化判为变化', qf({ ...base, index: 4 }))

  // queueSig：大列表不能逐首拼（这里只验证语义：长度或采样变了要能发现）
  eq('queueSig: 空队列', sig.queueSig([]), '0')
  eq('queueSig: 长度计入签名', sig.queueSig([{ id: 1 }]).split(':')[0], '1')
  {
    const big = []
    for (let i = 0; i < 2000; i++) big.push({ id: i })
    const s = sig.queueSig(big)
    truthy('queueSig: 2000 首签名长度可控（<400 字符）', s.length < 400)
    truthy('queueSig: 2000 首签名含长度', s.indexOf('2000:') === 0)
  }

  const p1 = { $pageName: 'index' }
  const calls = []
  vis.markVisible(p1, true, 'test')
  eq('vis: 未知页面默认可见', vis.isVisible(p1), true)
  const off = vis.onVisChange(p1, (on) => calls.push(on))
  vis.markVisible(p1, false, 'hide')
  vis.markVisible(p1, true, 'show')
  vis.markVisible(p1, true, 'show') 
  eq('vis: hide→show 回调序列', calls.join(','), 'false,true')
  off()
  vis.markVisible(p1, false, 'hide')
  eq('vis: 取消订阅后不再回调', calls.join(','), 'false,true')

  {
    const got = []
// bindPageVis：组件从 $root 找页面
    const vm = { $root: { $page: p1 } }
    const off2 = vis.bindPageVis(vm, (on) => got.push(on))
    eq('bindPageVis: 立即回调当前真值', got.join(','), 'false')
    vis.markVisible(p1, true, 'show')
    eq('bindPageVis: 变化时回调', got.join(','), 'false,true')
    off2()
  }

  {
    const got = []
// 取不到页面：fail-open（回调一次 true，不订阅）
    const off3 = vis.bindPageVis({ $root: {} }, (on) => got.push(on))
    eq('bindPageVis: 无页面对象时按可见回调一次', got.join(','), 'true')
    off3()
  }

  {
// dropPage：退栈后条目被摘掉 → 回到默认可见
    const p2 = { $pageName: 'queue' }
    vis.markVisible(p2, false, 'hide')
    eq('vis: 隐藏生效', vis.isVisible(p2), false)
    vis.dropPage(p2)
    eq('vis: dropPage 后回到默认可见', vis.isVisible(p2), true)
  }
}
