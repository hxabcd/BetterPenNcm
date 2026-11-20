/**
 * SQLite 通道 —— **原生 `sqlite3` 模块**（`import('sqlite3')`），不走 CLI。
 *
 * ⚠ 不要改回 `process.exec` + `/usr/bin/sqlite3`。那条路每次调用都是一次 fork
 *   （S7 真机实测 92~139ms/次），而且 SQL 不能走命令行参数（非 ASCII 会经过一次
 *   本机代码页转换），只能「写一个临时 .sql 文件再 `.read`」—— 于是每读一次表还得
 *   额外付两次文件 I/O。原生模块一次 bind+step 是微秒级，也没有任何编码环节。
 *   同一份 134KB 数据真机实测：原生 sqlite 写入 10ms、读回 2ms；
 *   走 shell 分片写文本文件要 2511ms（见 docs/存储层.md）。
 *
 * ## 两个库，职责不混
 *
 *   local_index.db（`paths.dbFile()`）—— **只有索引**
 *     album / artist / track / track_artist / playlist / playlist_track
 *     boot 整表灌内存，此后查询不分叉；写走批量语句（一批一个事务）。
 *     **可重建**：丢了从音频文件与网络重扫，所以允许整个删掉。
 *
 *   state.db（`paths.stateDbFile()`）—— **用户资产**
 *     kv           配置 / 登录 Cookie / 播放会话快照 / 播放历史
 *     track_meta   每曲元数据（原 metadata.json）
 *     track_lyric  每曲歌词（原 lyrics.json）
 *     丢一个要重新登录 / 丢播放进度，所以和索引库里外分开：
 *     重置索引不会碰到登录态，反之亦然。
 *
 * 两个库各有一个长连接（`conn.index` / `conn.state`），互不干扰。
 *
 * ## 为什么保留「拼 SQL 文本」的写接口
 *
 * `upsertSql` / `deleteSql` 返回语句文本，`exec(list)` 把它们打包进一个事务。
 * 调用方（localmeta / locallists / dlorigin / artistmeta）已按这个形状写好，
 * 而语句文本现在直接交给 `db.exec()`，**不再经过 shell** —— 所以值里的引号只需按
 * SQL 自己的规则转义（`q()`：`'` → `''`），不必再套一层 shell 转义。
 *
 * ## 故障语义
 *
 * 所有函数**不抛**：通道不可用（没有 sqlite3 原生模块 / 打不开库）时 `data()` 给空表，
 * 上层按「没有本地库」降级。文件系统才是真相 —— 索引丢了能从文件与网络重建，
 * 这比「整个应用起不来」好。
 */
import { ensureDir } from './fsutil.js'
import { dbFile, stateDbFile, normDir } from './paths.js'
import { log } from './log.js'

/** 索引表名常量（只在这里出现，不接受外部拼装） */
export const TABLES = ['album', 'artist', 'track', 'track_artist', 'playlist', 'playlist_track']

