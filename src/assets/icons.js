/**
 * 界面图标表 —— **本文件由 scripts/gen_icons.py 生成（--emit-js），别手改**。
 *
 * 改图标 / 加主题色 / 改深色清单：全部去脚本的表里改，然后
 *   python scripts/gen_icons.py                      # 重生成 PNG（缺的 vendor SVG 自动拉）
 *   python scripts/gen_icons.py --emit-js            # 重写本文件
 *   python scripts/gen_icons.py --no-fetch --check   # 逐字节校验 + PNG 自检
 *
 * 图标取自 Lucide 1.52.0（ISC License，© Lucide Icons and Contributors，
 * https://lucide.dev）。SVG 原件 vendored 在 scripts/lucide-svg/，
 * PNG 由 gen_icons.py 生成（ImageMagick/librsvg → 72px RGBA）——
 * **颜色必须生成进 PNG**：平台不能给 <image> 染色（没有 tint/mask/filter）。
 *
 * 这里用 `?base64` 后缀 import：aiot-vue-cli 的图片插件（rollup-plugins/image.js
 * 的 REG_BASE64）会把它内联成 data URI 直接喂给 <image>。为什么不用 SVG / 字体字形：
 * 见 gen_icons.py 文件头（两条都没有证据 / 不稳）。
 *
 * 三张表：
 *   ICON        全部图标的默认版（白版 / 着色版 / 主题色第一色）
 *   ACCENT_ICON 跟主题色变的图标（脚本 ACCENT_ICONS），中间层 key = 主题色 key
 *   FG_ICON     会落在实心主题色上的图标（脚本 DARK_ICONS）的深色版
 */
