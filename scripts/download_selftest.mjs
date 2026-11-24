/**
 * 下载元数据 / 退出对账离线自检（**不是产品代码**，只在 PC 上用 Node 跑）。
 *
 *   node scripts/download_selftest.mjs
 *
 * 做法与 storage_selftest.mjs 相同：整棵 src 复制到临时目录，只把平台说明符
 * （fs / process / http / sqlite3）换成 shim，其余代码一字不改。
 *
 * 覆盖本次下载稳定性改动的关键不变式：
 *   1) begin 先写基础元数据（n/a/d/c + p + z + f），put 写完成态并清 p/z；
 *   2) 有音频但元数据只剩 {p} 时，能从索引/歌曲对象就地补，不重新拉音频；
 *   3) 退出时已下满的 .part 在启动对账里转正，并清掉没用的 .rc；
 *   4) 下载判重：元数据完整才跳过；证据不足的旧行会被要求重下。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exec as cpExec } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(import.meta.dirname, '..')
let pass = 0
const failures = []
const ok = (n) => { pass++; console.log('  ✓ ' + n) }
const bad = (n, d) => { failures.push(n + (d ? ' — ' + d : '')); console.log('  ✗ ' + n + (d ? ' — ' + d : '')) }
const eq = (n, g, w) => (JSON.stringify(g) === JSON.stringify(w) ? ok(n) : bad(n, 'got=' + JSON.stringify(g) + ' want=' + JSON.stringify(w)))
const truthy = (n, v) => (v ? ok(n) : bad(n, 'falsy'))

/* ---------------- 平台 shim（与 storage_selftest 同形状） ---------------- */
const fsShim = {
  exists: (p) => fs.existsSync(p),
  stat: async (p) => {
    const st = fs.statSync(p)
    return { size: st.size, mtimeMs: st.mtimeMs, mtime: st.mtimeMs / 1000, isDirectory: () => st.isDirectory() }
  },
  readdir: (p) => fs.readdirSync(p),
  mkdir: (p) => { fs.mkdirSync(p, { recursive: true }); return true },
  rm: (p) => { fs.rmSync(p, { recursive: true, force: true }); return true },
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  statfs: async () => ({ free: 1e9, total: 1e11 })
}

