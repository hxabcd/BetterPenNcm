export function runScanB({ eq, allFiles, rel, read }) {
  // 3g. sleepTimer 的裸订阅同样要登记（新增调用点会在这里露出来）
  const SLEEP_ALLOW = {
    'services/player/sleeptimer.js': '发射端自己',
    'components/player/TimerPanel.vue': '已门控（_sub 内判可见）',
    'pages/player/player.vue': '只写 timerOn 布尔（值不变时 Vue 的 setter 直接返回，不重渲染），且要驱动定时结束 toast'
  }
  {
    const bare = []
    for (const p of allFiles) {
      if (!/\bsleepTimer\.on\s*\(/.test(read(p))) continue
      const r = rel(p)
      if (SLEEP_ALLOW[r]) continue
      bare.push(r)
    }
    eq('订阅门控: sleepTimer.on 调用点都在白名单内', bare.join(', ') || 'none', 'none')
  }

  {

    const targets = [
// 3h. 页面会挂两遍（平台坑 6）：bindDl / bindPageVis 必须自己幂等
//     —— 第二次 mounted 覆盖 this._dlOff / this._visOff 时，先释放上一组，
//        否则旧订阅成为孤儿（每次广播还在往旧回调灌数据，且再也没人释放）。
      ['ui/mixins/dlsub.js', 'vm._dlOff()'],
      ['ui/mixins/dlsub.js', 'vm._visOff()'],
      ['ui/mixins/accent.js', 'unbindTheme(vm._accentOff)']
    ]
    const bad = []
    for (const [file, needle] of targets) {
      const p = allFiles.find((x) => rel(x) === file)
      if (!p) { bad.push(file + '(缺失)'); continue }
      if (read(p).indexOf(needle) < 0) bad.push(file)
    }
    eq('重复挂载: 订阅封装自己幂等（先释放上一组）', bad.join(', ') || 'none', 'none')
  }

  {
    const targets = [
// 3i. 高频广播的订阅回调必须自己判重（平台坑 16：watch/回调不去重）
//     —— 播放快照每 500ms、下载活动每 400ms、倒计时每 1s 各来一发。回调里直接写 data
//        就是按广播频率重渲染整块子树；判重后才真正只在「显示出来的东西变了」时更新。
//     每项登记该文件实际用的判重标记：换了写法要同步改这张表，删掉判重则直接失败。
      ['pages/index/index.vue', '_dlSig'],
      ['pages/list/list.vue', '_dlSig'],
      ['pages/album/album.vue', '_dlSig'],
      ['pages/plinfo/plinfo.vue', '_dlSig'],
      ['pages/downloads/downloads.vue', '_dlSig'],
      ['pages/dltracks/dltracks.vue', '_dlSig'],
      ['pages/dlqueue/dlqueue.vue', '_sig'],
      ['pages/queue/queue.vue', '_feed'],
      ['pages/player/player.vue', '_feed'],
      ['components/NowLyric.vue', '_key'],

      // 这两个在回调体内逐字段比对后写 data（见各自 onPlayer）
      ['components/NowProgress.vue', 'pct === this.pct'],
      ['components/player/LyricBoard.vue', '_visible']
    ]
    const bad = []
    for (const [file, needle] of targets) {
      const p = allFiles.find((x) => rel(x) === file)
      if (!p) { bad.push(file + '(缺失)'); continue }
      if (read(p).indexOf(needle) < 0) bad.push(file + '(无 ' + needle + ')')
    }
    eq('订阅判重: 高频广播的回调自己不重复写 data', bad.join(', ') || 'none', 'none')
  }
}
