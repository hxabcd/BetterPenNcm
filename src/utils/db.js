/**
 * SQLite 索引库通道 —— 平台**没有原生 sqlite 模块**，只能走 `sqlite3` CLI（每次 fork ≈50ms）。
 *
 * ## 访问模型：boot 整表灌内存 + 写穿
 *
 *   open()   建库建表（幂等），一次 `sqlite3 -json` 批量导出各表 → 内存对象
 *   *Of/all  **纯内存**查询，不分叉（与旧 store/local_index.json 的读路径同速）
 *   upsert   单条 `INSERT ... ON CONFLICT DO UPDATE`，一次 fork；**代价与库规模无关**
 *            —— 这正是相对旧「整表 JSON 重写」的收益（写一条不再重写整份 62KB）
 *
 * 所以本模块**不得**出现在任何轮询/高频路径上。播放快照、播放历史这类「每 5~15 秒整份重写」
 * 的小块**没有**进这里，仍在顶层 JSON 文件（见 docs/存储重构.md §1.2）。
 *
 * ## 为什么手写 SQL 字符串
 *
 * 没有可用的绑定参数通道（CLI 每次都是一个新进程），只能拼字符串。所以：
 *   - 所有值过 `q()`（单引号 + 内部 ' 转义），**永远不要**把未经 q() 的值拼进 SQL；
 *   - 表名/列名只来自本文件的常量，不接受外部输入；
 *   - 整批改动包在 `BEGIN; ...; COMMIT;` 里，一批只 fork 一次。
 *
 * ## 故障语义
 *
 * 所有函数**不抛**：通道不可用（没有 sqlite3 二进制）时 `available()` 为 false，
 * 上层按「没有本地库」降级（列表为空），写操作静默失败但内存态仍对 —— 文件系统才是真相，
 * 索引丢了能从文件与网络重建，这比「整个应用起不来」好。
 */
import { run, has } from './exec.js'
import { ensureDir, writeTextFile, removePath } from './fsutil.js'
import { dbFile, normDir } from './paths.js'
import { log } from './log.js'

/** 表名常量（只在这里出现，不接受外部拼装） */
export const TABLES = ['album', 'artist', 'track', 'track_artist', 'playlist', 'playlist_track']

