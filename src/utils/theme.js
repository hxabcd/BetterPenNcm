/**
 * 主题（背景色 + 主题色）
 *
 * 背景色：设置里给几个预设，含「当前」与纯黑。
 * 主题色（accent）：默认红（= 加此功能前写死的网易云红），设置里可换。
 *
 * 为什么不用 LESS 变量：`@bg`/`@accent` 都是编译期的，运行时换不了色。这里改成
 * 「配置里存 preset key → 组件用**内联 style** 上色」——平台只支持单类名选择器，
 * 动态状态色本来就得走内联样式（同 NavRail 的选中态做法）。
 * styles/common.less 里的 @bg/@accent/@accent-2 现在只是「默认预设（深灰 + 红）」的书面值。
 *
 * 改色后必须广播：页面是 navTo/finish 进出、**不会重新挂载**，不通知的话
 * 已经挂着的页（比如首页）会停在旧色。背景色与主题色共用一个事件（一起下发）。
 *
 * 组件用法（PageShell / NavRail / PageTopbar / index / login 都按这个接）：
 *   data:    { bg: currentBg(), accent: currentAccent() }
 *   mounted: this._bgOff = bindTheme(this)
 *   销毁:    unbindTheme(this._bgOff)
 * 只需要主题色的组件（不关心背景色的那些页面）可以直接 `mixins: [accentMixin]`。
 *
 * accent 对象字段：
 *   c     —— 主色（原 @accent）：实心按钮底、进度条填充、选中圈底
 *   light —— 浅色（原 @accent-2）：选中态的文字/图标（暗底上主色偏闷，浅色更醒目）
 *   on    —— **实心主色之上**的前景文字色（白 or 深色，按对比度自动挑，见 pickOn）
 *   dark  —— true = 实心底上要用深色前景 → **图标**必须换深色版（fgIcon，见 assets/icons.js）
 *   a12/a14/a16/a18/a20 —— 主色的半透明叠色（原 @accent-soft 与各处 0.12~0.2 的选中底）
 * 半透明值**预先算好成字符串**（而非暴露 alpha 函数）：避免往 data 里放函数，
 * 平台的响应式实现只认朴素值。
 */
import config from './config.js'
import { fgIcon as pickFgIcon } from '../assets/icons.js'

/** 背景预设：深灰=当前默认；纯黑；另给两个带色调的暗色 */
export const PRESETS = [
  { key: 'gray', name: '深灰', bg: '#0f0f11' },
  { key: 'black', name: '纯黑', bg: '#000000' },
  { key: 'blue', name: '深蓝', bg: '#0b1420' },
  { key: 'purple', name: '暗紫', bg: '#150f1c' }
]

export const DEFAULT_BG = PRESETS[0].bg

/**
 * 主题色预设（Vocaloid 七色）。
 *   c     —— 主色（原 @accent）：实心按钮底、进度条填充、选中圈底
 *   light —— 浅色（原 @accent-2）：暗底上的选中态文字/图标
 *   on / dark —— 不在这里写，由下面的 pickOn() 按对比度自动算（见注释）
 * ⚠ 与 scripts/gen_icons.py 的 ACCENTS 表**成对维护**（key 与 c 两列必须一致）：
 *   那边按同一组 key/色值生成着色图标（pl/dl/hist/liked）的 PNG 变体，
 *   key 对不上会取不到图标、色值对不上则界面与图标不同色。
 * ⚠ key 用**色名**（不是角色名）：`config.accentColor` 里存的就是它，
 *   改 key 等于让用户已存的偏好失效（旧值取不到 → 回落到默认）。
 */
export const ACCENTS = [
  { key: 'red', name: '重音红', c: '#D93A49', light: '#F58A93' },
  { key: 'yellow', name: '镜音黄', c: '#FFE211', light: '#FFEE70' },
  { key: 'green', name: 'GUMI绿', c: '#9DE190', light: '#BEEDB4' },
  { key: 'teal', name: '初音青', c: '#39C5BB', light: '#77DCD4' },
  { key: 'blue', name: '天依蓝', c: '#66CCFF', light: '#9FDFFF' },
  { key: 'purple', name: '星尘紫', c: '#9999FF', light: '#BFBFFF' },
  { key: 'pink', name: '巡音粉', c: '#FAAFBE', light: '#FFD0D9' }
]

/** 实心主题色上的前景色（深浅两选，见 pickOn） */
export const FG_LIGHT = '#ffffff'
export const FG_DARK = '#14151a'

/** sRGB → 相对亮度（WCAG 公式） */
function relLum(hex) {
  const v = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    v[i] = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
}

