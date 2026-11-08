#!/usr/bin/env node
/**
 * 渲染性能自检 —— 纯逻辑，不需要设备。
 *
 * 覆盖三块「改了就会悄悄退化、但看代码看不出来」的约定：
 *   1. 签名判重（utils/player/sig.js）：同一快照必须判为「没变」，
 *      任何界面可见字段变化必须判为「变了」。漏判 = 界面停在旧值，误判 = 白渲染。
 *   2. 页面可见性（utils/ui/vis.js）：默认可见、hide/show 切换、unload 摘除、
 *      退栈把栈顶救回可见（fail-open 兜底）。
 *   3. 静态扫描：易退化的调用点是否都走了门控（裸 player.on / 裸 onDl 的清单比对）。
 *
 * 为什么要有这个脚本：这些优化本身的产物是「少渲染」，跑不出可见差异，
 * 所以在没有真机的环境里只能靠**约束测试**守住语义。
 *
 * 用法：node scripts/perf_selftest.mjs        （全绿 exit 0，有失败 exit 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')

let pass = 0
const fail = []
function ok(name) {
  pass++
}
function bad(name, detail) {
  fail.push(name + (detail ? '  → ' + detail : ''))
}
function eq(name, got, want) {
  if (String(got) === String(want)) ok(name)
  else bad(name, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want))
}
function truthy(name, v) {
  if (v) ok(name)
  else bad(name, 'expected truthy, got ' + JSON.stringify(v))
}

/**
 * 去掉注释再做静态扫描：注释里出现的 `player.on(...)` / `onDl(...)` 只是文档示例
 * （player.js 头部用法说明、dlvis.js 背景说明），算进调用条数会让断言误报。
 * 不追求完整 JS 词法，只处理块注释、行注释和字符串字面量这三类会把代码「藏起来」的情况。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      out += ' '
    } else if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i)
      i = end < 0 ? n : end
      out += ' '
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c
      let j = i + 1
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j++
        j++
      }
      out += src.slice(i, Math.min(j + 1, n))
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

/* ---------- 0. 把源码模块搬进 Node 能跑的沙箱 ---------- */
/**
 * src 里的模块是 .js 且带 import 说明符，但都直接吃 Node 语义（无第三方依赖）。
 * 唯一麻烦是 fmtDur / log 之类会牵出平台模块，所以 sig.js 只依赖 format.js（纯函数）。
 * vis.js 依赖 log.js（会去 POST），这里打桩掉。
 */
const sandbox = path.join(ROOT, '.perf_selftest_tmp')
fs.rmSync(sandbox, { recursive: true, force: true })
fs.mkdirSync(sandbox, { recursive: true })
// 沙箱里的模块是 ESM：声明 type=module 免得 Node 走「先按 CJS 解析再重解析」并打警告
fs.writeFileSync(path.join(sandbox, 'package.json'), '{ "type": "module" }\n')

function stage(relSrc, relDst /*, patch */) {
  const from = path.join(SRC, relSrc)
  let code = fs.readFileSync(from, 'utf8')
  const out = path.join(sandbox, relDst)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, code)
  return out
}

// format.js 原样搬（纯函数）
stage('utils/format.js', 'format.js')
// sig.js：把 '../format.js' 改成同目录，其余原样
{
  const code = fs
    .readFileSync(path.join(SRC, 'utils/player/sig.js'), 'utf8')
    .replace(/from '\.\.\/format\.js'/g, "from './format.js'")
  fs.writeFileSync(path.join(sandbox, 'sig.js'), code)
}
// vis.js：log.js 打桩
fs.writeFileSync(path.join(sandbox, 'log.js'), 'export function log() {}\n')
{
  const code = fs
    .readFileSync(path.join(SRC, 'utils/ui/vis.js'), 'utf8')
    .replace(/from '\.\.\/log\.js'/g, "from './log.js'")
  fs.writeFileSync(path.join(sandbox, 'vis.js'), code)
}

const sig = await import('file://' + path.join(sandbox, 'sig.js').replace(/\\/g, '/'))
const vis = await import('file://' + path.join(sandbox, 'vis.js').replace(/\\/g, '/'))

// infinite.js 无外部依赖，原样搬进沙箱测纯判定函数
stage('utils/ui/infinite.js', 'infinite.js')
const inf = await import('file://' + path.join(sandbox, 'infinite.js').split(path.sep).join('/'))

