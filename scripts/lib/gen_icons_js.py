# -*- coding: utf-8 -*-
from gen_icons_spec import ACCENT_ICONS, ACCENTS, DARK_ICONS, ICONS, icon_files, default_icon, js_var

def emit_js():
    """生成 src/assets/icons.js 的完整文本。

    唯一来源 = 本脚本的 ICONS / ACCENT_ICONS / DARK_ICONS / ACCENTS / COLORS 表；
    写入走 `--emit-js`，`--check` 做**逐字节**一致性校验（手改该文件会被拦下）。
    """
    keyset = {k for k, _, _, _ in ICONS}
    L = []
    L.append('/**')
    L.append(' * 界面图标表 —— **本文件由 scripts/gen_icons.py 生成（--emit-js），别手改**。')
    L.append(' *')
    L.append(' * 改图标 / 加主题色 / 改深色清单：全部去脚本的表里改，然后')
    L.append(' *   python scripts/gen_icons.py                      # 重生成 PNG（缺的 vendor SVG 自动拉）')
    L.append(' *   python scripts/gen_icons.py --emit-js            # 重写本文件')
    L.append(' *   python scripts/gen_icons.py --no-fetch --check   # 逐字节校验 + PNG 自检')
    L.append(' *')
    L.append(' * 图标取自 Lucide 1.52.0（ISC License，© Lucide Icons and Contributors，')
    L.append(' * https://lucide.dev）。SVG 原件 vendored 在 scripts/lucide-svg/，')
    L.append(' * PNG 由 gen_icons.py 生成（ImageMagick/librsvg → 72px RGBA）——')
    L.append(' * **颜色必须生成进 PNG**：平台不能给 <image> 染色（没有 tint/mask/filter）。')
    L.append(' *')
    L.append(' * 这里用 `?base64` 后缀 import：aiot-vue-cli 的图片插件（rollup-plugins/image.js')
    L.append(' * 的 REG_BASE64）会把它内联成 data URI 直接喂给 <image>。为什么不用 SVG / 字体字形：')
    L.append(' * 见 gen_icons.py 文件头（两条都没有证据 / 不稳）。')
    L.append(' *')
    L.append(' * 三张表：')
    L.append(' *   ICON        全部图标的默认版（白版 / 着色版 / 主题色第一色）')
    L.append(' *   ACCENT_ICON 跟主题色变的图标（脚本 ACCENT_ICONS），中间层 key = 主题色 key')
    L.append(' *   FG_ICON     会落在实心主题色上的图标（脚本 DARK_ICONS）的深色版')
    L.append(' */')
    for key, _, _, _ in ICONS:
        for fname in icon_files(key):
            L.append("import %s from './%s?base64'" % (js_var(key, fname), fname))
    L.append('')
    L.append('/**')
    L.append(' * 主题色图标：key → { 主题色 key: PNG }。')
    L.append(' * 每张 map 的 `red`（重音红）是默认主题色，也是取不到对应色时的兜底。')
    L.append(' * 组件里用 aIcon(key, accent.key)：写成 computed / 方法、依赖 reactive 的 accent.key，')
    L.append(' * 换色即重渲染。生成顺序 = 脚本 ACCENT_ICONS 的顺序。')
    L.append(' */')
    L.append('export const ACCENT_ICON = {')
    akeys = [k for k in ACCENT_ICONS if k in keyset]
    for i, key in enumerate(akeys):
        inner = ', '.join('%s: %s' % (ak, js_var(key, f)) for (ak, _), f in zip(ACCENTS, icon_files(key)))
        L.append('  %s: { %s }%s' % (key, inner, ',' if i < len(akeys) - 1 else ''))
    L.append('}')
    L.append('')
    L.append('export const ICON = {')
    for i, (key, _, _, _) in enumerate(ICONS):
        L.append('  %s: %s%s' % (key, js_var(key, default_icon(key)), ',' if i < len(ICONS) - 1 else ''))
    L.append('}')
    L.append('')
    L.append('/**')
    L.append(' * 取「主题色图标」：aIcon(\'pl\', accent.key)。')
    L.append(' * 非主题色图标（不在 ACCENT_ICON 里）原样回落 ICON，方便组件里统一写法；')
    L.append(' * accentKey 不认识时回落到红（默认主题色），不会出现空 <image>。')
    L.append(' */')
    L.append('export function aIcon(key, accentKey) {')
    L.append('  const m = ACCENT_ICON[key]')
    L.append('  if (!m) return ICON[key]')
    L.append('  return m[accentKey] || m.red')
    L.append('}')
    L.append('')
    L.append('export default ICON')
    L.append('')
    L.append('/**')
    L.append(' * 会落在**实心主题色**上的图标 → 除白版外再备一份深色版（清单 = 脚本 DARK_ICONS）。')
    L.append(' * 为什么：Vocaloid 七色里 6 个是亮色（黄/绿/青/蓝/紫/粉），白图标压上去对比度只有 ~1.5:1')
    L.append(' * （几乎看不见），而平台不能给 <image> 染色 —— 只能同一形状再来一份深色的。')
    L.append(' * 用途：play/pause 主控键底（.idx-play / .ply-btnmain）；check 多选勾选圈')
    L.append(' * （SongRow / queue）；download / trash 左栏 danger 键 armed；')
    L.append(' * stop 下载队列的「取消全部」与行内「取消」按钮 armed。')
    L.append(' */')
    L.append('export const FG_ICON = {')
    dkeys = [k for k in DARK_ICONS if k in keyset]
    for i, key in enumerate(dkeys):
        L.append('  %s: %s%s' % (key, js_var(key, 'icon-%s-dark.png' % key), ',' if i < len(dkeys) - 1 else ''))
    L.append('}')
    L.append('')
    L.append('/**')
    L.append(' * 取「实心主题色上的图标」：fgIcon(\'play\', accent)。')
    L.append(' * accent.dark 为 true（该预设是亮色，见 theme.js 的 pickOn）时换深色版；')
    L.append(' * 不在 FG_ICON 里的 key 原样回落白版 —— 组件里可以统一写成 fgIcon(...)。')
    L.append(' */')
    L.append('export function fgIcon(key, accent) {')
    L.append('  if (accent && accent.dark && FG_ICON[key]) return FG_ICON[key]')
    L.append('  return ICON[key]')
    L.append('}')
    return '\n'.join(L) + '\n'