/** 索引库 DDL。全部 `IF NOT EXISTS`：老库升级时只补表，不重建已有索引。 */
const DDL_INDEX = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'CREATE TABLE IF NOT EXISTS album (',
  '  id INTEGER PRIMARY KEY,',
  '  name TEXT NOT NULL DEFAULT "",',
  '  cover TEXT NOT NULL DEFAULT "",',
  '  pub INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE TABLE IF NOT EXISTS artist (',
  '  id INTEGER PRIMARY KEY,',
  '  name TEXT NOT NULL DEFAULT "",',
  '  avatar TEXT NOT NULL DEFAULT "",',
  '  av_at INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE TABLE IF NOT EXISTS track (',
  '  id INTEGER PRIMARY KEY,',
  '  name TEXT NOT NULL DEFAULT "",',
  '  alias TEXT NOT NULL DEFAULT "",',
  '  album_id INTEGER NOT NULL DEFAULT 0,',
  '  duration INTEGER NOT NULL DEFAULT 0,',
  '  pub INTEGER NOT NULL DEFAULT 0,',
  '  track_no INTEGER NOT NULL DEFAULT 0,',
  '  disc TEXT NOT NULL DEFAULT "",',
  '  pop INTEGER NOT NULL DEFAULT 0,',
  '  fee INTEGER NOT NULL DEFAULT 0,',
  '  cover TEXT NOT NULL DEFAULT "",',
  '  dl_origin INTEGER NOT NULL DEFAULT 0,',
  '  added_at INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE TABLE IF NOT EXISTS track_artist (',
  '  track_id INTEGER NOT NULL,',
  '  artist_id INTEGER NOT NULL,',
  '  ord INTEGER NOT NULL DEFAULT 0,',
  '  PRIMARY KEY (track_id, artist_id)',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_ta_artist ON track_artist(artist_id);',
  'CREATE TABLE IF NOT EXISTS playlist (',
  '  id INTEGER PRIMARY KEY,',
  '  name TEXT NOT NULL DEFAULT "",',
  '  cover TEXT NOT NULL DEFAULT "",',
  '  creator TEXT NOT NULL DEFAULT "",',
  '  track_cnt INTEGER NOT NULL DEFAULT 0,',
  '  base_ids TEXT NOT NULL DEFAULT "",',
  '  remote_ids TEXT NOT NULL DEFAULT "",',
  '  pulled_at INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE TABLE IF NOT EXISTS playlist_track (',
  '  playlist_id INTEGER NOT NULL,',
  '  track_id INTEGER NOT NULL,',
  '  ord INTEGER NOT NULL DEFAULT 0,',
  '  PRIMARY KEY (playlist_id, track_id)',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_pt_track ON playlist_track(track_id);',
  'PRAGMA user_version = 1;'
].join('\n')

/** 状态库 DDL：kv（配置/凭据/会话/历史）+ 每曲元数据与歌词。 */const DDL_STATE = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'CREATE TABLE IF NOT EXISTS kv (',
  '  k TEXT PRIMARY KEY,', // ncm_settings / ncm_cookies / bpncm_player_state / bpncm_playhist
  '  v TEXT NOT NULL DEFAULT "",',
  '  t INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE TABLE IF NOT EXISTS track_meta (', // 原 <track>/metadata.json
  '  id INTEGER NOT NULL,',
  '  kind INTEGER NOT NULL,', // 1 = downloads（用户下载） 2 = cache（播放缓存）
  '  v TEXT NOT NULL DEFAULT "",',
  '  t INTEGER NOT NULL DEFAULT 0,',
  '  PRIMARY KEY (id, kind)',
  ');',
  'CREATE TABLE IF NOT EXISTS track_lyric (', // 原 <track>/lyrics.json
  '  id INTEGER NOT NULL,',
  '  v TEXT NOT NULL DEFAULT "",',
  '  t INTEGER NOT NULL DEFAULT 0,',
  '  PRIMARY KEY (id)',
  ');',
  'PRAGMA user_version = 1;'
].join('\n')

