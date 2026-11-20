/**
 * 封面取色 + 「柔光渐变」样式
 *
 * 主页「正在播放」卡要一层**静态柔光渐变**，颜色随封面走。麻烦在于平台没有 Canvas、
 * 没有图像 API、`<image>` 也不能染色 —— 想在运行时从封面拿一个颜色，只能自己解一张图。
 * 设备上有 `/usr/bin/ffmpeg`（精简构建，但 mjpeg/png 解码、`scale`、`rawvideo` muxer 都在），
 * 于是走 `process.exec`：
 *
 *   ffmpeg -y -v error -i <cover.jpg> -vf scale=3:3:flags=area -f rawvideo -pix_fmt rgb24 /tmp/x.bin
 *   od -An -tu1 -v /tmp/x.bin        →  " 202 65 22 211 78 …"（27 个十进制数）
 *
 * 拿 9 个「面积平均」像素，再在 JS 里选色（见 pick）。
 * **为什么中间夹一层 `od`**：`process.exec` 的 stdout 是字符串，二进制（哪怕只有 3 字节）
 * 会被 UTF-8 解码搞坏；打印成十进制文本就完全绕开了这件事，代价只是一次 fork。
 *
 * 实测（封面 60~200px）：ffmpeg 那步 40~70ms，整条命令 <150ms。
 * 只在切歌时跑一次，结果按封面路径在内存里缓存。
 *
 * 降级：exec / ffmpeg 任一不可用 → 返回 null，调用方回落到主题色（不会报错、不会阻塞 UI）。
 */
import { log } from './log.js'
import { has, run as shRun } from './exec.js'

/** 临时文件（/tmp 是 tmpfs，别写真名一次也不回收） */
const TMP = '/tmp/bpncm_cc'
const EXEC_TIMEOUT = 8000
const MAX_BUF = 65536

let execBroken = false
let seq = 0

/** 'file:///a/b.jpg' / '/a/b.jpg' → '/a/b.jpg'（image 组件要 file://，ffmpeg 不认） */
function barePath(p) {
  const s = String(p || '')
  return s.indexOf('file://') === 0 ? s.slice(7) : s
}

/* ------------------------------------------------------------------ *
 * 选色
 * ------------------------------------------------------------------ */

/** 饱和度 / 亮度 */
function satOf(p) {
  const mx = Math.max(p[0], p[1], p[2])
  const mn = Math.min(p[0], p[1], p[2])
  return mx ? (mx - mn) / mx : 0
}

function lumOf(p) {
  return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
}