import arrowleft from './icon-arrowleft.png?base64'
import back from './icon-back.png?base64'
import cancel from './icon-cancel.png?base64'
import cat from './icon-cat.png?base64'
import check from './icon-check.png?base64'
import checkDark from './icon-check-dark.png?base64'
import chevdown from './icon-chevdown.png?base64'
import chevleft from './icon-chevleft.png?base64'
import chevright from './icon-chevright.png?base64'
import clockfade from './icon-clockfade.png?base64'
import dbminus from './icon-dbminus.png?base64'
import dbplus from './icon-dbplus.png?base64'
import del from './icon-del.png?base64'
import disc3 from './icon-disc3.png?base64'
import dl from './icon-dl-red.png?base64'
import dlYellow from './icon-dl-yellow.png?base64'
import dlGreen from './icon-dl-green.png?base64'
import dlTeal from './icon-dl-teal.png?base64'
import dlBlue from './icon-dl-blue.png?base64'
import dlPurple from './icon-dl-purple.png?base64'
import dlPink from './icon-dl-pink.png?base64'
import dlal from './icon-dlal-red.png?base64'
import dlalYellow from './icon-dlal-yellow.png?base64'
import dlalGreen from './icon-dlal-green.png?base64'
import dlalTeal from './icon-dlal-teal.png?base64'
import dlalBlue from './icon-dlal-blue.png?base64'
import dlalPurple from './icon-dlal-purple.png?base64'
import dlalPink from './icon-dlal-pink.png?base64'
import dlar from './icon-dlar-red.png?base64'
import dlarYellow from './icon-dlar-yellow.png?base64'
import dlarGreen from './icon-dlar-green.png?base64'
import dlarTeal from './icon-dlar-teal.png?base64'
import dlarBlue from './icon-dlar-blue.png?base64'
import dlarPurple from './icon-dlar-purple.png?base64'
import dlarPink from './icon-dlar-pink.png?base64'
import dlpl from './icon-dlpl-red.png?base64'
import dlplYellow from './icon-dlpl-yellow.png?base64'
import dlplGreen from './icon-dlpl-green.png?base64'
import dlplTeal from './icon-dlpl-teal.png?base64'
import dlplBlue from './icon-dlpl-blue.png?base64'
import dlplPurple from './icon-dlpl-purple.png?base64'
import dlplPink from './icon-dlpl-pink.png?base64'
import download from './icon-download.png?base64'
import downloadDark from './icon-download-dark.png?base64'
import edit from './icon-edit.png?base64'
import fail from './icon-fail.png?base64'
import follow from './icon-follow.png?base64'
import followed from './icon-followed.png?base64'
import harddrive from './icon-harddrive.png?base64'
import help from './icon-help.png?base64'
import hist from './icon-hist-red.png?base64'
import histYellow from './icon-hist-yellow.png?base64'
import histGreen from './icon-hist-green.png?base64'
import histTeal from './icon-hist-teal.png?base64'
import histBlue from './icon-hist-blue.png?base64'
import histPurple from './icon-hist-purple.png?base64'
import histPink from './icon-hist-pink.png?base64'
import info from './icon-info.png?base64'
import like from './icon-like.png?base64'
import liked from './icon-liked-red.png?base64'
import likedYellow from './icon-liked-yellow.png?base64'
import likedGreen from './icon-liked-green.png?base64'
import likedTeal from './icon-liked-teal.png?base64'
import likedBlue from './icon-liked-blue.png?base64'
import likedPurple from './icon-liked-purple.png?base64'
import likedPink from './icon-liked-pink.png?base64'
import listplus from './icon-listplus.png?base64'
import loop from './icon-loop.png?base64'
import loop1 from './icon-loop1.png?base64'
import messagesq from './icon-messagesq.png?base64'
import micvocal from './icon-micvocal.png?base64'
import more from './icon-more.png?base64'
import multi from './icon-multi.png?base64'
import music from './icon-music.png?base64'
import next from './icon-next.png?base64'
import note from './icon-note.png?base64'
import ok from './icon-ok.png?base64'
import options from './icon-options.png?base64'
import order from './icon-order.png?base64'
import palette from './icon-palette.png?base64'
import pause from './icon-pause.png?base64'
import pauseDark from './icon-pause-dark.png?base64'
import penline from './icon-penline.png?base64'
import pl from './icon-pl-red.png?base64'
import plYellow from './icon-pl-yellow.png?base64'
import plGreen from './icon-pl-green.png?base64'
import plTeal from './icon-pl-teal.png?base64'
import plBlue from './icon-pl-blue.png?base64'
import plPurple from './icon-pl-purple.png?base64'
import plPink from './icon-pl-pink.png?base64'
import play from './icon-play.png?base64'
import playDark from './icon-play-dark.png?base64'
import plplus from './icon-plplus.png?base64'
import plus from './icon-plus.png?base64'
import prev from './icon-prev.png?base64'
import pull from './icon-pull.png?base64'
import queue from './icon-queue.png?base64'
import rec from './icon-rec-red.png?base64'
import recYellow from './icon-rec-yellow.png?base64'
import recGreen from './icon-rec-green.png?base64'
import recTeal from './icon-rec-teal.png?base64'
import recBlue from './icon-rec-blue.png?base64'
import recPurple from './icon-rec-purple.png?base64'
import recPink from './icon-rec-pink.png?base64'
import search from './icon-search.png?base64'
import seek from './icon-seek.png?base64'
import settings from './icon-settings.png?base64'
import shuffle from './icon-shuffle.png?base64'
import sort from './icon-sort.png?base64'
import star from './icon-star.png?base64'
import stop from './icon-stop.png?base64'
import sync from './icon-sync.png?base64'
import tasks from './icon-tasks.png?base64'
import thumbsup from './icon-thumbsup.png?base64'
import timer from './icon-timer.png?base64'
import tocclose from './icon-tocclose.png?base64'
import tocopen from './icon-tocopen.png?base64'
import trash from './icon-trash.png?base64'
import trashDark from './icon-trash-dark.png?base64'
import user from './icon-user.png?base64'

/**
 * 主题色图标：key → { 主题色 key: PNG }。
 * 每张 map 的 `red`（重音红）是默认主题色，也是取不到对应色时的兜底。
 * 组件里用 aIcon(key, accent.key)：写成 computed / 方法、依赖 reactive 的 accent.key，
 * 换色即重渲染。生成顺序 = 脚本 ACCENT_ICONS 的顺序。
 */
