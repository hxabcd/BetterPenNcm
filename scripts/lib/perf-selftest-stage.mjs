// 把 src 里的模块搬进 Node 能跑的沙箱：它们是 .js + import 说明符，但都吃 Node 语义（无三方依赖）。
// 麻烦在 fmtDur / log 会牵出平台模块：sig.js 只依赖 format.js（纯函数），vis.js 依赖 log.js（会去 POST）→ 打桩。
import fs from 'node:fs'
import path from 'node:path'

export async function stageSandbox(ROOT, SRC) {
  const sandbox = path.join(ROOT, '.perf_selftest_tmp')
  fs.rmSync(sandbox, { recursive: true, force: true })
  fs.mkdirSync(sandbox, { recursive: true })

  // 沙箱里的模块是 ESM：声明 type=module，免得 Node 先按 CJS 解析再重解析并打警告
  fs.writeFileSync(path.join(sandbox, 'package.json'), '{ "type": "module" }\n')

  function stage(relSrc, relDst /*, patch */) {
    const from = path.join(SRC, relSrc)
    let code = fs.readFileSync(from, 'utf8')
    const out = path.join(sandbox, relDst)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, code)
    return out
  }

  // format.js 原样搬（纯函数）
  stage('core/infra/format.js', 'format.js')

  {
    const code = fs
// sig.js：把 '../format.js' 改成同目录，其余原样
      .readFileSync(path.join(SRC, 'services/player/sig.js'), 'utf8')
      .replace(/from '\.\.\/\.\.\/core\/infra\/format\.js'/g, "from './format.js'")
    fs.writeFileSync(path.join(sandbox, 'sig.js'), code)
  }

  // 可见性实现（并入 ui/mixins/dlsub.js）：log.js 打桩
  fs.writeFileSync(path.join(sandbox, 'log.js'),
    'export function log() {}\n' +
    'export const dlState = () => ({})\n' +
    'export const onDl = () => () => {}\n' +
    'export const offDl = () => {}\n')
  {
    const code = fs
      .readFileSync(path.join(SRC, 'ui/mixins/dlsub.js'), 'utf8')
      .replace(/from '\.\.\/\.\.\/core\/infra\/log\.js'/g, "from './log.js'")
      .replace(/from '..\/services\/player\/download\.js'/g, "from './log.js'")
    fs.writeFileSync(path.join(sandbox, 'dlsub.js'), code)
  }

  const sig = await import('file://' + path.join(sandbox, 'sig.js').replace(/\\/g, '/'))
  const vis = await import('file://' + path.join(sandbox, 'dlsub.js').replace(/\\/g, '/'))

  // infinite.js 无外部依赖，原样搬进沙箱测纯判定函数
  stage('ui/mixins/infinite.js', 'infinite.js')
  const inf = await import('file://' + path.join(sandbox, 'infinite.js').split(path.sep).join('/'))

  const cleanup = () => fs.rmSync(sandbox, { recursive: true, force: true })
  return { sandbox, sig, vis, inf, cleanup }
}
