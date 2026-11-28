export function runScanC({ fs, path, SRC, eq, truthy, stripComments, allFiles, rel, read, inf }) {
  {
// 3j. 列表行不得在模板里现算样式对象
//     `:style="rowStyle(i)"` 走 methods 时，Vue **不缓存**返回值：每次渲染、每行都重新调一遍并
//     新建一个对象。一窗 50 行 × 4 个样式方法 = 200 次调用 + 200 个 object，全部是同一份派生数据。
//     正确写法是 computed 里算好整窗（见 queue.vue 的 rows），模板只读字段；或者像 LyricTrack 那样
//     方法体只 `return r.sRow`（读事先算好的字段，不新建对象）。
//     这条断言只盯「方法体只做防御性读取」的白名单，其余一律要求走 computed。
    const ALLOW = {

      // 方法体只有一句 return <参数>.<字段>（不新建对象），等价于直接绑字段
      'components/player/LyricTrack.vue': 'rowStyle',

      
      // 下面几处都是**固定小规模**选项，不是 50 行量级的长列表：
      // 分类/排序 key、弹出菜单项、数字键盘（3 行 × 3 键）
      'components/list/SearchSidebar.vue': 'catStyle',
      'components/ContextSheet.vue': 'optStyle',
      'components/player/TimerPanel.vue': 'keyStyle'
    }
    const bad = []
    for (const p of allFiles) {
      if (!p.endsWith('.vue')) continue
      const r = rel(p)
      const src = read(p)

      const hits = src.split('\n').filter((l) => /v-for=/.test(l) && /:style="\s*[A-Za-z_$][\w$]*\(/.test(l))
      if (!hits.length) continue
      const allow = ALLOW[r]
      if (!allow) bad.push(r + '(' + (hits[0].match(/:style="\s*([A-Za-z_$][\w$]*)\(/) || [])[1] + ')')
    }

    // 白名单本身也要在：文件被删/改编要提醒同步这张表
    const stale = []
    for (const f of Object.keys(ALLOW)) {
      if (!allFiles.some((x) => rel(x) === f)) stale.push(f + '(缺失)')
    }
    eq('列表行样式: v-for 内不逐行现算样式对象', bad.concat(stale).join(', ') || 'none', 'none')
  }

  {
// 3k. 滚到底自动续页：判定纯函数与接入点。
// 判定只依赖已实测的 contentOffset.y；拿不到位移/底部、或内容不足一屏时
// 静默退回按钮翻页（fail-closed 降级）。短列表保护是重点：hasMore 为真是
// 「服务端还有」，不等于「当前内容已能滚到底」。
    const EV = (y) => ({ contentOffset: { y } })
    const vm = { infiniteBottomPx: 1000, infiniteViewportPx: 200 } 

    truthy('infinite: 接近底部触发', inf.shouldLoad(EV(700), vm, true))
    truthy('infinite: 离底部远不触发', !inf.shouldLoad(EV(100), vm, true))
    truthy('infinite: 没有下一批不触发', !inf.shouldLoad(EV(700), vm, false))
    truthy('infinite: 恰好在预加载边界触发', inf.shouldLoad(EV(640), vm, true)) 

    // 短列表保护（S1：曾因 bottom≤360 在 y=0 即连加多批）
    truthy('infinite: y=0 不触发（滚动前/回弹）', !inf.shouldLoad(EV(0), vm, true))
    truthy('infinite: 负 y 不触发', !inf.shouldLoad(EV(-5), vm, true))
    truthy('infinite: 非数字 y 不触发(NaN fail-closed)', !inf.shouldLoad({ contentOffset: { y: 'abc' } }, vm, true))
    truthy('infinite: 内容不足一屏不触发', !inf.shouldLoad(EV(120), { infiniteBottomPx: 200 }, true))
    truthy('infinite: 内容恰等于一屏不触发', !inf.shouldLoad(EV(120), { infiniteBottomPx: 200, infiniteViewportPx: 200 }, true))
    truthy('infinite: 内容刚过一屏且已滚到近底可触发', inf.shouldLoad(EV(50), { infiniteBottomPx: 205 }, true))

    // fail-closed 与字段兜底
    truthy('infinite: 缺滚动位移不触发', !inf.shouldLoad({}, vm, true))
    truthy('infinite: 缺内容底部且事件无 contentSize 不触发', !inf.shouldLoad(EV(700), {}, true))
    truthy('infinite: 空列表估算 0 且 contentSize 为 0 不触发', !inf.shouldLoad(EV(700), { infiniteBottomPx: 0 }, true))
    truthy('infinite: contentHeight 兜底生效', inf.shouldLoad({ contentOffset: { y: 3700 }, contentHeight: 4000 }, {}, true))

    // 事件 contentSize 与页面估算取较大者（估算漏算 hero 等固定内容）
    eq('infinite: contentBottom 取估算与事件较大者', inf.contentBottom({ contentSize: { height: 5000 } }, vm), 5000)
    eq('infinite: 估算更大时取估算', inf.contentBottom({ contentSize: { height: 500 } }, vm), 1000)
    eq('infinite: 两者皆无返回 null', inf.contentBottom({}, {}), null)

    // 视口覆盖：0/非法退回默认，正常值生效
    truthy('infinite: infiniteViewportPx=0 退回默认仍可触发', inf.shouldLoad(EV(700), { infiniteBottomPx: 1000, infiniteViewportPx: 0 }, true))
  }
  {
    const INF_PAGES = [
      'pages/list/list.vue', 'pages/playlists/playlists.vue', 'pages/album/album.vue',
      'pages/dlartists/dlartists.vue', 'pages/dlalbums/dlalbums.vue',
      'pages/dlplaylists/dlplaylists.vue', 'pages/dltracks/dltracks.vue'
    ]
    const missing = []
    for (const f of INF_PAGES) {
      const t = fs.readFileSync(path.join(SRC, f), 'utf8')
      const c = stripComments(t)

      
      // S3 后 infiniteBottomPx/AUTO_BATCH 收进 ui/mixins/listpage.js，页面判据换成
      // listPageConfig（切片数组 + 行高）仍在
      const ok = /@scroll="onInfiniteScroll"/.test(t) && /infiniteScrollMixin/.test(c) &&
        /hasMore/.test(c) && /loadMore\(/.test(c) && /listPageConfig/.test(c)
      if (!ok) missing.push(f)
    }
    eq('自动续页: 接入页四要件齐全(@scroll/mixin/估算/hasMore/loadMore/AUTO_BATCH)', missing.join(', ') || 'none', 'none')
    const EXCLUDE = ['pages/queue/queue.vue', 'pages/dlqueue/dlqueue.vue', 'pages/artist/artist.vue']
    const leaked = []
    for (const f of EXCLUDE) {
      const t = fs.readFileSync(path.join(SRC, f), 'utf8')
      if (/onInfiniteScroll/.test(t)) leaked.push(f)
    }
    eq('自动续页: 锚定/多段/嵌套 scroller 页不接入', leaked.join(', ') || 'none', 'none')

    // mixin 用实例普通属性而非 data，并清理定时器（平台坑 6 / perf 约定）
    const mix = fs.readFileSync(path.join(SRC, 'ui/mixins/infinite.js'), 'utf8')
    truthy('自动续页: 冷却标志不进 data(_ 前缀)', !/data\s*\(/.test(mix) && /created\s*\(/.test(mix))
    truthy('自动续页: beforeDestroy 清理定时器', /beforeDestroy/.test(mix) && /clearTimeout/.test(mix))
    truthy('自动续页: loadMore 后解锁(防同一 y 连锁)', /\.then\(unlock, unlock\)/.test(mix))
  }
}