export const ACCENT_ICON = {
  liked: { red: liked, yellow: likedYellow, green: likedGreen, teal: likedTeal, blue: likedBlue, purple: likedPurple, pink: likedPink },
  pl: { red: pl, yellow: plYellow, green: plGreen, teal: plTeal, blue: plBlue, purple: plPurple, pink: plPink },
  dl: { red: dl, yellow: dlYellow, green: dlGreen, teal: dlTeal, blue: dlBlue, purple: dlPurple, pink: dlPink },
  hist: { red: hist, yellow: histYellow, green: histGreen, teal: histTeal, blue: histBlue, purple: histPurple, pink: histPink },
  rec: { red: rec, yellow: recYellow, green: recGreen, teal: recTeal, blue: recBlue, purple: recPurple, pink: recPink },
  dlpl: { red: dlpl, yellow: dlplYellow, green: dlplGreen, teal: dlplTeal, blue: dlplBlue, purple: dlplPurple, pink: dlplPink },
  dlar: { red: dlar, yellow: dlarYellow, green: dlarGreen, teal: dlarTeal, blue: dlarBlue, purple: dlarPurple, pink: dlarPink },
  dlal: { red: dlal, yellow: dlalYellow, green: dlalGreen, teal: dlalTeal, blue: dlalBlue, purple: dlalPurple, pink: dlalPink }
}

export const ICON = {
  arrowleft: arrowleft,
  back: back,
  cancel: cancel,
  cat: cat,
  check: check,
  chevdown: chevdown,
  chevleft: chevleft,
  chevright: chevright,
  clockfade: clockfade,
  dbminus: dbminus,
  dbplus: dbplus,
  del: del,
  disc3: disc3,
  dl: dl,
  dlal: dlal,
  dlar: dlar,
  dlpl: dlpl,
  download: download,
  edit: edit,
  fail: fail,
  follow: follow,
  followed: followed,
  harddrive: harddrive,
  help: help,
  hist: hist,
  info: info,
  like: like,
  liked: liked,
  listplus: listplus,
  loop: loop,
  loop1: loop1,
  messagesq: messagesq,
  micvocal: micvocal,
  more: more,
  multi: multi,
  music: music,
  next: next,
  note: note,
  ok: ok,
  options: options,
  order: order,
  palette: palette,
  pause: pause,
  penline: penline,
  pl: pl,
  play: play,
  plplus: plplus,
  plus: plus,
  prev: prev,
  pull: pull,
  queue: queue,
  rec: rec,
  search: search,
  seek: seek,
  settings: settings,
  shuffle: shuffle,
  sort: sort,
  star: star,
  stop: stop,
  sync: sync,
  tasks: tasks,
  thumbsup: thumbsup,
  timer: timer,
  tocclose: tocclose,
  tocopen: tocopen,
  trash: trash,
  user: user
}

/**
 * 取「主题色图标」：aIcon('pl', accent.key)。
 * 非主题色图标（不在 ACCENT_ICON 里）原样回落 ICON，方便组件里统一写法；
 * accentKey 不认识时回落到红（默认主题色），不会出现空 <image>。
 */
export function aIcon(key, accentKey) {
  const m = ACCENT_ICON[key]
  if (!m) return ICON[key]
  return m[accentKey] || m.red
}

export default ICON

/**
 * 会落在**实心主题色**上的图标 → 除白版外再备一份深色版（清单 = 脚本 DARK_ICONS）。
 * 为什么：Vocaloid 七色里 6 个是亮色（黄/绿/青/蓝/紫/粉），白图标压上去对比度只有 ~1.5:1
 * （几乎看不见），而平台不能给 <image> 染色 —— 只能同一形状再来一份深色的。
 * 用途：play/pause 主控键底（.idx-play / .ply-btnmain）；check 多选勾选圈
 * （SongRow / queue）；download / trash 左栏 danger 键 armed。
 */
export const FG_ICON = {
  check: checkDark,
  download: downloadDark,
  play: playDark,
  pause: pauseDark,
  trash: trashDark
}

/**
 * 取「实心主题色上的图标」：fgIcon('play', accent)。
 * accent.dark 为 true（该预设是亮色，见 theme.js 的 pickOn）时换深色版；
 * 不在 FG_ICON 里的 key 原样回落白版 —— 组件里可以统一写成 fgIcon(...)。
 */
export function fgIcon(key, accent) {
  if (accent && accent.dark && FG_ICON[key]) return FG_ICON[key]
  return ICON[key]
}