function rgbToHsl(r, g, b) {
  r /= 255
  g /= 255
  b /= 255
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  let h
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (mx === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

function hslToRgb(h, s, l) {
  if (!s) {
    const v = l * 255
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255]
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function hex2(rgb) {
  function h(v) {
    const s = Math.round(clamp(v, 0, 255)).toString(16)
    return s.length < 2 ? '0' + s : s
  }
  return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2])
}

/** '#rrggbb' → [r,g,b]；解析不了给 null */
export function parseHex(hex) {
  const s = String(hex || '').trim()
  if (s.length !== 7 || s.charAt(0) !== '#') return null
  const n = parseInt(s.slice(1), 16)
  if (isNaN(n)) return null
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * 9 个采样点 → 一个「能在深底上当光用」的颜色。
 *
 * 不能直接取平均：平均会把鲜艳封面拉成灰褐色。
 * 采「最鲜艳点的**色相**」+「9 点平均的**明度**」，再把 S/L 夹到
 * 一个固定区间 —— 这样无论封面是艳是灰、是亮是暗，出来的都
 * 是同一档「能看见的光」，卡片外观不会被封面亮度牵着走。
 */
export function pick(px) {
  let vivid = px[0]
  let best = -1
  let ar = 0
  let ag = 0
  let ab = 0
  for (let i = 0; i < px.length; i++) {
    const p = px[i]
    const score = satOf(p) * Math.sqrt(Math.max(lumOf(p), 0))
    if (score > best) {
      best = score
      vivid = p
    }
    ar += p[0]
    ag += p[1]
    ab += p[2]
  }
  const n = px.length
  const h = rgbToHsl(vivid[0], vivid[1], vivid[2])[0]
  const lAvg = rgbToHsl(ar / n, ag / n, ab / n)[2]
  // 夹取区间 = 「柔光」的可视档位：亮度太低在 #1a1b1f 上看不见，太高会糊掉文字
  // （0.44/0.80 与取色演示脚本一致，改了这边要同步那边）
  const s = clamp(satOf(vivid), 0.34, 0.80)
  const l = clamp(lAvg, 0.44, 0.60)
  return hex2(hslToRgb(h, s, l))
}

/** 「同色系」的色相门槛：36°。低于它就不算第二个颜色（见 pickPair 的注释） */
const HUE_GAP = 0.10

/**
 * 9 个采样点 → [主色, 次色或 null]。
 *
 * 次色 = 色相离主色最远的那个采样点。卡面因此能看见「颜色在变」（红 → 紫），
 * 而不只是同一色的浓淡。
 *
 * ⚠ 门槛要开到 36°：开小了（20°）时，单色系封面会凑出「主色偏一点」的琥珀色当次色，
 *   卡面直接发黄发脏（暖棕封面的效果图实测）。封面本来就是单色系 → 给 null，
 *   调用方回落到单色渐变 —— 宁可朴实，不要脏。
 */
export function pickPair(px) {
  const c1 = pick(px)
  const c = parseHex(c1) || [229, 66, 60]
  const h1 = rgbToHsl(c[0], c[1], c[2])[0]
  let far = null
  let farD = 0
  for (let i = 0; i < px.length; i++) {
    const p = px[i]
    const h = rgbToHsl(p[0], p[1], p[2])[0]
    let d = Math.abs(h - h1)
    if (d > 0.5) d = 1 - d
    if (d > farD) {
      farD = d
      far = p
    }
  }
  if (!far || farD < HUE_GAP) return [c1, null]
  const hsl = rgbToHsl(far[0], far[1], far[2])
  const s = clamp(satOf(far), 0.34, 0.80)
  const l = clamp(hsl[2], 0.44, 0.60)
  return [c1, hex2(hslToRgb(hsl[0], s, l))]
}

/* ------------------------------------------------------------------ *
 * 取色执行
 * ------------------------------------------------------------------ */

const mem = {} // 封面路径 → [主色, 次色或 null]
const inflight = {} // 封面路径 → [cb, ...]

function parseOd(text) {
  const nums = String(text || '').split(/[^0-9]+/)
  const out = []
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== '') out.push(parseInt(nums[i], 10))
  }
  if (out.length < 27) return null
  const px = []
  for (let i = 0; i < 27; i += 3) px.push([out[i], out[i + 1], out[i + 2]])
  return px
}

/** unusable=true 表示「这条通道本身不能用」（process/ffmpeg 缺失），而不是单张图解码失败 */
function fail(msg, unusable) {
  const e = new Error(msg)
  e.unusable = !!unusable
  return e
}

async function run(path) {
  // 命令通道走 utils/exec.js（exec 可用性 + ffmpeg 能力都在那边探一次、缓存）
  if (!(await has('ffmpeg'))) throw fail('ffmpeg 不可用（或 process.exec 缺失）', true)
  seq++
  const tmp = TMP + '_' + seq + '.bin'
  const cmd =
    '/usr/bin/ffmpeg -y -v error -i \'' + path + '\'' +
    ' -vf scale=3:3:flags=area -f rawvideo -pix_fmt rgb24 ' + tmp +
    ' && od -An -tu1 -v ' + tmp + '; rm -f ' + tmp
  const r = await shRun(cmd, EXEC_TIMEOUT, MAX_BUF)
  const err = String((r && r.stderr) || '').slice(0, 120)
  if (!r || r.code !== 0) {
    // 127 = 找不到可执行文件 → 通道废了；其它（封面文件坏了等）只当这一张失败
    throw fail('rc=' + ((r && r.code) || '?') + ' ' + err, !r || r.code === 127)
  }
  const px = parseOd(r.stdout)
  if (!px) throw fail('od 输出异常: ' + String(r.stdout || '').slice(0, 80), false)
  return pickPair(px)
}