/** SQL 字面量：单引号包裹，内部 ' 翻倍（SQLite 标准转义；不再经过 shell，所以只此一层） */
export function q(v) {
  if (v === undefined || v === null) return 'NULL'
  return "'" + String(v).replace(/'/g, "''") + "'"
}

/** 数字字面量：非有限数一律 0（避免把 NaN/undefined 写成 SQL 语法错误） */
export function num(v) {
  const n = Number(v)
  return isFinite(n) ? String(n) : '0'
}

/* ---------------- 通道（两个库各一条长连接） ---------------- */

/** 原生模块的成功约定：0 / true / 'OK' / 空返回值都算成功，其余（错误信息字符串）算失败 */
function okRc(rc) {
  return rc === 0 || rc === true || rc === 'OK' || rc === undefined || rc === null
}

const conns = {} // 'index' | 'state' → sqlite3.Database
const readies = {} // 'index' | 'state' → Promise<Database|null>

/** 两个库的打开参数（路径 + DDL），键名即上面的用途名 */
const BANKS = {
  index: { path: dbFile, ddl: DDL_INDEX, what: '索引库' },
  state: { path: stateDbFile, ddl: DDL_STATE, what: '状态库' }
}

/**
 * 打开某个库并建表（幂等）。返回 Database 实例；**通道不可用时返回 null**（调用方按空库降级）。
 *
 * 用动态 `import()` 而不是顶层静态 import：与工程里 `import('fs')` / `import('process')`
 * 同一形态 —— 裸模块由运行时解析，打包器不插手；模块缺失时也只是这一处失败。
 */
function ensureBank(name) {
  if (readies[name]) return readies[name]
  const bank = BANKS[name]
  readies[name] = (async function () {
    try {
      const m = await import('sqlite3')
      const sqlite3 = (m && m.default) || m
      if (!sqlite3 || typeof sqlite3.Database !== 'function') {
        log('db', '平台没有 sqlite3 原生模块，' + bank.what + '降级为空')
        return null
      }
      await ensureDir(normDir())
      const db = new sqlite3.Database()
      const file = bank.path()
      const openRc = await db.open(file)
      if (!okRc(openRc)) {
        log('db', '打开' + bank.what + '失败：' + openRc)
        return null
      }
      const ddlRc = await db.exec(bank.ddl)
      if (!okRc(ddlRc)) {
        log('db', '建表失败（' + bank.what + '）：' + String(ddlRc).slice(0, 160))
        return null
      }
      conns[name] = db
      log('db', bank.what + '就绪 ' + file.replace(normDir() + '/', ''))
      return db
    } catch (e) {
      log('db', '打开' + bank.what + '异常：' + ((e && e.message) || e))
      return null
    }
  })()
  return readies[name]
}

/** 索引库（对外保留原导出名：boot 用它建表） */
export function ensureDb() {
  return ensureBank('index')
}

/** 状态库（kv / 每曲元数据 / 歌词）。上层一般不用直接调，读写函数内部会等它 */
export function ensureStateDb() {
  return ensureBank('state')
}

/* ---------------- 底层三原语（按库区分） ---------------- */

/**
 * 执行一段 SQL 文本（可含多条语句）。返回 **''=成功**，否则返回错误文本；通道不可用返回 null。
 * 与旧 CLI 版的返回约定一致，方便上层判断。
 */
async function runText(name, text) {
  const db = await ensureBank(name)
  if (!db) return null
  try {
    const rc = await db.exec(text)
    return okRc(rc) ? '' : String(rc)
  } catch (e) {
    return String((e && e.message) || e)
  }
}

/** 行数组 → 对象数组。原生 `step()` 回的是**按列顺序的数组**，靠 columnNameList 对齐。 */
async function toObjects(st, rows) {
  let cols = []
  try {
    cols = (await st.columnNameList()) || []
  } catch (e) {
    cols = []
  }
  const out = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      out.push(r) // 万一某些固件直接给对象
      continue
    }
    const o = {}
    for (let k = 0; k < cols.length; k++) o[cols[k]] = Array.isArray(r) ? r[k] : undefined
    out.push(o)
  }
  return out
}

/** 带绑定参数执行一条写语句。返回 **''=成功**，否则错误文本；通道不可用返回 null。 */
async function runStmt(name, sql, params) {
  const db = await ensureBank(name)
  if (!db) return null
  let st = null
  try {
    st = await db.prepare(sql)
    if (!st) return 'prepare 失败'
    if (params && params.length) await st.bind(params)
    const rc = await st.run()
    return okRc(rc) ? '' : String(rc)
  } catch (e) {
    return String((e && e.message) || e)
  } finally {
    if (st) {
      try {
        await st.finalize()
      } catch (e) {}
    }
  }
}

/** 带绑定参数查询。通道不可用/出错一律返回 []（调用方无需 try）。 */
async function query(name, sql, params) {
  const db = await ensureBank(name)
  if (!db) return []
  let st = null
  try {
    st = await db.prepare(sql)
    if (!st) return []
    if (params && params.length) await st.bind(params)
    const rows = (await st.all()) || []
    return await toObjects(st, rows)
  } catch (e) {
    log('db', '查询失败：' + ((e && e.message) || e))
    return []
  } finally {
    if (st) {
      try {
        await st.finalize()
      } catch (e) {}
    }
  }
}

/* ---------------- 键值表（原 store.js 的四个顶层 JSON 文件）→ 状态库 ---------------- */

