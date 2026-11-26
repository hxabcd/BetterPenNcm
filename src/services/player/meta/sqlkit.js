/**
 * SQL 批量写管道 —— 索引库批量写入（locallists / localmeta 共用）
 *
 * 装箱分批的原因：已无 argv 上限，但语句仍拼成一整串交给 db.exec()——一批太大时出错更难定位，
 * 且单批变小能让写落在多个事务里，主线程不至于长时间不返回。
 */


import { exec as dbExec, num } from '../../../core/platform/db.js'

// 一批 SQL 的体积预算（字节）
export const SQL_BATCH_BYTES = 6000

// 一条语句的近似体积（只用于分箱，不要求精确）
export function escapedLen(sql) {
  return sql.length + 2
}

// 顺序提交一批 SQL，按字节装箱；单条超限时自己成批，不连带整批
export async function runStmts(stmts) {
  let batch = []
  let bytes = 0
  for (let i = 0; i < stmts.length; i++) {
    const b = escapedLen(stmts[i])
    if (batch.length && bytes + b > SQL_BATCH_BYTES) {
      await dbExec(batch)
      batch = []
      bytes = 0
    }
    batch.push(stmts[i])
    bytes += b
  }
  if (batch.length) await dbExec(batch)
}

// 多对多关系的整组替换：INSERT OR REPLACE 多行 VALUES
// 一行 ~20B（逐条 upsert 要 ~90B，因为每条都重复列名与 ON CONFLICT 子句），大歌单/大库下这决定了要分几箱
export function replaceRowsSql(table, cols, rows) {
  if (!rows.length) return []
  const head = 'INSERT OR REPLACE INTO ' + table + ' (' + cols.join(',') + ') VALUES '
  const out = []
  let tuples = []
  let bytes = escapedLen(head) + 8 
  for (let i = 0; i < rows.length; i++) {
    const vals = []
    for (let k = 0; k < rows[i].length; k++) {
      const v = rows[i][k]
      vals.push(typeof v === 'number' ? num(v) : qv(v))
    }
    const t = '(' + vals.join(',') + ')'
    const cost = t.length + 1
    if (tuples.length && bytes + cost > SQL_BATCH_BYTES) {
      out.push(head + tuples.join(',') + ';')
      tuples = []
      bytes = escapedLen(head) + 8
    }
    tuples.push(t)
    bytes += cost
  }
  if (tuples.length) out.push(head + tuples.join(',') + ';')
  return out
}

// SQL 字符串字面量（与 db.js 的 q 同语义：单引号包裹、内部 ' 翻倍）
export function qv(v) {
  if (v === undefined || v === null) return 'NULL'
  return "'" + String(v).replace(/'/g, "''") + "'"
}

// 把一个大文本列写进某一行的 SQL 片段：先清空再分片 `col = col || '<片段>'`
// 分片的原因：base_ids / remote_ids 是 JSON 数组文本，跟歌单曲目数成正比（10000 首 ≈ 70KB）；
// 整串拼进单条语句会让「单句出错」的影响面很大，且 SQLite 对单条语句长度有上限，拆片后与歌单大小无关
export function appendTextColSql(table, idCol, id, col, text) {
  const s = text === undefined || text === null ? '' : String(text)
  const out = ['UPDATE ' + table + ' SET ' + col + " = '' WHERE " + idCol + ' = ' + num(id) + ';']
  const CHUNK = 2000
  let i = 0
  while (i < s.length) {
    let end = Math.min(i + CHUNK, s.length)

    // 别把代理对劈开
    const code = s.charCodeAt(end - 1)
    if (end < s.length && code >= 0xd800 && code <= 0xdbff) end -= 1
    out.push('UPDATE ' + table + ' SET ' + col + ' = ' + col + ' || ' + qv(s.slice(i, end)) +
      ' WHERE ' + idCol + ' = ' + num(id) + ';')
    i = end
  }
  return out
}