/**
 * 实心主题色上该用白前景还是深前景 —— **取对比度高的那个**（不设亮度阈值，
 * 免得将来换色时又要调参）。
 * 为什么必须有这个：本套预设里「镜音黄 #FFE211 / GUMI绿 / 初音青 / 天依蓝 / 星尘紫 / 巡音粉」
 * 都是亮色，白图标压上去几乎看不见（对比度 ~1.5:1）。而主控键（播放/暂停）、
 * 勾选圈（check）、左栏危险态（download/trash）用的都是**纯白 PNG 图标**，
 * 平台又不能给 <image> 染色 —— 所以亮色预设必须换成同一形状的**深色版 PNG**
 * （gen_icons.py 的 DARK_ICONS，运行时用 assets/icons.js 的 fgIcon() 取）。
 */
function pickOn(hex) {
  const l = relLum(hex)
  const vsWhite = 1.05 / (l + 0.05)
  const vsDark = (l + 0.05) / (relLum(FG_DARK) + 0.05)
  return vsWhite >= vsDark ? FG_LIGHT : FG_DARK
}

for (let i = 0; i < ACCENTS.length; i++) {
  const a = ACCENTS[i]
  a.on = pickOn(a.c)
  a.dark = a.on !== FG_LIGHT // true = 实心底上要深色前景（图标也得换深色版）
}

export const DEFAULT_ACCENT = ACCENTS[0]

const EVENT = 'bpncm:theme'

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

/** #rrggbb → 'rgba(r, g, b, a)' */
function rgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')'
}

/** 预设 → 运行时可用的 accent 对象（半透明叠色预先算好；on/dark 见 ACCENTS 上的注释） */
function makeAccent(p) {
  return {
    key: p.key,
    name: p.name,
    c: p.c,
    light: p.light,
    on: p.on,      // 实心主题色上的前景色（文字用；图标用 fgIcon 换深色版）
    dark: p.dark,  // true = 实心底上要素色版前景（图标必须换成深色 PNG）
    a12: rgba(p.c, 0.12),
    a14: rgba(p.c, 0.14),
    a16: rgba(p.c, 0.16),
    a18: rgba(p.c, 0.18),
    a20: rgba(p.c, 0.2)
  }
}

/** 当前底色 hex（配置还没 load 时回落到默认） */
export function currentBg() {
  const p = findBg(config.get('bgColor'))
  return p ? p.bg : DEFAULT_BG
}

/** 当前背景预设 key（设置页高亮用） */
export function currentKey() {
  const p = findBg(config.get('bgColor'))
  return p ? p.key : PRESETS[0].key
}

/** 当前主题色对象（配置还没 load 时回落到默认红） */
export function currentAccent() {
  return makeAccent(findAccent(config.get('accentColor')) || DEFAULT_ACCENT)
}

/** 当前主题色 key（设置页高亮 / 取着色图标用） */
export function currentAccentKey() {
  const p = findAccent(config.get('accentColor'))
  return p ? p.key : DEFAULT_ACCENT.key
}

/** 换底色：写配置 + 广播给所有 chrome 组件 */
export async function setBg(key) {
  if (!findBg(key)) return
  await config.set('bgColor', key)
  notify()
}

/** 换主题色：写配置 + 广播（背景色与主题色同一个事件） */
export async function setAccent(key) {
  if (!findAccent(key)) return
  await config.set('accentColor', key)
  notify()
}

/** 广播主题变化（boot 载入配置后也要调一次，否则启动瞬间会闪一下默认色） */
export function notify() {
  try {
    /* global $falcon */
    $falcon.trigger(EVENT)
  } catch (e) {}
}

/** 组件挂载时调用：订阅 + 立即取当前色（bg 与 accent 一起下发）。返回的 handler 交给 unbindTheme */
export function bindTheme(vm) {
  const apply = function () {
    vm.bg = currentBg()
    vm.accent = currentAccent()
  }
  try {
    /* global $falcon */
    $falcon.on(EVENT, apply)
  } catch (e) {}
  apply()
  return apply
}

export function unbindTheme(apply) {
  if (!apply) return
  try {
    /* global $falcon */
    $falcon.off(EVENT, apply)
  } catch (e) {}
}

/**
 * 主题混入（bg + accent + fgIcon）—— 页面/组件不必自己写 data + mounted + beforeDestroy 三处。
 *
 * chrome 组件（PageShell/NavRail/PageTopbar/index/login）也混本 mixin；
 * 唯一规矩：**一个实例只绑一次**（混了本 mixin 就别再自己 bindTheme）。
 */
export const accentMixin = {
  data() {
    return { accent: currentAccent() }
  },
  mounted() {
    this._accentOff = bindTheme(this)
  },
  beforeDestroy() {
    unbindTheme(this._accentOff)
  },
  methods: {
    /**
     * 模板里取「实心主题色上的图标」：fgIcon('play')。
     * 亮色预设（黄/绿/青/蓝/紫/粉）自动换深色版 PNG —— 白图标压在亮底上看不见。
     */
    fgIcon(key) {
      return pickFgIcon(key, this.accent)
    }
  }
}