/** 读一个 key；没有/通道不可用给 null */
export async function kvGet(k) {
  const rows = await query('state', 'SELECT v FROM kv WHERE k = ?;', [String(k)])
  if (!rows.length) return null
  const v = rows[0].v
  return v === undefined || v === null ? null : String(v)
}

/** 写一个 key（整行替换）。返回是否成功 */
export async function kvPut(k, v) {
  const text = v === undefined || v === null ? '' : String(v)
  const err = await runStmt('state', 'INSERT OR REPLACE INTO kv (k, v, t) VALUES (?, ?, ?);',
    [String(k), text, Date.now()])
  if (err) {
    if (err !== null) log('db', '写 kv 失败 ' + k + '：' + String(err).slice(0, 120))
    return false
  }
  return true
}

/** 删一个 key */
export async function kvDel(k) {
  const err = await runStmt('state', 'DELETE FROM kv WHERE k = ?;', [String(k)])
  return err === ''
}

/* ---------------- 每曲文档表（原 metadata.json / lyrics.json）→ 状态库 ---------------- */

/** kind → 表里的整数（下载 = 1，播放缓存 = 2） */
export function kindCode(kind) {
  return kind === 'download' ? 1 : 2
}

/** 读一条曲目文档；没有给 null */
export async function docGet(table, id, kind) {
  const params = kind === undefined ? [Number(id) || 0] : [Number(id) || 0, kindCode(kind)]
  const where = kind === undefined ? 'id = ?' : 'id = ? AND kind = ?'
  const rows = await query('state', 'SELECT v FROM ' + table + ' WHERE ' + where + ';', params)
  if (!rows.length) return null
  const v = rows[0].v
  return v === undefined || v === null ? null : String(v)
}

/**
 * 一次取出某类文档的全部行（`{ id: 文本 }`）。
 * 扫目录时用：几百首曲目逐条 prepare 不合算，一条 SELECT 全拿出来再按 id 取。
 */
export async function docAll(table, kind) {
  const params = kind === undefined ? [] : [kindCode(kind)]
  const where = kind === undefined ? '' : ' WHERE kind = ?'
  const rows = await query('state', 'SELECT id, v FROM ' + table + where + ';', params)
  const out = {}
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].id
    const v = rows[i].v
    if (id === undefined || id === null) continue
    out[String(id)] = v === undefined || v === null ? '' : String(v)
  }
  return out
}

/** 写一条曲目文档（整行替换）；返回是否成功 */
export async function docPut(table, id, kind, text) {
  const nid = Number(id) || 0
  if (!nid) return false
  const s = text === undefined || text === null ? '' : String(text)
  const err = kind === undefined
    ? await runStmt('state', 'INSERT OR REPLACE INTO ' + table + ' (id, v, t) VALUES (?, ?, ?);',
      [nid, s, Date.now()])
    : await runStmt('state', 'INSERT OR REPLACE INTO ' + table + ' (id, kind, v, t) VALUES (?, ?, ?, ?);',
      [nid, kindCode(kind), s, Date.now()])
  if (err) {
    if (err !== null) log('db', '写 ' + table + ' 失败 ' + id + '：' + String(err).slice(0, 120))
    return false
  }
  return true
}

/** 删一条曲目文档 */
export async function docDel(table, id, kind) {
  const nid = Number(id) || 0
  if (!nid) return false
  const err = kind === undefined
    ? await runStmt('state', 'DELETE FROM ' + table + ' WHERE id = ?;', [nid])
    : await runStmt('state', 'DELETE FROM ' + table + ' WHERE id = ? AND kind = ?;', [nid, kindCode(kind)])
  return err === ''
}

/* ---------------- 索引导出到内存 ---------------- */

let mem = null // { album:{id:row}, artist, track, playlist, track_artist:[], playlist_track:[] }
let loading = null
let writeChain = Promise.resolve() // 所有索引写串行，且合并成批

/** 导出单表为对象数组（索引库） */
async function dumpTable(name) {
  return query('index', 'SELECT * FROM ' + name + ';')
}