/**
 * 取封面的**主色 + 次色** → ['#rrggbb', '#rrggbb' 或 null]（失败/不可用给 null）。
 * path 可以是 `file://…` 或裸路径；同一路径只算一次（内存缓存）。
 * 次色为 null = 这张封面是单色系，调用方应当用单色渐变（见 pickPair）。
 */
export function coverPair(path) {
  const p = barePath(path)
  if (!p) return Promise.resolve(null)
  if (mem[p]) return Promise.resolve(mem[p])
  if (execBroken) return Promise.resolve(null)
  const wait = inflight[p]
  if (wait) {
    return new Promise(function (res) {
      wait.push(res)
    })
  }
  inflight[p] = []
  return new Promise(function (res) {
    run(p).then(function (pair) {
      if (pair) mem[p] = pair
      finish(p, pair)
      res(pair)
    }, function (e) {
      if (e && e.unusable) execBroken = true
      log('covercolor', '取色失败 ' + ((e && e.message) || e))
      finish(p, null)
      res(null)
    })
  })
}

/** 只要主色（不需要双色渐变时用这个）→ '#rrggbb' 或 null */
export function coverColor(path) {
  return coverPair(path).then(function (pair) {
    return pair ? pair[0] : null
  })
}

function finish(p, hex) {
  const wait = inflight[p] || []
  delete inflight[p]
  for (let i = 0; i < wait.length; i++) {
    try {
      wait[i](hex)
    } catch (e) {}
  }
}

/** 清内存缓存（调试/存储页用） */
export function clearColorCache() {
  const ks = Object.keys(mem)
  for (let i = 0; i < ks.length; i++) delete mem[ks[i]]
  execBroken = false
}

/* ------------------------------------------------------------------ *
 * 柔光渐变
 * ------------------------------------------------------------------ */

/**
 * 渐变的「形状」是写死的（静态）：**左上角 → 右下角**的对角柔光，4 个色标。
 *
 * 为什么是斜的：正向渐变（上边缘 → 下边缘）在卡面上的表现是「一条上下均匀、
 * 左右没变化的带子」，很平。卡面左边 37% 被不透明封面压着、上下只剩两条 14px 窄边，
 * 能看见的其实只有右侧文字列那一竖条。斜过来以后，右半边自己就有左上亮、右下暗的落差，
 * 方向感出来了。
 *
 * 峰值 α .70 是量出来的档位：斜向的可见区从 ~26% 才开始（0% 落在左上角、被封面挡着），
 * 峰值低了右边整片看不见光；再高（.80+）开始糊文字。
 * 尾巴留到 .04（不写 0）：右下角留一丝底色，不会跟卡片描边撞出硬边。
 *
 * 双色：给了 hex2 就在 c1 → c2 之间按色标位置插值（红 → 紫这种），
 * 封面是单色系时 hex2 为 null，整条渐变用主色。
 */
const GLOW_DEG = 135
const GLOW_STOPS = [
  [0, 0.70],
  [30, 0.48],
  [64, 0.22],
  [100, 0.04]
]

/**
 * 颜色 → 'linear-gradient(...)' 字符串（给内联 :style 用）。
 * hex 传空/解析不了 → 回落默认红（@accent）；hex2 传空 → 单色渐变。
 */
export function glowGradient(hex, hex2) {
  const c1 = parseHex(hex) || [229, 66, 60]
  const c2 = parseHex(hex2)
  const parts = []
  for (let i = 0; i < GLOW_STOPS.length; i++) {
    const pos = GLOW_STOPS[i][0]
    const a = GLOW_STOPS[i][1]
    const t = pos / 100
    const r = Math.round(c2 ? c1[0] + (c2[0] - c1[0]) * t : c1[0])
    const g = Math.round(c2 ? c1[1] + (c2[1] - c1[1]) * t : c1[1])
    const b = Math.round(c2 ? c1[2] + (c2[2] - c1[2]) * t : c1[2])
    parts.push('rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ') ' + pos + '%')
  }
  return 'linear-gradient(' + GLOW_DEG + 'deg, ' + parts.join(', ') + ')'
}
