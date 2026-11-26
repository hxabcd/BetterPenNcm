

// 主题（背景色 + 主题色）：都是**运行时**换肤，配置里存 preset key，组件用内联 style 上色。
// 不用 LESS 变量是因为 @accent/@accent-2 是编译期的、运行时换不了色（平台只支持单类名选择器，
// 动态状态色本来就得走内联样式）。styles/common.less 里那两个只是「默认预设」的书面值，别拿它上色。
// 改色后必须广播：页面是 navTo/finish 进出、**不会重新挂载**，不通知的话已经挂着的页会停在旧色。
import config from '../core/infra/config.js'

export const PRESETS = [
  { key: 'gray', name: '深灰', bg: '#0f0f11' },
  { key: 'black', name: '纯黑', bg: '#000000' },
  { key: 'blue', name: '深蓝', bg: '#0b1420' },
  { key: 'purple', name: '暗紫', bg: '#150f1c' }
]

export const DEFAULT_BG = PRESETS[0].bg

// 主题色预设（Vocaloid 七色）。c = 主色（实心按钮底 / 进度填充 / 选中圈底），
// light = 暗底上的选中态文字与图标；on / dark 不在这里写，由下面的 pickOn() 按对比度算。
// ⚠ 与 scripts/gen_icons.py 的 ACCENTS 表**成对维护**（key 与 c 两列必须一致）：
//   key 对不上会取不到着色图标（aIcon 回落），色值对不上则界面与图标不同色。
// ⚠ key 是**色名**不是角色名：config 的 accentColor 存的就是它，改 key 等于让用户已存的偏好失效（回落默认）。
export const ACCENTS = [
  { key: 'red', name: '重音红', c: '#D93A49', light: '#F58A93' },
  { key: 'yellow', name: '镜音黄', c: '#FFE211', light: '#FFEE70' },
  { key: 'green', name: 'GUMI绿', c: '#9DE190', light: '#BEEDB4' },
  { key: 'teal', name: '初音青', c: '#39C5BB', light: '#77DCD4' },
  { key: 'blue', name: '天依蓝', c: '#66CCFF', light: '#9FDFFF' },
  { key: 'purple', name: '星尘紫', c: '#9999FF', light: '#BFBFFF' },
  { key: 'pink', name: '巡音粉', c: '#FAAFBE', light: '#FFD0D9' }
]

export const FG_LIGHT = '#ffffff'
export const FG_DARK = '#14151a'

// sRGB → 相对亮度（WCAG 公式）
function relLum(hex) {
  const v = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    v[i] = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
}

// 实心主题色上该用白前景还是深前景：取对比度高的那个（不设亮度阈值，免得换色时又要调参）。
// 为什么必须有：本套 7 个预设里 6 个是亮色，白图标压上去几乎看不见（对比度 ~1.5:1），
// 而主控键 / 勾选圈 / 左栏危险态用的都是**纯白 PNG**、平台又不能给 <image> 染色 ——
// 亮色预设必须换同一形状的深色版 PNG（gen_icons.py 的 DARK_ICONS，运行时走 icons.js 的 fgIcon()）。
function pickOn(hex) {
  const l = relLum(hex)
  const vsWhite = 1.05 / (l + 0.05)
  const vsDark = (l + 0.05) / (relLum(FG_DARK) + 0.05)
  return vsWhite >= vsDark ? FG_LIGHT : FG_DARK
}

for (let i = 0; i < ACCENTS.length; i++) {
  const a = ACCENTS[i]
  a.on = pickOn(a.c)
  a.dark = a.on !== FG_LIGHT 
}

export const DEFAULT_ACCENT = ACCENTS[0]

export const THEME_EVENT = 'bpncm:theme'

function findBg(key) {
  for (let i = 0; i < PRESETS.length; i++) {
    if (PRESETS[i].key === key) return PRESETS[i]
  }
  return null
}

function findAccent(key) {
  for (let i = 0; i < ACCENTS.length; i++) {
    if (ACCENTS[i].key === key) return ACCENTS[i]
  }
  return null
}

function rgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')'
}

// 预设 → 运行时可用的 accent 对象。半透明叠色（a12…a20）**预先算成字符串**：
// 平台响应式只认朴素值，data 里不能放函数。
function makeAccent(p) {
  return {
    key: p.key,
    name: p.name,
    c: p.c,
    light: p.light,
    on: p.on,      
    dark: p.dark,  
    a12: rgba(p.c, 0.12),
    a14: rgba(p.c, 0.14),
    a16: rgba(p.c, 0.16),
    a18: rgba(p.c, 0.18),
    a20: rgba(p.c, 0.2)
  }
}

export function currentBg() {
  const p = findBg(config.get('bgColor'))
  return p ? p.bg : DEFAULT_BG
}

export function currentKey() {
  const p = findBg(config.get('bgColor'))
  return p ? p.key : PRESETS[0].key
}

export function currentAccent() {
  return makeAccent(findAccent(config.get('accentColor')) || DEFAULT_ACCENT)
}

export function currentAccentKey() {
  const p = findAccent(config.get('accentColor'))
  return p ? p.key : DEFAULT_ACCENT.key
}

export async function setBg(key) {
  if (!findBg(key)) return
  await config.set('bgColor', key)
  notify()
}

export async function setAccent(key) {
  if (!findAccent(key)) return
  await config.set('accentColor', key)
  notify()
}

// 换色后广播：boot 载入配置后也要调一次，否则启动瞬间会闪一下默认色
export function notify() {
  try {
    /* global $falcon */
    $falcon.trigger(THEME_EVENT)
  } catch (e) {}
}