/** 建表 DDL。`user_version` 记 schema 版本，迁移时据此判断要不要重建 */
const DDL = [
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

/** SQL 字面量：单引号包裹，内部 ' 翻倍（SQLite 标准转义，不做 shell 层转义） */
export function q(v) {
  if (v === undefined || v === null) return 'NULL'
  return "'" + String(v).replace(/'/g, "''") + "'"
}

/** 数字字面量：非有限数一律 0（避免把 NaN/undefined 写成 SQL 语法错误） */
export function num(v) {
  const n = Number(v)
  return isFinite(n) ? String(n) : '0'
}

/* ---------------- 通道 ---------------- */

let ready = null // Promise<boolean>：sqlite3 可用 + 库已建好
let mem = null // { album:{id:row}, artist, track, track_artist:[], playlist, playlist_track:[] }
let loading = null
let writeChain = Promise.resolve() // 所有写串行，且合并成批

/**
 * sqlite3 CLI 是否可用**且支持 `-json`**。
 *
 * 整表导出靠 `-json`（sqlite3 3.33 起的选项）。设备实测 3.39.2 有它；
 * 更老的 CLI 没有这个选项，导出会失败 —— 此时宁可显式降级为空库也不要做
 * 「读不到就当成空表、然后把空表写回去」这种会**清空用户索引**的事。
 */
let jsonOk = null

async function cliOk() {
  if (jsonOk !== null) return jsonOk
  jsonOk = false
  if (!(await has('sqlite3'))) {
    log('db', '没有 sqlite3 可执行文件')
    return false
  }
  const out = await sql('SELECT 1 AS a;', 8000, true)
  jsonOk = out !== null
  log('db', 'sqlite3 可用=' + jsonOk + (jsonOk ? '' : '（不支持 -json，索引降级为空库）'))
  return jsonOk
}

/**
 * 单条 sqlite3 命令（.db 不存在时 sqlite3 会自己建）。
 *
 * ⚠ 两个坑，都靠「把 SQL 写到临时文件再 .read」绕开：
 *
 *   1) 选项与 SQL 必须是**分开的 argv**。写成 `"-json SELECT ..."` 会被 getopt 当成
 *      一个以 `-` 开头的选项名，报 `unknown option` —— 表现是「探针失败 → 整个索引库
 *      静默降级为空」，日志还像 CLI 版本太老。
 *   2) SQL 不能走**命令行参数**：非 ASCII 会经过一次本机代码页转换（Windows 实测
 *      `insert ... '测试中文'` 落库变成 GBK 字节），写进去就是乱码。歌名/歌手名全是中文，
 *      所以这条是硬伤。写到 UTF-8 文件再 `.read` 就完全没有转码环节 ——
 *      每条语句路径也不再受 Linux 单参数 128KB 上限约束（长索引一次能写完）。
 *
 * @param sqlText  SQL 文本
 * @param timeoutMs 命令超时
 * @param wantJson  true = 结果按 JSON 数组输出（整表导出用）
 */
let sqlSeq = 0

async function sql(sqlText, timeoutMs, wantJson) {
  const file = normDir() + '/.idx-' + Date.now().toString(36) + '-' + (++sqlSeq) + '.sql'
  const ok = await writeTextFile(file, sqlText)
  if (!ok) {
    log('db', '写 SQL 临时文件失败（跳过一次读写）')
    return null
  }
  // `-cmd ".timeout 8000"` 避免并发写时直接 SQLITE_BUSY 失败
  const full = 'sqlite3 -cmd ".timeout 8000" ' + (wantJson ? '-json ' : '') +
    shq(normDir() + '/local_index.db') + ' ".read ' + file + '"'
  let r = null
  try {
    r = await run(full, timeoutMs || 15000, 4 * 1024 * 1024)
  } catch (e) {
    r = null
  }
  // 临时文件一定要清：它是 data 目录里的垃圾，重启也不会自己消失
  await removePath(file)
  if (!r || r.code !== 0) {
    log('db', 'sqlite 失败 rc=' + (r && r.code) + ' err=' + String((r && r.stderr) || '').slice(0, 120))
    return null
  }
  return String((r && r.stdout) || '')
}

/** shell 单引号转义（**只用于给 shell 传参**，SQL 内的值另走 q()） */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** 建库建表（幂等）；返回通道是否可用 */
export function ensureDb() {
  if (ready) return ready
  ready = (async function () {
    if (!(await cliOk())) {
      log('db', 'sqlite3 不可用，本地索引降级为空库')
      return false
    }
    await ensureDir(normDir())
    const out = await sql(DDL, 20000)
    if (out === null) {
      log('db', '建表失败，本地索引降级为空库')
      return false
    }
    log('db', '索引库就绪 ' + dbFile().replace(normDir() + '/', ''))
    return true
  })()
  return ready
}

/* ---------------- 导出到内存 ---------------- */

/** 导出单表为数组（`-json` 输出；空表可能给空串 → 当 []） */
async function dumpTable(name) {
  const out = await sql('SELECT * FROM ' + name + ';', 20000, true)
  if (!out || !out.trim()) return []
  const i = out.indexOf('[')
  if (i < 0) return []
  try {
    const arr = JSON.parse(out.slice(i))
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    log('db', '表解析失败 ' + name + ' len=' + out.length)
    return []
  }
}

/** 导出全部表到内存（open 时一次；此后查询不再分叉） */
export function open() {
  if (mem) return Promise.resolve(mem)
  if (loading) return loading
  loading = (async function () {
    await ensureDb()
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
  ready = null
}

/* ---------------- 写（串行 + 批量） ---------------- */

let pending = [] // 待写 SQL 语句（同一批 BEGIN/COMMIT）

/** 把一批语句入队并尽快写出；返回本次落盘完成的 Promise（失败不抛，只记日志） */
function flush() {
  const batch = pending
  pending = []
  if (!batch.length) return writeChain
  writeChain = writeChain.then(async function () {
    const okChan = await ensureDb()
    if (!okChan) return false
    const body = 'BEGIN;\n' + batch.join('\n') + '\nCOMMIT;'
    const out = await sql(body, 20000)
    return out !== null
  })
  return writeChain
}

/**
 * 执行若干条 SQL（调用方拼好、**值都过 q()/num()**）。
 * 与同一事件循环内的其它 insert 合并成一批：一次 fork 写多条。
 *
 * ⚠ **本函数只落盘，不改内存态。** 内存是读的真相，由各调用方在写 SQL 的同一步里
 * 自己更新（例如 localmeta.putIndex 写完既 mem[k]=rec 又 db.exec([...])）。
 * 这里若顺手改内存，就需要再解析一遍 SQL —— 既脆又慢，还不如让调用方显式写两处。
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

/** 替代整表重写：先删该 id 的旧行再插入（多对多表用） */
export function replaceSql(table, whereSql, cols, pk) {
  return 'DELETE FROM ' + table + ' WHERE ' + whereSql + ';\n' + upsertSql(table, cols, pk)
}

/** 简单删除语句 */
export function deleteSql(table, whereSql) {
  return 'DELETE FROM ' + table + ' WHERE ' + whereSql + ';'
}

/**
 * 等待所有在飞的写落盘（boot/退出/迁移收尾用）。
 * 不抛：失败已由 flush 记过日志。
 */
export function flushAll() {
  return flush().then(function () {
    return writeChain
  })
}
