import fs from 'node:fs'
import path from 'node:path'

export function makeAssertions() {
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
  return { ok, bad, eq, truthy, pass: () => pass, fail: () => fail }
}

// 去掉注释再做静态扫描：注释里出现的 player.on(...) / onDl(...) 只是文档示例，
// 算进调用条数会让断言误报。不追求完整 JS 词法，只处理块注释、行注释、字符串字面量三类。
export function stripComments(src) {
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

export function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(vue|js)$/.test(name)) out.push(p)
  }
  return out
}

export function makeFileAccess(SRC) {
  const allFiles = walk(SRC, [])
  const rel = (p) => path.relative(SRC, p).replace(/\\/g, '/')
  const read = (p) => fs.readFileSync(p, 'utf8')
  return { allFiles, rel, read }
}
