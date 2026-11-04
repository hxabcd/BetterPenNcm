// 未使用 import 检查：按「导入名在文件里出现次数」判，去掉 import 行本身再数
import fs from 'node:fs'

const files = process.argv.slice(2)
let bad = 0
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const importBlocks = []
  const re = /import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g
  let m
  while ((m = re.exec(src)) !== null) importBlocks.push(m[0])
  // 用与源文件等长的空白替换掉 import 语句，避免把导入名本身算进使用次数
  let body = src
  for (const b of importBlocks) body = body.split(b).join(' '.repeat(b.length))

  const names = []
  for (const block of importBlocks) {
    const braces = /\{([\s\S]*?)\}/.exec(block)
    if (braces) {
      for (const part of braces[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop().trim()
        if (n) names.push(n)
      }
    }
    const def = /^import\s+([A-Za-z_$][\w$]*)\s*(,|from)/.exec(block)
    if (def) names.push(def[1])
    const star = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(block)
    if (star) names.push(star[1])
  }
  const unused = names.filter(function (n) {
    return !(new RegExp('(^|[^\\w$.])' + n.replace(/\$/g, '\\$') + '([^\\w$]|$)').test(body))
  })
  if (unused.length) {
    bad++
    console.log('✗ ' + f + ' — 未使用：' + unused.join(', '))
  } else {
    console.log('✓ ' + f)
  }
}
console.log(bad ? '\n有 ' + bad + ' 个文件存在未使用导入' : '\n全部文件导入均被使用')
process.exit(bad ? 1 : 0)