/* ---------- 1. 签名判重 ---------- */
const base = {
  cur: { id: 42, name: '歌名', artist: '歌手', album: '专辑', cover: 'file:///c.jpg', durationMs: 200000 },
  isPlaying: true,
  paused: false,
  loopMode: 'list',
  rate: 1,
  cached: false,
  positionMs: 1000,
  durationMs: 200000,
  status: '',
  index: 3,
  queue: [{ id: 1 }, { id: 2 }, { id: 42 }, { id: 7 }]
}

const f = sig.sigFeed(sig.viewSig)
truthy('viewSig: 首帧判为变化', f(base))
truthy('viewSig: 同一快照判为未变', !f(JSON.parse(JSON.stringify(base))))
// 进度按 0.1% 一档量化（与播放页进度条的显示精度对齐）：
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

// 进度量化：0.1% 一档 → 199999/200000 与 200000/200000 都应当落到 100.0
{
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

/* ---------- 2. 页面可见性 ---------- */
const p1 = { $pageName: 'index' }
const calls = []
vis.markVisible(p1, true, 'test')
eq('vis: 未知页面默认可见', vis.isVisible(p1), true)
const off = vis.onVisChange(p1, (on) => calls.push(on))
vis.markVisible(p1, false, 'hide')
vis.markVisible(p1, true, 'show')
vis.markVisible(p1, true, 'show') // 重复同值：不应再回调
eq('vis: hide→show 回调序列', calls.join(','), 'false,true')
off()
vis.markVisible(p1, false, 'hide')
eq('vis: 取消订阅后不再回调', calls.join(','), 'false,true')

// bindPageVis：组件从 $root 找页面
{
  const got = []
  const vm = { $root: { $page: p1 } }
  const off2 = vis.bindPageVis(vm, (on) => got.push(on))
  eq('bindPageVis: 立即回调当前真值', got.join(','), 'false')
  vis.markVisible(p1, true, 'show')
  eq('bindPageVis: 变化时回调', got.join(','), 'false,true')
  off2()
}
// 取不到页面：fail-open（回调一次 true，不订阅）
{
  const got = []
  const off3 = vis.bindPageVis({ $root: {} }, (on) => got.push(on))
  eq('bindPageVis: 无页面对象时按可见回调一次', got.join(','), 'true')
  off3()
}
// dropPage：退栈后条目被摘掉 → 回到默认可见
{
  const p2 = { $pageName: 'queue' }
  vis.markVisible(p2, false, 'hide')
  eq('vis: 隐藏生效', vis.isVisible(p2), false)
  vis.dropPage(p2)
  eq('vis: dropPage 后回到默认可见', vis.isVisible(p2), true)
}

/* ---------- 3. 静态扫描：高频订阅是否都走了门控 ---------- */
function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(vue|js)$/.test(name)) out.push(p)
  }
  return out
}
const allFiles = walk(SRC, [])
const rel = (p) => path.relative(SRC, p).replace(/\\/g, '/')
const read = (p) => fs.readFileSync(p, 'utf8')

// 3a. vis.js 与 sig.js 必须被真实引用（防止「写了没人用」）
{
  const users = allFiles.filter((p) => {
    const t = read(p)
    return /ui\/vis\.js|player\/dlvis\.js/.test(t) && !/utils\/(ui\/vis|player\/dlvis)\.js$/.test(p)
  })
  truthy('vis: 至少有 5 个文件接入可见性通道（实际 ' + users.length + '）', users.length >= 5)
  const sigUsers = allFiles.filter((p) => /player\/sig\.js/.test(read(p)) && !/player\/sig\.js$/.test(rel(p)))
  truthy('sig: 至少有 2 个文件接入签名判重（实际 ' + sigUsers.length + '）', sigUsers.length >= 2)
}