/** 导出全部索引表到内存（open 时一次；此后查询不再查库） */
export function open() {
  if (mem) return Promise.resolve(mem)
  if (loading) return loading
  loading = (async function () {
    await ensureBank('index')
    const m = {
      album: {},
      artist: {},
      track: {},
      playlist: {},
      track_artist: [],
      playlist_track: []
    }
    const names = ['album', 'artist', 'track', 'playlist']
    const dumps = await Promise.all(names.map(dumpTable))
    for (let i = 0; i < names.length; i++) {
      const rows = dumps[i]
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k]
        if (r && r.id !== undefined) m[names[i]][String(r.id)] = r
      }
    }
    const ta = await dumpTable('track_artist')
    const pt = await dumpTable('playlist_track')
    m.track_artist = ta
    m.playlist_track = pt
    mem = m
    loading = null
    log('db', '载入内存 album=' + Object.keys(m.album).length +
      ' artist=' + Object.keys(m.artist).length +
      ' track=' + Object.keys(m.track).length +
      ' playlist=' + Object.keys(m.playlist).length +
      ' ta=' + ta.length + ' pt=' + pt.length)
    return m
  })()
  return loading
}

/** 内存态（未 open 时为 null；调用方须先 await open()） */
export function data() {
  return mem
}

/** 丢弃内存态（迁移/测试用，下次 open 重新导出） */
export function reset() {
  mem = null
  loading = null
}

/* ---------------- 索引写（串行 + 批量） ---------------- */

let pending = [] // 待写 SQL 语句（同一批 BEGIN/COMMIT）

/** 把一批语句入队并尽快写出；返回本次落盘完成的 Promise（失败不抛，只记日志） */
function flush() {
  const batch = pending
  pending = []
  if (!batch.length) return writeChain
  writeChain = writeChain.then(async function () {
    const err = await runText('index', 'BEGIN;\n' + batch.join('\n') + '\nCOMMIT;')
    if (err === null) return false // 通道不可用
    if (err) {
      // 事务中途失败会把它留在打开状态；不回滚的话后续 BEGIN 全部报错
      await runText('index', 'ROLLBACK;')
      log('db', '写索引库失败：' + String(err).slice(0, 160))
      return false
    }
    return true
  })
  return writeChain
}

/**
 * 执行若干条**索引** SQL（调用方拼好、**值都过 q()/num()**）。
 * 与同一事件循环内的其它 insert 合并成一批：一个事务写多条。
 *
 * ⚠ **本函数只落盘，不改内存态。** 内存是读的真相，由各调用方在写 SQL 的同一步里
 * 自己更新（例如 localmeta.putIndex 写完既 mem[k]=rec 又 db.exec([...])）。
 */
export function exec(sqlList) {
  if (!sqlList || !sqlList.length) return Promise.resolve(false)
  for (let i = 0; i < sqlList.length; i++) pending.push(sqlList[i])
  return flush()
}

/** 整表 upsert 的语句生成：cols = [{name, v, raw?}]，conflict = 主键列名 */
export function upsertSql(table, cols, pk) {
  const names = []
  const vals = []
  for (let i = 0; i < cols.length; i++) {
    names.push(cols[i].name)
    vals.push(cols[i].raw ? String(cols[i].v) : q(cols[i].v))
  }
  const sets = []
  for (let i = 0; i < names.length; i++) {
    if (names[i] === pk) continue
    sets.push(names[i] + ' = excluded.' + names[i])
  }
  return 'INSERT INTO ' + table + ' (' + names.join(',') + ') VALUES (' + vals.join(',') + ')' +
    (sets.length ? ' ON CONFLICT(' + pk + ') DO UPDATE SET ' + sets.join(',') : ' ON CONFLICT(' + pk + ') DO NOTHING') +
    ';'
}

/** 简单删除语句 */
export function deleteSql(table, whereSql) {
  return 'DELETE FROM ' + table + ' WHERE ' + whereSql + ';'
}

/**
 * 等待所有在飞的**索引**写落盘（boot/退出/迁移收尾用）。
 * 不抛：失败已由 flush 记过日志。
 *
 * kv / 每曲文档走的是 `runStmt`（单行 upsert 立刻返回），没有排队，不需要等。
 */
export function flushAll() {
  return flush().then(function () {
    return writeChain
  })
}
