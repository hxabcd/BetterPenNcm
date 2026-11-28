#!/usr/bin/env node

// 渲染性能自检 —— 纯逻辑，不需要设备。覆盖三块「改了就会悄悄退化、但看代码看不出来」的约定：
//   1. 签名判重（services/player/sig.js）：同一快照必须判「没变」，任何界面可见字段变化必须判「变了」。
//   2. 页面可见性（ui/vis.js）：默认可见、hide/show、unload 摘除、退栈把栈顶救回可见（fail-open）。
//   3. 静态扫描：易退化的调用点是否都走了门控（裸 player.on / 裸 onDl 的清单比对）。
// 这些优化的产物是「少渲染」，跑不出可见差异，没有真机时只能靠约束测试守住语义。
// 用法：node scripts/perf_selftest.mjs（全绿 exit 0，有失败 exit 1）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeAssertions, makeFileAccess, stripComments } from './lib/perf-selftest-kit.mjs'
import { stageSandbox } from './lib/perf-selftest-stage.mjs'
import { runSignals } from './lib/perf-selftest-signals.mjs'
import { runScanA } from './lib/perf-selftest-scan-a.mjs'
import { runScanB } from './lib/perf-selftest-scan-b.mjs'
import { runScanC } from './lib/perf-selftest-scan-c.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')

const { eq, truthy, pass, fail } = makeAssertions()

const { sig, vis, inf, cleanup } = await stageSandbox(ROOT, SRC)

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

runSignals({ sig, vis, eq, truthy, base })

const { allFiles, rel, read } = makeFileAccess(SRC)

runScanA({ eq, truthy, stripComments, allFiles, rel, read })
runScanB({ eq, allFiles, rel, read })
runScanC({ fs, path, SRC, eq, truthy, stripComments, allFiles, rel, read, inf })

cleanup()

const total = pass() + fail().length
if (fail().length) {
  console.log('渲染性能自检：' + fail().length + ' 项失败 / 共 ' + total + ' 项\n')
  for (const f2 of fail()) console.log('  ✗ ' + f2)
  process.exit(1)
}
console.log('渲染性能自检：全部通过（' + pass() + ' 项）')
