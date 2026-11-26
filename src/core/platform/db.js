

// SQLite 通道 —— 原生 import('sqlite3') 模块，不走 CLI。
// ⚠ 不要改回 process.exec + /usr/bin/sqlite3：每次调用 = 一次 fork（S7 真机实测 92~139ms/次），
// 且 SQL 不能走命令行参数（非 ASCII 会经本机代码页转换），只能写临时 .sql 文件再 .read，
// 每读一次表还多付两次文件 I/O。同一份 134KB 数据真机实测：原生 sqlite 写入 10ms / 读回 2ms，
// shell 分片写文本 2511ms。
//
// 两个库，职责不混（各一条长连接）：
//   local_index.db（dbFile()）—— 只有索引：boot 整表灌内存，此后查询不分叉；写走批量语句（一批一个事务）。
//     可重建：丢了从音频文件与网络重扫，所以允许整个删掉。
//   state.db（stateDbFile()）—— 用户资产：kv（配置 / 登录 Cookie / 播放会话 / 播放历史）、
//     track_meta（每曲元数据）、track_lyric（每曲歌词）。丢了要重新登录 / 丢播放进度，
//     所以和索引库里外分开：重置索引不会碰到登录态。
//
// 故障语义：所有函数不抛 —— 通道不可用（没有 sqlite3 原生模块 / 打不开库）时 data() 给空表，
// 上层按「没有本地库」降级；文件系统才是真相，索引丢了能重建，好过整个应用起不来。

import { ensureDir } from './fsutil.js'
import { dbFile, stateDbFile, normDir } from '../infra/paths.js'
import { log } from '../../core/infra/log.js'

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

/** 状态库 DDL：kv（配置/凭据/会话/历史）+ 每曲元数据与歌词。
 *  kv.k 取值：ncm_settings / ncm_cookies / bpncm_player_state / bpncm_playhist；
 *  track_meta 原 `<track>` 目录下的 metadata.json，track_lyric 原 lyrics.json。 */
const DDL_STATE = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'CREATE TABLE IF NOT EXISTS kv (',
  '  k TEXT PRIMARY KEY,', 
  '  v TEXT NOT NULL DEFAULT "",',
  '  t INTEGER NOT NULL DEFAULT 0',
  ');',
  'CREATE TABLE IF NOT EXISTS track_meta (', 
  '  id INTEGER NOT NULL,',
  '  kind INTEGER NOT NULL,', 
  '  v TEXT NOT NULL DEFAULT "",',
  '  t INTEGER NOT NULL DEFAULT 0,',
  '  PRIMARY KEY (id, kind)',
  ');',
  'CREATE TABLE IF NOT EXISTS track_lyric (', 
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

/** 原生模块的成功约定：0 / true / 'OK' / 空返回值都算成功，其余（错误信息字符串）算失败 */
function okRc(rc) {
  return rc === 0 || rc === true || rc === 'OK' || rc === undefined || rc === null
}

// 'index' | 'state' → sqlite3.Database（长连接）/ Promise<Database|null>
const conns = {} 
const readies = {} 

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

/**
 * 执行一段 SQL 文本（可含多条语句）。返回 **''=成功**，否则返回错误文本；通道不可用返回 null。
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
      out.push(r) 
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

export async function kvGet(k) {
  const rows = await query('state', 'SELECT v FROM kv WHERE k = ?;', [String(k)])
  if (!rows.length) return null
  const v = rows[0].v
  return v === undefined || v === null ? null : String(v)
}

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

export async function kvDel(k) {
  const err = await runStmt('state', 'DELETE FROM kv WHERE k = ?;', [String(k)])
  return err === ''
}

/** kind → 表里的整数（下载 = 1，播放缓存 = 2） */
export function kindCode(kind) {
  return kind === 'download' ? 1 : 2
}

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

export async function docDel(table, id, kind) {
  const nid = Number(id) || 0
  if (!nid) return false
  const err = kind === undefined
    ? await runStmt('state', 'DELETE FROM ' + table + ' WHERE id = ?;', [nid])
    : await runStmt('state', 'DELETE FROM ' + table + ' WHERE id = ? AND kind = ?;', [nid, kindCode(kind)])
  return err === ''
}

/** 内存态中 album/artist/track/playlist → {id: row}，track_artist/playlist_track → 行数组 */
let mem = null 
let loading = null
// 所有索引写串行，且同一事件循环内的多条合并成一批
let writeChain = Promise.resolve() 

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

export function data() {
  return mem
}

export function reset() {
  mem = null
  loading = null
}

// 待写 SQL 语句（同一批 BEGIN/COMMIT）
let pending = [] 

/** 把一批语句入队并尽快写出；返回本次落盘完成的 Promise（失败不抛，只记日志） */
function flush() {
  const batch = pending
  pending = []
  if (!batch.length) return writeChain
  writeChain = writeChain.then(async function () {
    const err = await runText('index', 'BEGIN;\n' + batch.join('\n') + '\nCOMMIT;')
    if (err === null) return false 
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

/** 整表 upsert 的语句生成：cols = [{name, v, raw?}]，pk = 主键列名 */
export function upsertSql(table, cols, pk) {
  const names = []
  const vals = []
  let pkVal = 'NULL'
  for (let i = 0; i < cols.length; i++) {
    const lit = cols[i].raw ? String(cols[i].v) : q(cols[i].v)
    names.push(cols[i].name)
    vals.push(lit)
    if (cols[i].name === pk) pkVal = lit
  }

  // ⚠ 不要改回 `INSERT ... ON CONFLICT(pk) DO UPDATE`：X3S 的 libsqlite3 是 **3.21.0**
  // （2017，UPSERT 语法 3.24 才加入），真机上会报 `near "ON": syntax error`，整批索引写失败
  // （2026-11-22 X3S 实测：下载成功后 track 表仍为空）。
  // `INSERT OR IGNORE` + `UPDATE` 是 3.21 兼容的等价语义：已存在时只更新列出的列，
  // 未列出的列（track.dl_origin / artist.avatar 等）保持原值。代价是每行两条语句。
  const insert = 'INSERT OR IGNORE INTO ' + table + ' (' + names.join(',') + ') VALUES (' + vals.join(',') + ');'
  const sets = []
  for (let i = 0; i < names.length; i++) {
    if (names[i] === pk) continue
    sets.push(names[i] + ' = ' + vals[i])
  }
  if (!sets.length) return insert
  return insert + '\nUPDATE ' + table + ' SET ' + sets.join(',') + ' WHERE ' + pk + ' = ' + pkVal + ';'
}

export function deleteSql(table, whereSql) {
  return 'DELETE FROM ' + table + ' WHERE ' + whereSql + ';'
}
