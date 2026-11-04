/**
 * 存储层集成自检（**不是产品代码**，只在 PC 上用 Node 跑）。
 *
 * 为什么需要它：存储重构的核心结论（sqlite 通道 / 每曲一目录 / 单尺寸封面 / 迁移幂等）
 * 全都落在平台边界上（$dataDir、只读 fs 模块、process.exec）。设备不在手边时，
 * 唯一能证明「这些代码真的跑得起来」的办法是：用真实文件系统 + 真实 shell 扮演平台，
 * 把模块**原样**跑一遍。
 *
 *   node scripts/storage_selftest.mjs
 *
 * 做法：把 src/ 整棵复制到临时目录，只把两个平台说明符（'fs' / 'process'）换成 shim，
 * 其余代码一字不改 —— 检验的是真产品逻辑，替换的只有平台边界。
 *
 * 覆盖：paths 形状 / media 每曲一目录 / db 建表与 upsert / cover 单尺寸不变式 /
 *       migrate 旧布局映射与幂等。
 */
import { exec as cpExec } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

/* ---------------- 结果统计 ---------------- */
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
const slash = (p) => String(p).replace(/\\/g, '/')

/* ---------------- 平台 shim ---------------- */
const fsShim = {
  // 平台 fs 只有这些能力，**没有写入接口**（写入一律走 shell），shim 保持一致
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
const procShim = {
  exec: (cmd, args, opts) => new Promise(function (resolve) {
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

/* ---------------- 复制 + 只替换平台说明符 ---------------- */
async function prepareTree(sandbox) {
  const shimDir = path.join(sandbox, '_shim')
  await fsp.mkdir(shimDir, { recursive: true })
  const fsUrl = pathToFileURL(path.join(shimDir, 'fs.mjs')).href
  const procUrl = pathToFileURL(path.join(shimDir, 'process.mjs')).href
  const httpUrl = pathToFileURL(path.join(shimDir, 'http.mjs')).href

  // shim 模块转发到全局，便于测试里改行为
  await fsp.writeFile(path.join(shimDir, 'fs.mjs'),
    'const s = globalThis.__fsShim\nexport default s\n' +
    ['exists', 'stat', 'readdir', 'mkdir', 'rm', 'readFile', 'statfs']
      .map(k => 'export const ' + k + ' = (...a) => s.' + k + '(...a)').join('\n') + '\n')
  await fsp.writeFile(path.join(shimDir, 'process.mjs'),
    'const p = globalThis.__procShim\nexport default p\nexport const exec = (...a) => p.exec(...a)\n')
  await fsp.writeFile(path.join(shimDir, 'http.mjs'),
    'const s = globalThis.__httpShim\nexport default s\nexport const request = (...a) => s.request(...a)\nexport const get = (...a) => s.get(...a)\n')

  // 整棵 src 复制过去（只拷 js/vue/json 等文本，跳过图标二进制）
  const srcDst = path.join(sandbox, 'src')
  await fsp.cp(path.join(ROOT, 'src/utils'), path.join(srcDst, 'utils'), { recursive: true })

  let rewritten = 0
  async function walk(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { await walk(p); continue }
      if (!e.name.endsWith('.js')) continue
      let s = await fsp.readFile(p, 'utf8')
      const before = s
      // 只动这两类平台说明符，别的一字不改
      s = s.replace(/from\s+(['"])fs\1/g, "from '" + fsUrl + "'")
      s = s.replace(/import\(\s*(['"])fs\1\s*\)/g, "import('" + fsUrl + "')")
      s = s.replace(/from\s+(['"])process\1/g, "from '" + procUrl + "'")
      s = s.replace(/import\(\s*(['"])process\1\s*\)/g, "import('" + procUrl + "')")
      s = s.replace(/from\s+(['"])http\1/g, "from '" + httpUrl + "'")
      s = s.replace(/import\(\s*(['"])http\1\s*\)/g, "import('" + httpUrl + "')")
      if (s !== before) { await fsp.writeFile(p, s); rewritten++ }
    }
  }
  await walk(path.join(srcDst, 'utils'))
  return { srcDst, rewritten }
}

/* ---------------- sqlite3 shim ---------------- */
/**
 * 被测代码要求 `sqlite3 -json`（≥3.33）。设备是 3.39.2 有它，但 PC 上常见的
 * 3.32 没有 —— 那样就测不到 db 层，只能测到「安全降级」。
 * 这里造一个支持 -json 的 sqlite3 顶到 PATH 前面（内部转给 python 的 sqlite3），
 * 从而在 PC 上完整验证 DDL / upsert / 导出。
 */
async function makeSqliteShim(sandbox) {
  const bin = path.join(sandbox, '_bin')
  await fsp.mkdir(bin, { recursive: true })
  const py = path.join(bin, 'sj.py')
  await fsp.writeFile(py, [
    'import sqlite3, sys, json',
    'args = sys.argv[1:]',
    'use_json = False',
    'db = None',
    'sql = None',
    'i = 0',
    'while i < len(args):',
    '    a = args[i]',
    '    if a == "-json":',
    '        use_json = True; i += 1; continue',
    '    if a == "-cmd":',
    '        i += 2; continue',
    '    if db is None: db = a',
    '    else: sql = a',
    '    i += 1',
    'if db is None: sys.exit(0)',
    'con = sqlite3.connect(db)',
    'con.execute("PRAGMA busy_timeout=8000")',
    'if not sql: sys.exit(0)',
    'text = sql.strip()',
    'rows = []',
    'src = None',
    'try:',
    '    # 支持 .read <file>（产品代码就是这么传 SQL 的：绕开命令行编码转换）',
    '    if text.lower().startswith(".read "):',
    '        path = text[6:].strip().strip(chr(34)).strip(chr(39))',
    '        src = open(path, encoding="utf-8").read()',
    '    else:',
    '        src = text',
    '    # 逐条执行，顺便捕获 SELECT 的结果（真 sqlite3 -json 对 .read 里的 SELECT 也输出）',
    '    for stmt in [x.strip() for x in src.split(chr(59)) if x.strip()]:',
    '        if stmt[:6].upper() == "SELECT":',
    '            cur = con.execute(stmt)',
    '            cols = [d[0] for d in cur.description] or []',
    '            for r in cur.fetchall():',
    '                rows.append(dict(zip(cols, r)))',
    '        else:',
    '            con.execute(stmt)',
    '    con.commit()',
    'except Exception as e:',
    '    sys.stderr.write(str(e) + chr(10)); sys.exit(1)',
    'if use_json and rows:',
    '    # 用 ascii 转义输出：Windows 控制台代码页会把非 ASCII 打死',
    '    sys.stdout.buffer.write((json.dumps(rows, ensure_ascii=False) + chr(10)).encode("utf-8"))',
    '    sys.stdout.buffer.flush()',
    'elif rows:',
    '    for r in rows: print("|".join("" if v is None else str(v) for v in r.values()))',
    ''
  ].join('\n'))
  // bash 只会执行无扩展名的脚本或 .exe —— 写一个 shebang 脚本顶到 PATH 最前面
  const sh = path.join(bin, 'sqlite3')
  await fsp.writeFile(sh, '#!/bin/sh\nexec python "' + slash(py) + '" "$@"\n')
  fs.chmodSync(sh, 0o755)
  // Windows 上同时给一份 cmd 可用的 .bat（exec 若走 cmd 也能命中）
  await fsp.writeFile(path.join(bin, 'sqlite3.bat'),
    '@echo off\r\npython "' + py + '" %*\r\n')
  return bin
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'bpn-storage-'))
  const dataDirPath = slash(path.join(sandbox, 'data'))
  await fsp.mkdir(dataDirPath, { recursive: true })
  globalThis.$dataDir = dataDirPath + '//' // 设备真实形态：双斜杠 + 尾斜杠
  globalThis.__fsShim = fsShim
  globalThis.__procShim = procShim
  // 让 PATH 先命中带 -json 的 sqlite3（设备同版本能力）
  const sqliteBin = await makeSqliteShim(sandbox)
  shDir = path.join(sandbox, '_sh')
  await fsp.mkdir(shDir, { recursive: true })
  const prevPath = process.env.PATH || ''
  process.env.PATH = sqliteBin + path.delimiter + prevPath

  const { srcDst, rewritten } = await prepareTree(sandbox)
  console.log('（复制 src/utils 到沙箱，替换平台说明符的文件数：' + rewritten + '）')

  const load = (rel) => import(pathToFileURL(path.join(srcDst, 'utils', rel)).href)

  console.log('\n1) paths —— 布局形状')
  const paths = await load('paths.js')
  eq('normDir 抹掉双斜杠与尾斜杠', paths.normDir(), dataDirPath)
  eq('downloads 根', paths.downloadsDir(), dataDirPath + '/downloads')
  eq('cache 根', paths.cacheDir(), dataDirPath + '/cache')
  eq('thumbs 在 cache 下', paths.thumbsDir(), dataDirPath + '/cache/thumbs')
  eq('track 目录 = <root>/<id>', paths.trackDir(123, 'download'), dataDirPath + '/downloads/123')
  eq('音频固定叫 track.<ext>', paths.trackFile(123, 'flac', 'download'), dataDirPath + '/downloads/123/track.flac')
  eq('封面固定叫 cover.jpg', paths.trackCover(123, 'download'), dataDirPath + '/downloads/123/cover.jpg')
  eq('kind 归一化：非 download 都是 cache', paths.rootOf('whatever'), dataDirPath + '/cache')

  console.log('\n2) media —— 每曲一目录')
  const media = await load('media.js')
  await media.ensureTrackDir(123, 'download')
  truthy('建目录', await media.hasTrackDir(123, 'download'))
  eq('没有音频时 hitAudio 为 null', await media.hitAudio(123, 'download'), null)
  await fsp.writeFile(paths.trackFile(123, 'mp3', 'download'), Buffer.alloc(1000))
  eq('半截文件不算命中', await media.hitAudio(123, 'download'), null)
  await fsp.writeFile(paths.trackFile(123, 'mp3', 'download'), Buffer.alloc(40000))
  const hit = await media.hitAudio(123, 'download')
  truthy('>30KB 才算命中', hit && hit.ext === 'mp3')

  await media.patchMeta(123, 'download', { n: '歌名', a: '歌手' })
  await media.patchMeta(123, 'download', { q: 'exhigh' })
  eq('metadata 合并写不互相擦除', await media.readMeta(123, 'download'), { n: '歌名', a: '歌手', q: 'exhigh' })

  await media.writeLyrics(123, 'download', { lrc: '[00:01.00]hi', pureMusic: false })
  const lyr = await media.readLyrics(123, 'download')
  truthy('lyrics 落盘可读', lyr && lyr.lrc === '[00:01.00]hi')
  eq('没词不写空壳', await media.writeLyrics(124, 'download', { lrc: '' }), false)

  await media.dropTrackDir(123, 'download')
  eq('删目录连坐（音频/元数据/歌词一起走）', await media.hasTrackDir(123, 'download'), false)

  console.log('\n3) db —— SQLite 索引库')
  const db = await load('db.js')
  truthy('通道可用（真 sqlite3 CLI）', await db.ensureDb())
  await db.open()
  // 契约：exec 只落盘，内存由调用方维护（见 db.exec 注释）
  await db.exec([db.upsertSql('track', [
    { name: 'id', v: 1, raw: true },
    { name: 'name', v: "It's a test" },
    { name: 'dl_origin', v: 1, raw: true }
  ], 'id')])
  await db.flushAll()
  // 重新导出：证明 SQL 真的写进库了（不是只在内存）
  db.reset()
  await db.open()
  eq('写入落盘（重新导出可见）', db.data().track['1'] && db.data().track['1'].name, "It's a test")
  eq('列值正确', db.data().track['1'].dl_origin, 1)
  // 冲突更新
  await db.exec([db.upsertSql('track', [{ name: 'id', v: 1, raw: true }, { name: 'name', v: '改过' }], 'id')])
  await db.flushAll()
  db.reset()
  await db.open()
  eq('upsert 冲突走更新', db.data().track['1'].name, '改过')
  eq('未被覆盖的列还在', db.data().track['1'].dl_origin, 1)
  // 单引号转义（值里带 ' 不能炸 SQL）
  await db.exec([db.upsertSql('artist', [{ name: 'id', v: 2, raw: true }, { name: 'name', v: "O'Brien" }], 'id')])
  await db.flushAll()
  db.reset()
  await db.open()
  eq('单引号值安全转义', db.data().artist['2'].name, "O'Brien")

  console.log('\n4) cover —— 单尺寸不变式')
  const coverSrc = await fsp.readFile(path.join(srcDst, 'utils/cover.js'), 'utf8')
  truthy('曲目封面走单尺寸常量', /TRACK_SIZE\s*=\s*BIG_COVER/.test(coverSrc))
  truthy('曲目封面有独立内存键表（不与缩略图混用）', /memTrack/.test(coverSrc))
  truthy('纯数字 id 走曲目目录', /isSongId/.test(coverSrc) && /trackDir/.test(coverSrc))

  console.log('\n5) migrate —— 旧布局映射与幂等')
  const legacyMusic = slash(paths.legacyMusicDir())
  const legacyLrc = slash(paths.legacyLrcDir())
  const legacyStore = slash(paths.legacyStoreDir())
  const legacyCovers = slash(paths.legacyCoversDir())
  const legacyStorage = slash(paths.legacyStorageDir())
  for (const dir of [legacyMusic, legacyLrc, legacyStore, legacyCovers, legacyStorage]) {
    await fsp.mkdir(dir, { recursive: true })
  }
  await fsp.writeFile(legacyMusic + '/456.mp3', Buffer.alloc(50000))
  await fsp.writeFile(legacyLrc + '/456.json', JSON.stringify({ l: '[00:01.00]old', t: '', pm: 0, y: '' }))
  await fsp.writeFile(legacyStore + '/local_index.json', JSON.stringify({
    456: { n: '旧歌', alia: [], ars: [{ i: 7, n: '旧歌手' }], al: { i: 8, n: '旧专辑', c: 'http://c/x.jpg' }, d: 200000, pub: 0, no: 1, cd: '01', pop: 0, fee: 0 }
  }))
  await fsp.writeFile(legacyCovers + '/456_200.jpg', Buffer.alloc(2000))
  await fsp.writeFile(legacyStorage + '/preferences.json', JSON.stringify({
    ncm_settings: JSON.stringify({ layoutVersion: 0, rate: 1.25 }),
    bpncm_dl_origin: JSON.stringify({ 456: 1 })
  }))

  const migrate = await load('migrate.js')
  eq('LAYOUT_VERSION 是 2', migrate.LAYOUT_VERSION, 2)
  await migrate.run(0)

  const dlDir = slash(paths.trackDir(456, 'download'))
  truthy('音频搬到 downloads/<id>/track.mp3', fs.existsSync(dlDir + '/track.mp3'))
  truthy('歌词搬到 lyrics.json', fs.existsSync(dlDir + '/lyrics.json'))
  const newLyr = JSON.parse(await fsp.readFile(dlDir + '/lyrics.json', 'utf8'))
  eq('歌词字段改名 l→lrc', newLyr.lrc, '[00:01.00]old')
  truthy('封面搬到 cover.jpg', fs.existsSync(dlDir + '/cover.jpg'))

  db.reset()
  await db.open()
  const t = db.data().track['456']
  truthy('曲目进 track 表', t && t.name === '旧歌')
  eq('归属进 dl_origin 列', t && t.dl_origin, 1)
  truthy('专辑进 album 表', db.data().album['8'] && db.data().album['8'].name === '旧专辑')
  truthy('歌手进 artist 表', db.data().artist['7'] && db.data().artist['7'].name === '旧歌手')
  truthy('曲目↔歌手多对多', db.data().track_artist.some(r => String(r.track_id) === '456' && String(r.artist_id) === '7'))

  const cfg = JSON.parse(await fsp.readFile(slash(paths.configFile()), 'utf8'))
  eq('ncm_settings → config.json（保留原字段）', cfg.rate, 1.25)
  truthy('layoutVersion 写回 2', cfg.layoutVersion === 2)

  await migrate.run(2)
  truthy('重跑幂等：不产生 track.flac 并存',
    !(fs.existsSync(dlDir + '/track.mp3') && fs.existsSync(dlDir + '/track.flac')))
  eq('重跑幂等：歌词没被改坏',
    JSON.parse(await fsp.readFile(dlDir + '/lyrics.json', 'utf8')).lrc, '[00:01.00]old')

  console.log('\n' + '='.repeat(56))
  if (failures.length) {
    console.log('结果：' + pass + ' 项通过，' + failures.length + ' 项失败')
    failures.forEach(f => console.log('  ✗ ' + f))
    await fsp.rm(sandbox, { recursive: true, force: true })
    process.exit(1)
  }
  console.log('结果：全部 ' + pass + ' 项通过')
  await fsp.rm(sandbox, { recursive: true, force: true })
}

main().catch(async function (e) {
  console.error('自检自身异常：', e)
  process.exit(1)
})