// 3b. 播放器订阅 / 下载订阅的「裸订阅」清单必须与白名单一致
//     （新增裸订阅会在这里露出来 —— 位置要么加门控，要么在下面登记理由）
//    白名单按「文件 + 该文件允许的订阅条数」登记：只认文件名的话，往已白名单的文件里
//    再塞一条未门控的裸订阅不会有任何断言失败（变异测试实证过）。
const PLAYER_ALLOW = {
  'utils/player/player.js': ['发射端自己', 0],
  'utils/player/sleeptimer.js': ['跨页存活的单例：模块加载时注册一次、永不注销（设计如此）', 1],
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
  'utils/player/dlvis.js': ['封装层自己', 1],
  'utils/player/tasks.js': ['发射端自己', 1],
  'utils/player/download.js': ['门面转出', 0]
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

// 3c. 每个 bindDl 的返回值都要被调用（否则订阅泄漏 + 可见性订阅泄漏）
{
  const users = allFiles.filter((p) => /\bbindDl\s*\(/.test(read(p)))
  let loose = []
  for (const p of users) {
    if (rel(p) === 'utils/player/dlvis.js') continue // 定义处自己
    const t = read(p)
    if (!/this\._dlOff\s*\(\)/.test(t)) loose.push(rel(p))
  }
  eq('bindDl: 每个调用点都释放了订阅', loose.join(', ') || 'none', 'none')
}

// 3d. bindPageVis 的返回值同样必须释放
{
  const users = allFiles.filter((p) => /\bbindPageVis\s*\(/.test(read(p)) &&
    !/utils\/ui\/vis\.js$/.test(rel(p)) &&
    rel(p) !== 'utils/player/dlvis.js') // 封装层自己负责释放
  const loose = []
  for (const p of users) {
    const t = read(p)
    if (!/this\._visOff\s*\(\)/.test(t)) loose.push(rel(p))
  }
  eq('bindPageVis: 每个调用点都释放了订阅', loose.join(', ') || 'none', 'none')
}

// 3e. 不能写 WeakMap / Map / Set（QuickJS 上未验证；vis.js 用的是数组）
{
  const banned = []
  for (const p of allFiles) {
    const t = read(p)
    if (/new\s+(WeakMap|Map|Set)\s*\(/.test(t)) banned.push(rel(p))
  }
  eq('容器: 未引入未验证的 WeakMap/Map/Set', banned.join(', ') || 'none', 'none')
}

/* ---------- 3f. 播放页子面板：订阅回调入口必须自己判可见 ---------- */
// 播放单例每 500ms 发一次快照、定时模块每 1000ms 发一次倒计时。子面板被「播放页隐藏」或
// 「子面板没开」时，这些 tick 只是白写 data 触发重渲染 —— 回调第一行必须 early return。
// 这里按「订阅那一行后 4 行内出现 _visible 判定」做静态断言，防止后续改回去。
{
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
    // 订阅点在回调函数体之前：取订阅行往前 6 行（回调体声明）与往后 4 行的并集
    const win = lines.slice(Math.max(0, at - 6), at + 5).join('\n')
    if (!/_visible/.test(win)) bad.push(file)
  }
  eq('子面板门控: 订阅回调入口判可见', bad.join(', ') || 'none', 'none')
}

// 3g. sleepTimer 的裸订阅同样要登记（新增调用点会在这里露出来）
const SLEEP_ALLOW = {
  'utils/player/sleeptimer.js': '发射端自己',
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

// 3h. 页面会挂两遍（平台坑 6）：bindDl / bindPageVis 必须自己幂等
//     —— 第二次 mounted 覆盖 this._dlOff / this._visOff 时，先释放上一组，
//        否则旧订阅成为孤儿（每次广播还在往旧回调灌数据，且再也没人释放）。
{
  // 每项 = [文件, 必须出现的「先释放上一组」片段]
  const targets = [
    ['utils/player/dlvis.js', 'vm._dlOff()'],
    ['utils/ui/vis.js', 'vm._visOff()'],
    ['utils/theme.js', 'unbindTheme(vm._accentOff)']
  ]
  const bad = []
  for (const [file, needle] of targets) {
    const p = allFiles.find((x) => rel(x) === file)
    if (!p) { bad.push(file + '(缺失)'); continue }
    if (read(p).indexOf(needle) < 0) bad.push(file)
  }
  eq('重复挂载: 订阅封装自己幂等（先释放上一组）', bad.join(', ') || 'none', 'none')
}

// 3i. 高频广播的订阅回调必须自己判重（平台坑 16：watch/回调不去重）
//     —— 播放快照每 500ms、下载活动每 400ms、倒计时每 1s 各来一发。回调里直接写 data
//        就是按广播频率重渲染整块子树；判重后才真正只在「显示出来的东西变了」时更新。
//     每项登记该文件实际用的判重标记：换了写法要同步改这张表，删掉判重则直接失败。
{
  const targets = [
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

// 3j. 列表行不得在模板里现算样式对象
//     `:style="rowStyle(i)"` 走 methods 时，Vue **不缓存**返回值：每次渲染、每行都重新调一遍并
//     新建一个对象。一窗 50 行 × 4 个样式方法 = 200 次调用 + 200 个 object，全部是同一份派生数据。
//     正确写法是 computed 里算好整窗（见 queue.vue 的 rows），模板只读字段；或者像 LyricTrack 那样
//     方法体只 `return r.sRow`（读事先算好的字段，不新建对象）。
//     这条断言只盯「方法体只做防御性读取」的白名单，其余一律要求走 computed。
{
  const ALLOW = {
    // 方法体只有一句 return <参数>.<字段>（不新建对象），等价于直接绑字段
    'components/player/LyricTrack.vue': 'rowStyle',
    // 下面几处都是**固定小规模**选项，不是 50 行量级的长列表：
    // 分类/排序 key、弹出菜单项、数字键盘（3 行 × 3 键）
    'pages/list/list.vue': 'catStyle',
    'components/ContextSheet.vue': 'optStyle',
    'components/player/TimerPanel.vue': 'keyStyle'
  }
  const bad = []
  for (const p of allFiles) {
    if (!p.endsWith('.vue')) continue
    const r = rel(p)
    const src = read(p)
    // 同一行里既有 v-for 又有 :style="xxx(" —— 就是「v-for 内逐行调方法算样式」
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

/* ---------- 3k. 滚到底自动续页：判定纯函数与接入点 ---------- */
// 判定只依赖已实测的 contentOffset.y；拿不到位移或内容底部时静默退回按钮翻页。
{
  const vm = { infiniteBottomPx: 1000, infiniteViewportPx: 200 }
  truthy('infinite: 接近底部触发', inf.shouldLoad({ contentOffset: { y: 700 } }, vm, true))
  truthy('infinite: 离底部远不触发', !inf.shouldLoad({ contentOffset: { y: 100 } }, vm, true))
  truthy('infinite: 没有下一批不触发', !inf.shouldLoad({ contentOffset: { y: 700 } }, vm, false))
  truthy('infinite: 缺滚动位移不触发（fail-open）', !inf.shouldLoad({}, vm, true))
  truthy('infinite: 缺内容底部且事件无 contentSize 不触发', !inf.shouldLoad({ contentOffset: { y: 700 } }, {}, true))
  truthy('infinite: 事件 contentSize 兜底可触发', inf.shouldLoad({ contentOffset: { y: 3700 }, contentSize: { height: 4000 } }, {}, true))
  eq('infinite: 页面估算优先于事件 contentSize', inf.contentBottom({ contentSize: { height: 5000 } }, vm), 1000)
  truthy('infinite: 续批后同一 y 不再触发', !inf.shouldLoad({ contentOffset: { y: 700 } }, { infiniteBottomPx: 2000 }, true))
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
    if (!/@scroll="onInfiniteScroll"/.test(t) || !/infiniteScrollMixin/.test(t) || !/AUTO_BATCH/.test(t)) missing.push(f)
  }
  eq('自动续页: 接入页都有 @scroll/mixin/AUTO_BATCH', missing.join(', ') || 'none', 'none')
  const EXCLUDE = ['pages/queue/queue.vue', 'pages/dlqueue/dlqueue.vue', 'pages/artist/artist.vue']
  const leaked = []
  for (const f of EXCLUDE) {
    const t = fs.readFileSync(path.join(SRC, f), 'utf8')
    if (/onInfiniteScroll/.test(t)) leaked.push(f)
  }
  eq('自动续页: 锚定/多段/嵌套 scroller 页不接入', leaked.join(', ') || 'none', 'none')
}

/* ---------- 收尾 ---------- */
fs.rmSync(sandbox, { recursive: true, force: true })

const total = pass + fail.length
if (fail.length) {
  console.log('渲染性能自检：' + fail.length + ' 项失败 / 共 ' + total + ' 项\n')
  for (const f2 of fail) console.log('  ✗ ' + f2)
  process.exit(1)
}
console.log('渲染性能自检：全部通过（' + pass + ' 项）')
