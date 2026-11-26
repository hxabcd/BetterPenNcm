

// 存储层离线集成自检（**不是产品代码**，只在 PC 上用 Node 跑）：node scripts/storage_selftest.mjs
// 为什么需要它：存储层的核心结论（原生 sqlite3 通道 / kv 文档表 / 每曲一目录 / 迁移幂等）全都落在平台边界上
// （$dataDir、只读 fs 模块、process.exec），设备不在手边时只能「用真实文件系统 + 真实 sqlite 扮演平台」来证明跑得起来。
// 做法：把 src/ 整棵复制到临时目录，只把平台说明符（'fs' / 'process' / 'http' / 'sqlite3'）换成 shim，其余代码一字不改。
import { exec as cpExec } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(import.meta.dirname, '..')

let pass = 0
const failures = []
const ok = (n) => { pass++; console.log('  ✓ ' + n) }
const bad = (n, d) => { failures.push(n + (d ? ' — ' + d : '')); console.log('  ✗ ' + n + (d ? ' — ' + d : '')) }
function eq(name, got, want) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) ok(name)
  else bad(name, 'got=' + a + ' want=' + b)
}
const truthy = (n, v) => (v ? ok(n) : bad(n, 'falsy: ' + JSON.stringify(v)))

const fsShim = {
  // 平台 fs 只有这些能力：**没有写入接口**（writeFile/rename/unlink 全是 undefined），mkdir / rm 递归可用 —— 与真机实测一致
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

// shell 命令统一落到临时脚本再执行：避免在「拼命令行」这一层引入与设备不同的转义语义
let shSeq = 0
let shDir = ''
let execCount = 0
const procShim = {
  exec: (cmd, args, opts) => new Promise(function (resolve) {
    execCount++
    const a = args || []
    let script
    if (cmd === '/bin/sh' || cmd === 'sh' || cmd === '/bin/bash' || cmd === 'bash') {
      const i = a.indexOf('-c')
      script = i >= 0 ? a[i + 1] : a.join(' ')
    } else {
      script = [cmd].concat(a).join(' ')
    }
    const file = path.join(shDir, 'cmd' + (++shSeq) + '.sh')
    fs.writeFileSync(file, script, 'utf8')
    if (process.env.DSH_SELFTEST_TRACE) {
      fs.appendFileSync(path.join(shDir, 'trace.log'), '=== ' + file + ' ===\n' + script + '\n')
    }
    cpExec('bash "' + file + '"', {
      maxBuffer: 8 << 20,
      timeout: (opts && opts.timeout) || 15000
    }, function (err, stdout, stderr) {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

// 平台没有「连外网」这回事：日志/请求一律静默失败（与设备未起 logserver 等价）
const httpShim = {
  request: () => ({ on() { return this }, write() {}, end() {}, setTimeout() {}, destroy() {} }),
  get: () => ({ on() { return this }, setTimeout() {}, destroy() {} })
}

/**
 * 原生 sqlite3 模块 shim：形状与设备上一模一样（`Database` 类 + prepare/bind/step/run/all/
 * columnNameList/finalize），底层用 node:sqlite 的同步实现。
 *
 * 重点还原两个真机实测事实：
 *   1) `step()` 返回**按列顺序的数组**，不是对象（产品代码靠 columnNameList 对齐）；
 *   2) 成功返回 0，失败返回错误信息**字符串**（不是抛异常）。
 */
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
    async bindParameterList() {
      return []
    }
    async bind(...a) {
      this.params = a.length === 1 && Array.isArray(a[0]) ? a[0] : a
      return 0
    }
    async clearBindings() {
      this.params = []
      return 0
    }
    async reset() {
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
        const row = this._rows[this._i++]

        return Object.values(row)
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
  const fsUrl = pathToFileURL(path.join(shimDir, 'fs.mjs')).href
  const procUrl = pathToFileURL(path.join(shimDir, 'process.mjs')).href
  const httpUrl = pathToFileURL(path.join(shimDir, 'http.mjs')).href
  const sqliteUrl = pathToFileURL(path.join(shimDir, 'sqlite3.mjs')).href

  await fsp.writeFile(path.join(shimDir, 'fs.mjs'),
    'const s = globalThis.__fsShim\nexport default s\n' +
    ['exists', 'stat', 'readdir', 'mkdir', 'rm', 'readFile', 'statfs']
      .map(k => 'export const ' + k + ' = (...a) => s.' + k + '(...a)').join('\n') + '\n')
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
  if (!fs.existsSync(buildInfo)) await fsp.writeFile(buildInfo, "export const BUILD = 'selftest'\nexport const BUILD_TAG = 'st'\n")

  await fsp.writeFile(path.join(srcDst, 'package.json'), '{"type":"module"}\n')

  let rewritten = 0
  async function walk(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { await walk(p); continue }
      if (!e.name.endsWith('.js')) continue
      let s = await fsp.readFile(p, 'utf8')
      const before = s

      s = s.replace(/from\s+(['"])fs\1/g, "from '" + fsUrl + "'")
      s = s.replace(/import\(\s*(['"])fs\1\s*\)/g, "import('" + fsUrl + "')")
      s = s.replace(/from\s+(['"])process\1/g, "from '" + procUrl + "'")
      s = s.replace(/import\(\s*(['"])process\1\s*\)/g, "import('" + procUrl + "')")
      s = s.replace(/from\s+(['"])http\1/g, "from '" + httpUrl + "'")
      s = s.replace(/import\(\s*(['"])http\1\s*\)/g, "import('" + httpUrl + "')")
      s = s.replace(/from\s+(['"])sqlite3\1/g, "from '" + sqliteUrl + "'")
      s = s.replace(/import\(\s*(['"])sqlite3\1\s*\)/g, "import('" + sqliteUrl + "')")
      if (s !== before) { await fsp.writeFile(p, s); rewritten++ }
    }
  }
  for (const axis of ['core', 'ui', 'services']) await walk(path.join(srcDst, axis))

  await fsp.mkdir(path.join(srcDst, 'core', 'infra', '_shim'), { recursive: true })
  return { srcDst, rewritten }
}

const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'bpncm-store-'))
shDir = path.join(sandbox, '_sh')
await fsp.mkdir(shDir, { recursive: true })

globalThis.__fsShim = fsShim
globalThis.__procShim = procShim
globalThis.__httpShim = httpShim
globalThis.__sqliteShim = makeSqliteShim()

console.log('存储层自检（沙箱 ' + sandbox + '）\n')

const dataDir = path.join(sandbox, 'appdata')
await fsp.mkdir(dataDir, { recursive: true })
globalThis.$dataDir = dataDir + '/' 

const { srcDst, rewritten } = await prepareTree(sandbox)
console.log('1) 环境')
truthy('平台说明符已替换（core/ui/services 三轴）', rewritten > 0)

const U = (n) => pathToFileURL(path.join(srcDst, n)).href

const paths = await import(U('core/infra/paths.js'))
const db = await import(U('core/platform/db.js'))
const store = await import(U('core/infra/store.js'))
const media = await import(U('services/player/media.js'))
const fsutil = await import(U('core/platform/fsutil.js'))
const config = (await import(U('core/infra/config.js'))).default
const history = await import(pathToFileURL(path.join(srcDst, 'services/player/history.js')).href)
const session = await import(pathToFileURL(path.join(srcDst, 'services/player/session.js')).href)

console.log('\n2) paths —— 路径形状与唯一真源')

eq('normDir 去尾斜杠且无重复斜杠', paths.normDir(), String(dataDir).replace(/\//g, '\\'))
truthy('dbFile 落在 data 根', paths.dbFile() === paths.normDir() + '/local_index.db')
truthy('stateDbFile 落在 data 根', paths.stateDbFile() === paths.normDir() + '/state.db')
truthy('曲目目录 = <root>/<id>', paths.trackDir(42, 'download') === paths.dataDir() + '/downloads/42')
truthy('paths 不再导出 configFile / stateFile 等文本文件路径', paths.configFile === undefined && paths.stateFile === undefined)
truthy('paths 不再导出 trackMeta / trackLyrics', paths.trackMeta === undefined && paths.trackLyrics === undefined)

console.log('\n3) fsutil —— 只做原生调用（不 fork）')
const beforeFork = execCount
truthy('ensureDir 建多级目录', await fsutil.ensureDir(path.join(dataDir, 'a/b/c')))
truthy('mkdir 递归后目录存在', await fsutil.fileExists(path.join(dataDir, 'a/b/c')))
truthy('removeTree 递归删除', await fsutil.removeTree(path.join(dataDir, 'a')))
truthy('删完 exists=false', !(await fsutil.fileExists(path.join(dataDir, 'a'))))
eq('建目录/删目录全程 0 次 fork', execCount - beforeFork, 0)

console.log('\n4) db —— 原生 sqlite3 通道（两个库）')
const conn = await db.ensureDb()
truthy('ensureDb 拿到索引库连接', conn !== null)
const connState = await db.ensureStateDb()
truthy('ensureStateDb 拿到状态库连接', connState !== null)
truthy('状态库和索引库不是同一个连接', conn !== connState)
eq('两个库文件路径不同', paths.dbFile() !== paths.stateDbFile(), true)
truthy('local_index.db 在盘上', fs.existsSync(paths.dbFile()))
truthy('state.db 在盘上', fs.existsSync(paths.stateDbFile()))

{
  const a = new DatabaseSync(paths.dbFile())
  const idxTables = a.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  a.close()
  const b = new DatabaseSync(paths.stateDbFile())
  const stTables = b.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  b.close()
  eq('索引库表清单', idxTables, ['album', 'artist', 'playlist', 'playlist_track', 'track', 'track_artist'])
  eq('状态库表清单', stTables, ['kv', 'track_lyric', 'track_meta'])
}

truthy('open() 灌内存', (await db.open()) !== null)
eq('内存态六张索引表', Object.keys(db.data()).sort(),
  ['album', 'artist', 'playlist', 'playlist_track', 'track', 'track_artist'])

const beforeDbFork = execCount
truthy('upsertSql 写入 track', (await db.exec([
  db.upsertSql('track', [
    { name: 'id', v: 7, raw: true },
    { name: 'name', v: "中文'单引号\"双引号\\反斜杠" },
    { name: 'alias', v: '["别名"]' },
    { name: 'album_id', v: 3, raw: true },
    { name: 'duration', v: 1000, raw: true },
    { name: 'pub', v: 0, raw: true },
    { name: 'track_no', v: 1, raw: true },
    { name: 'disc', v: '' },
    { name: 'pop', v: 0, raw: true },
    { name: 'fee', v: 0, raw: true },
    { name: 'cover', v: '' },
    { name: 'dl_origin', v: 1, raw: true },
    { name: 'added_at', v: 0, raw: true }
  ], 'id')
])) !== false)
eq('写库全程 0 次 fork', execCount - beforeDbFork, 0)

truthy('kvPut 写配置', await db.kvPut(store.KEY_SETTINGS, '{"rate":1.25}'))
eq('kvGet 读回同一份文本', await db.kvGet(store.KEY_SETTINGS), '{"rate":1.25}')
eq('getStorage 走 kv 表', await store.getStorage(store.KEY_SETTINGS), '{"rate":1.25}')
truthy('setStorage 写入', await store.setStorage(store.KEY_PLAY_HIST, '[{"id":1}]'))
eq('setStorage 后读回', await store.getStorage(store.KEY_PLAY_HIST), '[{"id":1}]')
truthy('removeStorage 删掉', await store.removeStorage(store.KEY_PLAY_HIST))
eq('删完读回 null', await store.getStorage(store.KEY_PLAY_HIST), null)

for (let i = 0; i < 20; i++) store.setStorage(store.KEY_PLAYER_STATE, '{"i":' + i + '}')
await new Promise((r) => setTimeout(r, 200))
eq('合并写只留最新一版', await store.getStorage(store.KEY_PLAYER_STATE), '{"i":19}')

console.log('\n5) media —— 每曲一目录 + 曲目文档在库里')
const tk = path.join(dataDir, 'downloads/42')
await fsutil.ensureDir(tk)
fs.writeFileSync(path.join(tk, 'track.mp3'), Buffer.alloc(40000)) 
const hit = await media.hitAudio(42, 'download')
truthy('hitAudio 命中（>30KB）', hit && hit.size === 40000)
await media.patchMeta(42, 'download', { n: '歌名', b: 320 })
await media.patchMeta(42, 'download', { q: 'exhigh' }) 
const meta = await media.readMeta(42, 'download')
eq('patchMeta 合并保留旧字段', meta && meta.n, '歌名')
eq('patchMeta 合并且更新新字段', meta && meta.q, 'exhigh')
truthy('曲目目录里不再有 metadata.json', !fs.existsSync(path.join(tk, 'metadata.json')))
await media.writeLyrics(42, { lrc: '[00:01]词', pureMusic: 0 })
eq('歌词读回', (await media.readLyrics(42))?.lrc, '[00:01]词')
truthy('曲目目录里不再有 lyrics.json', !fs.existsSync(path.join(tk, 'lyrics.json')))
const listed = await media.listTracks('download')
eq('listTracks 带出元数据', listed.length === 1 && listed[0].meta && listed[0].meta.n, '歌名')
await media.dropTrackDir(42, 'download')
truthy('dropTrackDir 删目录', !fs.existsSync(tk))
eq('dropTrackDir 同时删库里的元数据', await media.readMeta(42, 'download'), null)

console.log('\n6) 上层（config / history / session）走同一个库')
await config.load()
await config.set('rate', 1.5)
eq('config 写后读回', config.get('rate'), 1.5)
await config.load()
eq('config 重新 load 保留', config.get('rate'), 1.5)

await history.load()
history.record({ id: 11, name: '历史歌', artist: '某人' })
await new Promise((r) => setTimeout(r, 150))
eq('history 落库后可读', history.list().length, 1)

await session.save({ song: { id: 11 }, queue: [{ id: 11 }], index: 0, positionMs: 5000, playing: false })
await new Promise((r) => setTimeout(r, 200))
const back = await session.load()
eq('session 快照可读', back && back.positionMs, 5000)

console.log('\n7) 库文件')
truthy('local_index.db 存在于 data 根', fs.existsSync(paths.dbFile()))
truthy('state.db 存在于 data 根', fs.existsSync(paths.stateDbFile()))
{
  const raw = new DatabaseSync(paths.dbFile())
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  raw.close()
  for (const t of ['album', 'artist', 'playlist', 'playlist_track', 'track', 'track_artist']) {
    truthy('索引库表存在：' + t, tables.includes(t))
  }

  for (const t of ['kv', 'track_meta', 'track_lyric']) {
    truthy('索引库里没有 ' + t, !tables.includes(t))
  }
}
{
  const raw = new DatabaseSync(paths.stateDbFile())
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  raw.close()
  for (const t of ['kv', 'track_meta', 'track_lyric']) {
    truthy('状态库表存在：' + t, tables.includes(t))
  }
  for (const t of ['album', 'artist', 'track', 'track_artist', 'playlist', 'playlist_track']) {
    truthy('状态库里没有 ' + t, !tables.includes(t))
  }
}

console.log('\n' + '='.repeat(60))
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项 / 通过 ' + pass + ' 项')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exitCode = 1
} else {
  console.log('全部通过（' + pass + ' 项）')
}
console.log('沙箱保留在 ' + sandbox + '（DSH_SELFTEST_TRACE=1 可见执行的 shell 命令）')
