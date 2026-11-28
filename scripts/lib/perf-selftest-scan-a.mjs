export function runScanA({ eq, truthy, stripComments, allFiles, rel, read }) {
  {
// 3a. vis.js 与 sig.js 必须被真实引用（防止「写了没人用」）
    const users = allFiles.filter((p) => {
      const t = read(p)
      return /ui\/vis\.js|mixins\/dlsub\.js/.test(t)
    })
    truthy('vis: 至少有 5 个文件接入可见性通道（实际 ' + users.length + '）', users.length >= 5)
    const sigUsers = allFiles.filter((p) => /player\/sig\.js/.test(read(p)) && !/player\/sig\.js$/.test(rel(p)))
    truthy('sig: 至少有 2 个文件接入签名判重（实际 ' + sigUsers.length + '）', sigUsers.length >= 2)
  }

  // 3b. 播放器订阅 / 下载订阅的「裸订阅」清单必须与白名单一致（新增裸订阅会在这里露出来）
  //     白名单按「文件 + 该文件允许的订阅条数」登记：只认文件名的话，往已白名单的文件里
  //     再塞一条未门控的裸订阅不会有任何断言失败（变异测试实证过）。
  const PLAYER_ALLOW = {
    'services/player/player.js': ['发射端自己', 0],
    'services/player/sleeptimer.js': ['跨页存活的单例：模块加载时注册一次、永不注销（设计如此）', 1],
    'pages/player/player.vue': ['已门控（onTick 内判可见 + 判重）', 1],
    'pages/queue/queue.vue': ['已门控（onTick 内判可见 + 判重）', 1],
    'pages/index/index.vue': ['已门控（onPlayer 内判可见）', 1],
    'components/NowLyric.vue': ['已门控（onPlayer 内判可见）', 1],
    'components/NowProgress.vue': ['已门控（onPlayer 内判可见）', 1],
    'components/player/LyricBoard.vue': ['已门控（时钟随可见性起停）', 1]
  }
  {
    const bare = []
    for (const p of allFiles) {
      const t = read(p)
      const m = stripComments(t).match(/\bplayer\.on\s*\(/g)
      if (!m) continue
      const r = rel(p)
      const allow = PLAYER_ALLOW[r]
      if (!allow) { bare.push(r + ' 未登记'); continue }
      if (m.length !== allow[1]) bare.push(r + ' 期望 ' + allow[1] + ' 实际 ' + m.length)
    }
    eq('订阅门控: player.on 调用点都在白名单内（含条数）', bare.join(', ') || 'none', 'none')
  }

  const DL_ALLOW = {
    'ui/mixins/dlsub.js': ['封装层自己', 1],
    'services/player/tasks.js': ['发射端自己', 1],
    'services/player/download.js': ['门面转出', 0]
  }
  {
    const bare = []
    for (const p of allFiles) {
      const t = read(p)
      const m = stripComments(t).match(/\bonDl\s*\(/g)
      if (!m) continue
      const r = rel(p)
      const allow = DL_ALLOW[r]
      if (!allow) { bare.push(r + ' 未登记'); continue }
      if (m.length !== allow[1]) bare.push(r + ' 期望 ' + allow[1] + ' 实际 ' + m.length)
    }
    eq('订阅门控: onDl 调用点都在白名单内（含条数）', bare.join(', ') || 'none', 'none')
  }

  {
// 3c. 每个 bindDl 的返回值都要被调用（否则订阅泄漏 + 可见性订阅泄漏）
    const users = allFiles.filter((p) => /\bbindDl\s*\(/.test(read(p)))
    let loose = []
    for (const p of users) {
      if (rel(p) === 'ui/mixins/dlsub.js') continue 
      const t = read(p)
      if (!/this\._dlOff\s*\(\)/.test(t)) loose.push(rel(p))
    }
    eq('bindDl: 每个调用点都释放了订阅', loose.join(', ') || 'none', 'none')
  }

  {
// 3d. bindPageVis 的返回值同样必须释放
    const users = allFiles.filter((p) => /\bbindPageVis\s*\(/.test(read(p)) &&
      !/utils\/ui\/vis\.js$/.test(rel(p)) &&
      rel(p) !== 'ui/mixins/dlsub.js') 
    const loose = []
    for (const p of users) {
      const t = read(p)
      if (!/this\._visOff\s*\(\)/.test(t)) loose.push(rel(p))
    }
    eq('bindPageVis: 每个调用点都释放了订阅', loose.join(', ') || 'none', 'none')
  }

  {
// 3e. 不能写 WeakMap / Map / Set（QuickJS 上未验证；vis.js 用的是数组）
    const banned = []
    for (const p of allFiles) {
      const t = read(p)
      if (/new\s+(WeakMap|Map|Set)\s*\(/.test(t)) banned.push(rel(p))
    }
    eq('容器: 未引入未验证的 WeakMap/Map/Set', banned.join(', ') || 'none', 'none')
  }

  {
// 3f. 播放页子面板：订阅回调入口必须自己判可见。
// 播放单例每 500ms 发一次快照、定时模块每 1000ms 发一次倒计时；子面板被「播放页隐藏」
// 或「子面板没开」时这些 tick 只是白写 data 触发重渲染 —— 回调第一行必须 early return。
// 按「订阅那一行后 4 行内出现 _visible 判定」做静态断言，防止后续改回去。
    const SUBS = [
      ['components/player/LyricBoard.vue', 'player.on'],
      ['components/player/TimerPanel.vue', 'sleepTimer.on']
    ]
    const bad = []
    for (const [file, call] of SUBS) {
      const p = allFiles.find((x) => rel(x) === file)
      if (!p) { bad.push(file + '(缺失)'); continue }
      const lines = read(p).split('\n')
      const at = lines.findIndex((l) => l.includes(call + '('))
      if (at < 0) { bad.push(file + '(无 ' + call + ')'); continue }

      const win = lines.slice(Math.max(0, at - 6), at + 5).join('\n')
      if (!/_visible/.test(win)) bad.push(file)
    }
    eq('子面板门控: 订阅回调入口判可见', bad.join(', ') || 'none', 'none')
  }
}
