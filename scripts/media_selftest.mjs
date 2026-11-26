
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exec as cpExec } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(import.meta.dirname, '..')
let pass = 0
const fail = []
const ok = (n) => { pass++; console.log('  ✓ ' + n) }
const bad = (n, d) => { fail.push(n + (d ? ' — ' + d : '')); console.log('  ✗ ' + n + (d ? ' — ' + d : '')) }
const eq = (n, g, w) => (JSON.stringify(g) === JSON.stringify(w) ? ok(n) : bad(n, 'got=' + JSON.stringify(g) + ' want=' + JSON.stringify(w)))
const truthy = (n, v) => (v ? ok(n) : bad(n, 'falsy'))
const slash = (p) => String(p).replace(/\\/g, '/')

const fsShim = {
  exists: (p) => fs.existsSync(p),
  stat: async (p) => { const st = fs.statSync(p); return { size: st.size, mtimeMs: st.mtimeMs, mtime: st.mtimeMs / 1000 } },
  readdir: (p) => fs.readdirSync(p),
  mkdir: (p) => { fs.mkdirSync(p, { recursive: true }); return true },
  rm: (p) => { fs.rmSync(p, { recursive: true, force: true }); return true },
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  statfs: async () => ({ free: 1e9, total: 1e11 })
}
let shSeq = 0
const procShim = {
  exec: (cmd, args, opts) => new Promise(function (resolve) {
    const a = args || []
    const i = a.indexOf('-c')
    const script = i >= 0 ? a[i + 1] : [cmd].concat(a).join(' ')

    // 落到临时脚本再执行：与设备同语义，但不受 PC 命令行转义差异影响
    const file = path.join(globalThis.__shDir, 'c' + (++shSeq) + '.sh')
    fs.writeFileSync(file, script, 'utf8')
    cpExec('bash "' + file + '"', { maxBuffer: 8 << 20, timeout: (opts && opts.timeout) || 15000 },
      function (err, stdout, stderr) {
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
      this.sql = sql
      this.params = []
      this.st = db.raw.prepare(sql)
    }
    async columnNameList() {
      try {
        return this.st.columns().map((c) => c.name)
      } catch (e) {
        return []
      }
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
        if (!this._rows) this._rows = this.st.all(...this._bind())
        if (!this._i) this._i = 0
        if (this._i >= this._rows.length) return null
        return Object.values(this._rows[this._i++])
      } catch (e) {
        return String((e && e.message) || e)
      }
    }
    async all() {
      try {
        return this.st.all(...this._bind()).map((r) => Object.values(r))
      } catch (e) {
        return String((e && e.message) || e)
      }
    }
    async run() {
      try {
        this.st.run(...this._bind())
        return 0
      } catch (e) {
        return String((e && e.message) || e)
      }
    }
    async finalize() {
      return 'OK'
    }
  }
  class Database {
    constructor() {
      this.raw = null
      this.path = ''
    }
    async open(p) {
      try {
        this.path = p
        this.raw = new DatabaseSync(p)
        return 0
      } catch (e) {
        return String((e && e.message) || e)
      }
    }
    async exec(sql) {
      try {
        this.raw.exec(sql)
        return 0
      } catch (e) {
        return String((e && e.message) || e)
      }
    }
    async prepare(sql) {
      try {
        return new Statement(this, sql)
      } catch (e) {
        return String((e && e.message) || e)
      }
    }
    async close() {
      try {
        if (this.raw) this.raw.close()
        this.raw = null
        return 'OK'
      } catch (e) {
        return String((e && e.message) || e)
      }
    }
  }
  return { Database }
}

async function prepareTree(sandbox) {
  const shimDir = path.join(sandbox, '_shim')
  await fsp.mkdir(shimDir, { recursive: true })
  const url = (n) => pathToFileURL(path.join(shimDir, n)).href
  await fsp.writeFile(path.join(shimDir, 'fs.mjs'),
    'const s = globalThis.__fsShim\nexport default s\n' +
    ['exists', 'stat', 'readdir', 'mkdir', 'rm', 'readFile', 'statfs'].map(k => 'export const ' + k + ' = (...a) => s.' + k + '(...a)').join('\n') + '\n')
  await fsp.writeFile(path.join(shimDir, 'process.mjs'),
    'const p = globalThis.__procShim\nexport default p\nexport const exec = (...a) => p.exec(...a)\n')
  await fsp.writeFile(path.join(shimDir, 'http.mjs'),
    'const s = globalThis.__httpShim\nexport default s\nexport const request = (...a) => s.request(...a)\nexport const get = (...a) => s.get(...a)\n')
  await fsp.writeFile(path.join(shimDir, 'sqlite3.mjs'),
    'const s = globalThis.__sqliteShim\nexport default s\nexport const Database = s.Database\n')

  const dstRoot = path.join(sandbox, 'src')
  for (const axis of ['core', 'ui', 'services']) await fsp.cp(path.join(ROOT, 'src', axis), path.join(dstRoot, axis), { recursive: true })
  const dst = dstRoot
  async function walk(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { await walk(p); continue }
      if (!e.name.endsWith('.js')) continue
      let s = await fsp.readFile(p, 'utf8')
      s = s.replace(/from\s+(['"])fs\1/g, "from '" + url('fs.mjs') + "'")
        .replace(/import\(\s*(['"])fs\1\s*\)/g, "import('" + url('fs.mjs') + "')")
        .replace(/from\s+(['"])process\1/g, "from '" + url('process.mjs') + "'")
        .replace(/import\(\s*(['"])process\1\s*\)/g, "import('" + url('process.mjs') + "')")
        .replace(/from\s+(['"])http\1/g, "from '" + url('http.mjs') + "'")
        .replace(/import\(\s*(['"])http\1\s*\)/g, "import('" + url('http.mjs') + "')")
        .replace(/from\s+(['"])sqlite3\1/g, "from '" + url('sqlite3.mjs') + "'")
        .replace(/import\(\s*(['"])sqlite3\1\s*\)/g, "import('" + url('sqlite3.mjs') + "')")
      await fsp.writeFile(p, s)
    }
  }
  await walk(dst)
  return dst
}

async function main() {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'bpn-media-'))
  const dataDir = slash(path.join(sandbox, 'data'))
  await fsp.mkdir(dataDir, { recursive: true })
  globalThis.$dataDir = dataDir
  globalThis.__fsShim = fsShim
  globalThis.__procShim = procShim
  globalThis.__httpShim = httpShim
  globalThis.__sqliteShim = makeSqliteShim()
  globalThis.__shDir = path.join(sandbox, '_sh')
  await fsp.mkdir(globalThis.__shDir, { recursive: true })

  const srcDst = await prepareTree(sandbox)

  // logconfig.generated.js 是构建生成物（不进仓库、本地也常缺）→ 造一个空的顶上
  const logCfg = path.join(srcDst, 'core/infra/logconfig.generated.js')
  if (!fs.existsSync(logCfg)) await fsp.writeFile(logCfg, "export const LOG_SRV = ''\n")
  const load = (rel) => import(pathToFileURL(path.join(srcDst, rel)).href)
  const paths = await load('core/infra/paths.js')
  const media = await load('services/player/media.js')
  const cache = await load('services/player/cache.js')

  console.log('\n1) 枚举只认真实的曲目目录')

  // 造两首下载 + 一首缓存 + thumbs 目录（thumbs 不能被当成曲目）
  for (const id of ['101', '102']) {
    await media.ensureTrackDir(id, 'download')
    await fsp.writeFile(paths.trackFile(id, 'mp3', 'download'), Buffer.alloc(50000))
    await media.writeMeta(id, 'download', { n: '歌' + id, a: '歌手', b: 320, y: 'mp3', q: 'exhigh', d: 200000 })
    await fsp.writeFile(paths.trackCover(id, 'download'), Buffer.alloc(3000))
  }
  await media.ensureTrackDir('201', 'cache')
  await fsp.writeFile(paths.trackFile('201', 'flac', 'cache'), Buffer.alloc(60000))
  await media.writeMeta('201', 'cache', { n: '缓存歌', u: 123 })
  await fsp.mkdir(paths.thumbsDir(), { recursive: true })
  await fsp.writeFile(paths.thumbsDir() + '/999@60.jpg', Buffer.alloc(500))

  const dl = await media.listTracks('download')
  eq('下载目录只列出曲目（不含 thumbs）', dl.map(x => x.id).sort(), ['101', '102'])
  truthy('每条带 ext/size/meta', dl.every(x => x.ext === 'mp3' && x.size === 50000 && x.meta && x.meta.n))
  const pc = await media.listTracks('cache')
  eq('缓存目录只列出曲目', pc.map(x => x.id), ['201'])
  eq('缓存曲目的容器是 flac', pc[0].ext, 'flac')

  console.log('\n2) 统计与清理')
  const st = await cache.stats()
  truthy('stats 下载计数=2', st.songs.count === 2)
  truthy('stats 缓存计数=1', st.cache.count === 1)
  const cleared = await cache.clearPlayCache()
  const after = await media.listTracks('cache')
  eq('清缓存后目录为空', after.length, 0)
  truthy('清缓存不动下载', (await media.listTracks('download')).length === 2)

  console.log('\n3) 删一首 = 删整个目录（封面/元数据连坐；歌词在 track_lyric 表）')
  await media.writeLyrics('101', { lrc: '[00:01.00]x' })
  truthy('歌词落了 track_lyric 表', await media.readLyrics('101') != null)
  truthy('删前封面在', await media.hasCover('101', 'download'))
  await media.dropTrackDir('101', 'download')
  eq('删后目录没了', await media.hasTrackDir('101', 'download'), false)
  truthy('删后音频/封面/元数据全没',
    !fs.existsSync(paths.trackFile('101', 'mp3', 'download')) &&
    !fs.existsSync(paths.trackCover('101', 'download')) &&
    !(await media.readMeta('101', 'download')))
  await media.dropLyrics('101')

  console.log('\n4) 元数据合并写保住了归属字段')
  await media.writeMeta('102', 'download', { n: '歌102', plus: 1 })
  await media.patchMeta('102', 'download', { origin: 2 })
  const m2 = await media.readMeta('102', 'download')
  truthy('patch 不擦掉原有字段', m2 && m2.n === '歌102' && m2.origin === 2)

  console.log('\n' + '='.repeat(56))
  if (fail.length) {
    console.log('结果：' + pass + ' 通过，' + fail.length + ' 失败')
    fail.forEach(f => console.log('  ✗ ' + f))
    await fsp.rm(sandbox, { recursive: true, force: true })
    process.exit(1)
  }
  console.log('结果：全部 ' + pass + ' 项通过')
  await fsp.rm(sandbox, { recursive: true, force: true })
}

main().catch(function (e) { console.error('自检异常：', e); process.exit(1) })