let shSeq = 0
let shDir = ''
const procShim = {
  exec: (cmd, args, opts) => new Promise(function (resolve) {
    const a = args || []
    const i = a.indexOf('-c')
    const script = i >= 0 ? a[i + 1] : [cmd].concat(a).join(' ')
    const file = path.join(shDir, 'cmd' + (++shSeq) + '.sh')
    fs.writeFileSync(file, script, 'utf8')
    cpExec('bash "' + file + '"', {
      maxBuffer: 8 << 20,
      timeout: (opts && opts.timeout) || 15000
    }, function (err, stdout, stderr) {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

const httpShim = {
  request: () => ({ on() { return this }, write() {}, end() {}, setTimeout() {}, destroy() {} }),
  get: () => ({ on() {}, setTimeout() {}, destroy() {} })
}

function makeSqliteShim() {
  class Statement {
    constructor(db, sql) {
      this.db = db
      this.st = db.raw.prepare(sql)
      this.params = []
    }
    async columnNameList() {
      try { return this.st.columns().map((c) => c.name) } catch (e) { return [] }
    }
    async bind(...a) {
      this.params = a.length === 1 && Array.isArray(a[0]) ? a[0] : a
      return 0
    }
    _bind() {
      return this.params.map((v) => (v === undefined || v === null ? null : v))
    }
    async step() {
      try {
        if (!this._rows) { this._rows = this.st.all(...this._bind()); this._i = 0 }
        if (this._i >= this._rows.length) return null
        return Object.values(this._rows[this._i++])
      } catch (e) { return String((e && e.message) || e) }
    }
    async all() {
      try { return this.st.all(...this._bind()).map((r) => Object.values(r)) } catch (e) { return String((e && e.message) || e) }
    }
    async run() {
      try { this.st.run(...this._bind()); return 0 } catch (e) { return String((e && e.message) || e) }
    }
    async finalize() { return 'OK' }
  }
  class Database {
    constructor() { this.raw = null; this.path = '' }
    async open(p) {
      try { this.path = p; this.raw = new DatabaseSync(p); return 0 } catch (e) { return String((e && e.message) || e) }
    }
    async exec(sql) {
      try { this.raw.exec(sql); return 0 } catch (e) { return String((e && e.message) || e) }
    }
    async prepare(sql) {
      try { return new Statement(this, sql) } catch (e) { return String((e && e.message) || e) }
    }
    async close() {
      try { if (this.raw) this.raw.close(); this.raw = null; return 'OK' } catch (e) { return String((e && e.message) || e) }
    }
  }
  return { Database }
}

async function prepareTree(sandbox) {
  const shimDir = path.join(sandbox, '_shim')
  await fsp.mkdir(shimDir, { recursive: true })
  const fsUrl = pathToFileURL(path.join(shimDir, 'fs.mjs')).href
  const procUrl = pathToFileURL(path.join(shimDir, 'process.mjs')).href
  const httpUrl = pathToFileURL(path.join(shimDir, 'http.mjs')).href
  const sqliteUrl = pathToFileURL(path.join(shimDir, 'sqlite3.mjs')).href

  await fsp.writeFile(path.join(shimDir, 'fs.mjs'),
    'const s = globalThis.__fsShim\nexport default s\n' +
    ['exists', 'stat', 'readdir', 'mkdir', 'rm', 'readFile', 'statfs']
      .map((k) => 'export const ' + k + ' = (...a) => s.' + k + '(...a)').join('\n') + '\n')
  await fsp.writeFile(path.join(shimDir, 'process.mjs'),
    'const p = globalThis.__procShim\nexport default p\nexport const exec = (...a) => p.exec(...a)\n')
  await fsp.writeFile(path.join(shimDir, 'http.mjs'),
    'const s = globalThis.__httpShim\nexport default s\nexport const request = (...a) => s.request(...a)\nexport const get = (...a) => s.get(...a)\n')
  await fsp.writeFile(path.join(shimDir, 'sqlite3.mjs'),
    'const s = globalThis.__sqliteShim\nexport default s\nexport const Database = s.Database\n')

  const srcDst = path.join(sandbox, 'src')
  for (const axis of ['core', 'ui', 'services']) {
    await fsp.cp(path.join(ROOT, 'src', axis), path.join(srcDst, axis), { recursive: true })
  }
  const logCfg = path.join(srcDst, 'core/infra/logconfig.generated.js')
  if (!fs.existsSync(logCfg)) await fsp.writeFile(logCfg, "export const LOG_SRV = ''\n")
  const buildInfo = path.join(srcDst, 'core/infra/buildInfo.js')
  if (!fs.existsSync(buildInfo)) await fsp.writeFile(buildInfo, "export const BUILD_TAG = 'selftest'\n")
  await fsp.writeFile(path.join(srcDst, 'package.json'), '{"type":"module"}\n')

  async function walk(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { await walk(p); continue }
      if (!e.name.endsWith('.js')) continue
      let s = await fsp.readFile(p, 'utf8')
      s = s.replace(/from\s+(['"])fs\1/g, "from '" + fsUrl + "'")
      s = s.replace(/import\(\s*(['"])fs\1\s*\)/g, "import('" + fsUrl + "')")
      s = s.replace(/from\s+(['"])process\1/g, "from '" + procUrl + "'")
      s = s.replace(/import\(\s*(['"])process\1\s*\)/g, "import('" + procUrl + "')")
      s = s.replace(/from\s+(['"])http\1/g, "from '" + httpUrl + "'")
      s = s.replace(/import\(\s*(['"])http\1\s*\)/g, "import('" + httpUrl + "')")
      s = s.replace(/from\s+(['"])sqlite3\1/g, "from '" + sqliteUrl + "'")
      s = s.replace(/import\(\s*(['"])sqlite3\1\s*\)/g, "import('" + sqliteUrl + "')")
      await fsp.writeFile(p, s)
    }
  }
  for (const axis of ['core', 'ui', 'services']) await walk(path.join(srcDst, axis))
  return srcDst
}

/* ---------------- 主流程 ---------------- */
const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'bpncm-dl-'))
shDir = path.join(sandbox, '_sh')
await fsp.mkdir(shDir, { recursive: true })

globalThis.__fsShim = fsShim
globalThis.__procShim = procShim
globalThis.__httpShim = httpShim
globalThis.__sqliteShim = makeSqliteShim()

const dataDir = path.join(sandbox, 'appdata')
await fsp.mkdir(path.join(dataDir, 'downloads'), { recursive: true })
globalThis.$dataDir = dataDir + '/'

console.log('下载稳定性自检（沙箱 ' + sandbox + '）\n')
const srcDst = await prepareTree(sandbox)
const U = (n) => pathToFileURL(path.join(srcDst, n)).href

const paths = await import(U('core/infra/paths.js'))
const db = await import(U('core/platform/db.js'))
const cache = await import(U('services/player/cache.js'))
const media = await import(U('services/player/media.js'))
const localmeta = await import(U('services/player/localmeta.js'))
const store = await import(U('core/infra/store.js'))
const scheduler = await import(U('services/player/scheduler.js'))
const fetcher = await import(U('services/player/fetcher.js'))
const download = await import(U('services/player/download.js'))
const exec = await import(U('core/platform/exec.js'))
// Windows 沙箱/受限环境可能禁止 fork：promote 需要 mv（exec），此时跳过转正断言，
// 其余（元数据/判重/退出）仍可完整验证。
const canExec = await exec.has('curl')

await db.ensureStateDb()
await db.open()

/* ================= 1) begin / put 的写入协议 ================= */
console.log('1) begin 先写基础元数据，put 写完成态并清标记')
const begun = await cache.beginMeta(
  { id: 1, name: '歌名', artist: '歌手', durationMs: 123456, cover: 'http://c' },
  'exhigh', 1000, false
)
truthy('begin 返回记录', !!begun)
const m1 = await cache.warmMeta(1)
eq('begin 写入歌名', m1 && m1.n, '歌名')
eq('begin 写入待续传档位', m1 && m1.p, 'exhigh')
eq('begin 写入预期大小', m1 && m1.z, 1000)
eq('begin 记录 fresh(f=1)', m1 && m1.f, 1)
eq('begin 不提前写档位 q', m1 && m1.q, undefined)
const put1 = await cache.putMeta({ id: 1, name: '歌名', artist: '歌手', durationMs: 123456, cover: 'http://c' }, 320000, 'mp3', 'exhigh')
truthy('put 返回落库成功', put1 && put1.ok === true)
const m1b = await media.readMeta(1, 'download')
eq('put 写入实际码率', m1b && m1b.b, 320000)
eq('put 写入容器', m1b && m1b.y, 'mp3')
eq('put 写入档位', m1b && m1b.q, 'exhigh')
eq('put 清掉 p', m1b && m1b.p, '')
eq('put 清掉 z', m1b && m1b.z, 0)

/* ================= 2) 构造下载目录 ================= */
const dlRoot = paths.downloadsDir()
function makeTrack(id, ext, size) {
  const dir = path.join(dlRoot, String(id))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'track.' + ext), Buffer.alloc(size || 40000, 1))
  return dir
}
function makePart(id, ext, size) {
  const dir = path.join(dlRoot, String(id))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'track.' + ext + '.part'), Buffer.alloc(size || 40000, 2))
  return dir
}

// 3) 退出时已下满的 flac 残片 + rc=0
makePart(3, 'flac', 40000)
fs.writeFileSync(path.join(dlRoot, '3', 'track.flac.part.rc'), '0')
await media.writeMeta(3, 'download', { n: '残片歌', p: 'lossless', z: 40000, f: 1 })

// 4) 没有 .part 的孤立 .rc
fs.mkdirSync(path.join(dlRoot, '4'), { recursive: true })
fs.writeFileSync(path.join(dlRoot, '4', 'track.mp3.rc'), '0')

// 5) 有音频、元数据只剩 {p}+f=1：应收敛成 q（不需要外网）
makeTrack(5, 'mp3', 40000)
await media.writeMeta(5, 'download', { n: '索引歌', a: '索引歌手', d: 1000, p: 'exhigh', z: 0, f: 1 })

// 8) 有音频、元数据只剩 {p}+f=0（升级中断）：只补名字，p 必须保留给下次下载
makeTrack(8, 'mp3', 40000)
await media.writeMeta(8, 'download', { n: '', a: '', d: 0, p: 'lossless', z: 40000, f: 0 })

await localmeta.putIndex(5, {
  song: { name: '索引歌', durationMs: 1000, fee: 0 },
  album: { id: 9, name: '索引专辑', cover: 'http://cover' },
  artists: [{ id: 8, name: '索引歌手' }],
  publishTime: 0,
  trackNo: 1,
  disc: '',
  popularity: 0
})
await localmeta.putIndex(8, {
  song: { name: '升级歌', durationMs: 2000, fee: 0 },
  album: { id: 9, name: '索引专辑', cover: 'http://cover' },
  artists: [{ id: 8, name: '索引歌手' }],
  publishTime: 0,
  trackNo: 2,
  disc: '',
  popularity: 0
})

/* ================= 3) 启动对账 ================= */
console.log('\n2) 启动对账：补元数据 / 转正残片 / 清临时文件')
const rec = await download.reconcileDownloads()
truthy('对账至少扫描到构造的目录', rec.scanned >= 3)
if (canExec) {
  truthy('完整残片已转正', fs.existsSync(path.join(dlRoot, '3', 'track.flac')))
  truthy('转正后 .part 已消失', !fs.existsSync(path.join(dlRoot, '3', 'track.flac.part')))
  const m3 = await media.readMeta(3, 'download')
  eq('转正后写入档位', m3 && m3.q, 'lossless')
  eq('转正后清掉 p', m3 && m3.p, '')
} else {
  console.log('  - 当前环境不能 fork/exec（mv 不可用），跳过残片转正断言')
}
truthy('孤立 .rc 已清掉', !fs.existsSync(path.join(dlRoot, '4', 'track.mp3.rc')))
const m5 = await media.readMeta(5, 'download')
eq('p-only 行补出档位', m5 && m5.q, 'exhigh')
eq('p-only 行清掉 p', m5 && m5.p, '')
const m8 = await media.readMeta(8, 'download')
eq('升级中断行只补名字', m8 && m8.n, '升级歌')
eq('升级中断行保留 p（给下次续传/重下）', m8 && m8.p, 'lossless')
eq('升级中断行不冒充档位', m8 && m8.q, undefined)
traceNote(rec)

function traceNote(r) {
  console.log('    （对账统计：补 ' + r.repaired + ' / 转正 ' + r.promoted + ' / 清 ' + r.cleaned + '）')
}

/* ================= 4) 下载判重：证据不足才重下 ================= */
console.log('\n3) 下载判重：完整元数据跳过；证据不足重下')
makeTrack(6, 'mp3', 40000)
await media.writeMeta(6, 'download', { n: '证据不足', p: 'exhigh' }) // f 缺省 = 旧版本残留
makeTrack(7, 'mp3', 40000)
await media.writeMeta(7, 'download', { n: '已完整', q: 'exhigh', y: 'mp3', b: 320000, p: '', f: 0 })

let fakeCalls = []
scheduler.setDownloaderForTest(async function (song) {
  fakeCalls.push(String(song.id))
  return { ok: true, path: paths.trackFile(song.id, 'mp3', 'download'), size: 40000 }
})

const r6 = await download.downloadSongs([{ id: 6, name: '证据不足', artist: '', durationMs: 0, cover: '' }])
eq('证据不足的旧行会重下', fakeCalls, ['6'])
eq('重下计为成功', r6 && r6.ok, 1)
fakeCalls = []
const r7 = await download.downloadSongs([{ id: 7, name: '已完整', artist: '', durationMs: 0, cover: '' }])
eq('元数据完整且档位够 → 跳过', r7 && r7.skipped, 1)
eq('跳过时不会调用下载器', fakeCalls, [])
const pending = await store.getStorage(store.KEY_DL_PENDING)
eq('正常结束后清掉待续传快照', pending, null)

/* ================= 5) 退出收尾 ================= */
console.log('\n4) 退出收尾')
await download.stopForExit()
truthy('stopForExit 置退出标志', fetcher.isStopping() === true)
download.resetExit()
truthy('closeApp 失败时可复位', fetcher.isStopping() === false)

/* ================= 汇总 ================= */
console.log('\n========================================================')
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项 / 通过 ' + pass + ' 项')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exitCode = 1
} else {
  console.log('结果：全部 ' + pass + ' 项通过')
}
