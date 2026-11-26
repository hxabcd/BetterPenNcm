# -*- coding: utf-8 -*-
"""
生成界面图标 PNG（src/assets/icon-*.png）—— 图标来源 Lucide 1.52.0（ISC 许可）。

为什么是「SVG 在 PC 端栅格化成 PNG」而不是运行时直接用 SVG：
  设备端唯一**已实证**的图标通道是 PNG data URI（`xxx.png?base64` 被 aiot-vue-cli 的
  rollup-plugins/image.js 内联成 `data:image/png;base64,…` 喂给 <image>；PenMusic、doge-reader
  与本项目三方印证）。`libfalcon.so` 里虽然带着 lunasvg，但从 <image> 到它的路由**没有任何证据**，
  且 aiot-cli 给 .svg 生成的 MIME 是非标准的 `image/svg`（缺 `+xml`）——所以 SVG 只是**设计来源**，
  不是运行时格式。

为什么用 magick 栅格化：
  本机 ImageMagick 7.1.2 的 SVG 委托是 librsvg 2.40.20，形状/圆头线帽/圆角实测全部正确，
  不必装任何新依赖。SVG 源已 vendor 到 scripts/lucide-svg/，**构建期不联网**。

三个坑（都踩过，别再踩）：
  1. `-background none` 必须写在输入 `svg:-` **之前**：写在后面会被当成「对已读入图像的操作」，
     结果是整张图变成不透明白底（图标全白块，且毫无报错）。
  2. `-depth 8` + `-define png:color-type=6` 必须成对：IM 是 Q16-HDRI，默认输出 16 位/通道，
     PIL 读出来会误判成全不透明。
  3. 实心样式**必须区分闭合形状与开放路径**：skip-forward 的竖条 `M21 4v16` 是开放路径，
     一刀切 `stroke="none"` 会把竖条**弄没**（实心三角还在，肉眼容易漏看）。所以每条开放路径
     都要在下面的 ICONS 表里显式列出（`open_paths`）。

主题色图标：
  平台不能给 <image> 染色，所以**跟着主题色变**的那几个图标（见 ACCENT_ICONS：
  首页三张文字卡的裸图标 + 播放页收藏态红心）要**每个预设色各出一份** PNG，
  文件名 icon-<key>-<accentKey>.png，运行时由 assets/icons.js 的 aIcon(key, accentKey) 取。
  色表 ACCENTS 必须与 src/ui/theme.js 的 ACCENTS 逐项对齐（key + c）；加/减主题色要**两处同时改**。

用法：
  python scripts/gen_icons.py                 # 生成（默认 72px，缺的 vendor SVG 自动拉取）
  python scripts/gen_icons.py --size 48       # 换源图尺寸（真机 A/B 用）
  python scripts/gen_icons.py --preview       # 生成 + PC 对照图 shots/icon-sheet.png
  python scripts/gen_icons.py --check         # 只自检、不写文件
  python scripts/gen_icons.py --fetch         # 强制重拉所有 vendor SVG（联网）
  python scripts/gen_icons.py --no-fetch      # 断网模式：缺文件直接报错
  python scripts/gen_icons.py --emit-js       # 按表重写 src/assets/icons.js（注册表唯一来源，
                                              #   该文件是纯生成物；--check 逐字节校验）
"""
import argparse
import io
import os
import re
import subprocess
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFont

# Windows 控制台默认 GBK，打印 ✓/✗ 会 UnicodeEncodeError；统一成 UTF-8 输出
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.normpath(os.path.join(HERE, '..'))
ICON_DIR = os.path.join(PROJ, 'src', 'assets')
VENDOR_DIR = os.path.join(HERE, 'lucide-svg')
SHEET = os.path.join(PROJ, 'shots', 'icon-sheet.png')

LUCIDE_VERSION = '1.52.0'
LUCIDE_URL = 'https://unpkg.com/lucide-static@' + LUCIDE_VERSION + '/icons/%s.svg'
WHITE = '#FFFFFF'   
# 24 栅格下的描边粗细（Lucide 原生 2.0，手绘旧版 2.2–2.6，取 2.25）
STROKE = 2.25   
# 输出像素（显示尺寸 5.4–12vh = 13–29px，72 对最大号仍有 2.5 倍余量）
OUT = 72        
MAGICK = os.environ.get('MAGICK', 'magick')

# 图标表：key → (lucide 名, 样式, 保持描边的开放路径)
#   stroke     = 描边（原样）
#   fill       = 闭合形状填充，开放路径保持描边（播放控制类）
#   fill-align = 闭合形状填充但**保留描边** → 外沿与描边版逐像素一致（like/liked 原地切换不跳大小；
#                实测 240px 下 224x194 == 224x194，纯填充版则会小一圈）
ICONS = [
    ('arrowleft','arrow-left',         'stroke',     ()),   
    ('back',     'chevron-left',       'stroke',     ()),
    ('cancel',   'circle-x',           'stroke',     ()),   
    ('cat',      'layout-grid-circles','stroke',     ()),   
    ('check',    'check',              'stroke',     ()),
    ('chevdown', 'chevron-down',       'stroke',     ()),
    ('chevleft', 'chevron-left',       'stroke',     ()),   
    ('chevright','chevron-right',      'stroke',     ()),   
    ('clockfade','clock-fading',       'stroke',     ()),   
    ('dbminus',  'database-minus',     'stroke',     ()),   
    ('dbplus',   'database-plus',      'stroke',     ()),   
    ('del',      'delete',             'stroke',     ()),   
    ('disc3',    'disc-3',             'stroke',     ()),   
    ('dl',       'download',           'stroke',     ()),   
    ('dlal',     'disc-3',             'stroke',     ()),   
    ('dlar',     'mic-vocal',          'stroke',     ()),   
    ('dlpl',     'gallery-vertical-end','stroke',    ()),   
    ('download', 'download',           'stroke',     ()),   
    ('edit',     'pencil',             'stroke',     ()),
    ('fail',     'circle-alert',       'stroke',     ()),   
    ('follow',   'user-round-plus',    'stroke',     ()),   

    

    
    ('followed', 'user-round-minus',   'stroke',     ()),   
    ('harddrive','hard-drive',         'stroke',     ()),   
    ('help',     'circle-question-mark','stroke',    ()),   
    ('hist',     'history',            'stroke',     ()),   
    ('info',     'info',               'stroke',     ()),   
    ('like',     'heart',              'stroke',     ()),
    ('liked',    'heart',              'fill-align', ()),   
    ('listplus', 'list-plus',          'stroke',     ()),   
    ('loop',     'repeat',             'stroke',     ()),   
    ('loop1',    'repeat-1',           'stroke',     ()),   
    ('messagesq','message-square',     'stroke',     ()),   
    ('micvocal', 'mic-vocal',          'stroke',     ()),   
    ('more',     'ellipsis',           'stroke',     ()),   
    ('multi',    'list-checks',        'stroke',     ()),   
    ('music',    'music',              'stroke',     ()),   
    ('next',     'skip-forward',       'fill',       ('M21 4v16',)),
    ('note',     'music',              'stroke',     ()),   
    ('ok',       'circle-check',       'stroke',     ()),   
    ('options',  'settings-2',         'stroke',     ()),   
    ('order',    'arrow-right',        'stroke',     ()),   
    ('palette',  'palette',            'stroke',     ()),   
    ('pause',    'pause',              'fill',       ()),
    ('penline',  'pen-line',           'stroke',     ()),   
    ('pl',       'library',            'stroke',     ()),   
    ('play',     'play',               'fill',       ()),
    ('plplus',   'square-plus',        'stroke',     ()),   
    ('plus',     'plus',               'stroke',     ()),   
    ('prev',     'skip-back',          'fill',       ('M3 20V4',)),
    ('pull',     'move-down-left',     'stroke',     ()),   
    ('queue',    'list-music',         'stroke',     ()),
    ('rec',      'sparkles',           'stroke',     ()),   
    ('search',   'search',             'stroke',     ()),
    ('seek',     'clock',              'stroke',     ()),
    ('settings', 'settings',           'stroke',     ()),
    ('shuffle',  'shuffle',            'stroke',     ()),   
    ('sort',     'arrow-up-down',      'stroke',     ()),
    ('star',     'star',               'stroke',     ()),   
    ('stop',     'x',                  'stroke',     ()),   
    ('sync',     'refresh-cw',         'stroke',     ()),   
    ('tasks',    'clipboard-list',     'stroke',     ()),   
    ('thumbsup', 'thumbs-up',          'stroke',     ()),   
    ('timer',    'timer',              'stroke',     ()),   
    ('tocclose', 'arrow-left-to-line', 'stroke',     ()),   
    ('tocopen',  'arrow-right-from-line','stroke',   ()),   
    ('trash',    'trash-2',            'stroke',     ()),
    ('user',     'user-round',         'stroke',     ()),   
]

ELEM_RE = re.compile(r'<(path|rect|circle|ellipse|polygon|polyline|line)\b[^>]*?/>')
ROOT_RE = re.compile(r'<svg\b[^>]*>')

# 需要「非纯白」的图标：平台不能给 <image> 染色（没有 tint/mask/filter），想要什么颜色就只能
# 生成什么颜色的 PNG；其余图标一律纯白，颜色靠按钮底色体现
COLORS = {
    # 首页卡片「无封面」占位音符 = @text-3 弱文字（改 token 要重跑本脚本）
    'note': '#888890',      

    

    
    # 设置页「可进入」提示箭头用 @text-3：它是**提示**不是控件，白色会读成「一个按钮」。
    # 也不用文本字形 ›：20.4px 下墨迹实测只有 5.5×7.5px（比 14.4px 副行字还矮一半），扫视读不出来；图标是 8.7×14.7px。
    'chevright': '#888890',

    
    # 播放页没有按钮底的行内图标：设计稿画成 @text-2，与同一行的文字同色才不会读成「另一个按钮」（改 token 要重跑本脚本）。
    'micvocal': '#b9b9c0',   
    'disc3': '#b9b9c0',      
    'thumbsup': '#b9b9c0',   
}

ACCENT_ICONS = ('liked', 'pl', 'dl', 'hist', 'rec', 'dlpl', 'dlar', 'dlal')

ACCENTS = (
    ('red', '#D93A49'),      
    ('yellow', '#FFE211'),   
    ('green', '#9DE190'),    
    ('teal', '#39C5BB'),     
    ('blue', '#66CCFF'),     
    ('purple', '#9999FF'),   
    ('pink', '#FAAFBE')      
)

# 会落在**实心主题色**上的图标 → 每个再生成一份深色版（icon-<key>-dark.png）：
# 这套预设里有 6 个是亮色（黄/绿/青/蓝/紫/粉），白图标压上去对比度只有 ~1.5:1，
# 而平台不能染色 → 只能同一形状再来一份深色的；运行时由 assets/icons.js 的 fgIcon(key, accent)
# 按 accent.dark 挑（theme.js 的 pickOn 判定）。
DARK_ICONS = ('check', 'download', 'play', 'pause', 'stop', 'trash')

# 深色前景（与 src/ui/theme.js 的 FG_DARK 保持一致）
DARK_FG = '#14151a'

# 墨迹缩放：Lucide 各图形在 24 栅格里的留白不同，一律同尺寸渲染会让墨迹占满画布的那种粗一圈。
# 判据是**墨迹 bbox**（72px 输出含描边）：首页卡片四兄弟实测 pl=56、dl=62、hist=62、rec(sparkles)=68
# → sparkles 比 dl/hist 大 10%、比 pl 大 21%。只收「明显偏大」的，缩到与 dl/hist 齐平（62）；
# 其余保持原样（pl 的 library 是竖条字形，强行放大反而变粗；缩略对齐不等于视觉对齐）。缩放绕画布中心。
# ⚠ 加新图标后看 --check 的 bbox：与同排同伴差 5px 以上就该进这张表。
INK_SCALE = {
    # sparkles 墨迹 68px → 62px（对齐 dl / hist）
    'rec': 62.0 / 68.0,     
}

def icon_files(key):
    """该 key 会生成的全部文件名（着色图标 = 每个主题色一份；实心底图标 = 白 + 深两版）"""
    if key in ACCENT_ICONS:
        return ['icon-%s-%s.png' % (key, ak) for ak, _ in ACCENTS]
    files = ['icon-%s.png' % key]
    if key in DARK_ICONS:
        files.append('icon-%s-dark.png' % key)
    return files

def default_icon(key):
    """该 key 的「默认」文件名 = 列表首项（着色图标即第一个主题色；实心底图标即白色版）"""
    return icon_files(key)[0]

def icon_want_color(key, fname):
    """文件名 → 该图标的期望颜色（自检用）"""
    if key in ACCENT_ICONS:
        prefix, suffix = 'icon-%s-' % key, '.png'
        if fname.startswith(prefix) and fname.endswith(suffix):
            ak = fname[len(prefix):-len(suffix)]
            for k, c in ACCENTS:
                if k == ak:
                    return c
    if key in DARK_ICONS and fname.endswith('-dark.png'):
        return DARK_FG
    return COLORS.get(key, WHITE)

def js_var(key, fname):
    """该 PNG 在 icons.js 里的 import 变量名：默认文件 = 裸 key；变体 = key + 后缀驼峰"""
    if fname == default_icon(key):
        return key
    base = fname[len('icon-'):-len('.png')]
    suffix = base[len(key) + 1:]
    return key + ''.join(p[:1].upper() + p[1:] for p in suffix.split('-'))

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

def die(msg):
    sys.exit('错误：%s' % msg)

def fmt(v):
    return '%g' % v

def build_svg(raw, key, name, style, open_paths, out_px, color):
    """Lucide 原件 → 目标尺寸 / 目标颜色 / 目标线宽的 SVG 文本。

    key 只用来查 INK_SCALE（墨迹缩放）；name 是 lucide 名，只用于报错信息。
    返回 (svg 文本, 被填充的形状数, 保持描边的形状数)。"""
    m = ROOT_RE.search(raw)
    if not m:
        die('%s.svg 里找不到根 <svg> 标签' % name)
    root = m.group(0)
    if root.count('stroke-width=') != 1:
        die('%s.svg 根标签的 stroke-width 出现 %d 次（预期 1）：属性结构变了，请人工核对'
            % (name, root.count('stroke-width=')))
    new_root = (root
                .replace('width="24"', 'width="%d"' % out_px, 1)
                .replace('height="24"', 'height="%d"' % out_px, 1)
                .replace('stroke-width="2"', 'stroke-width="%s"' % fmt(STROKE), 1)
                .replace('currentColor', color))
    body = raw[m.end():]
    n_fill = n_stroke = 0
    if style != 'stroke':
        keep_stroke = (style == 'fill-align')
        # 形状分类：以 z 结尾 = 闭合；不以 z 结尾但首尾同点（SVG 填充时隐式闭合，如 heart）也算闭合；
        # line / polyline 没有面积只能描边；open_paths 里显式列出的开放路径必须保留描边（否则竖条被填没）。
        out, pos = [], 0
        for em in ELEM_RE.finditer(body):
            tag, el = em.group(1), em.group(0)
            d = re.search(r'\bd="([^"]*)"', el)
            if d:
                d = d.group(1).strip()
                if d in open_paths:
                    cls = 'stroke'          
                else:

                    cls = 'fill'
            elif tag in ('rect', 'circle', 'ellipse', 'polygon'):
                cls = 'fill'
            else:                           
                cls = 'stroke'
            if cls == 'fill':
                n_fill += 1
                el = el[:-2] + ' fill="%s"%s/>' % (color, '' if keep_stroke else ' stroke="none"')
            else:
                n_stroke += 1
            out.append(body[pos:em.start()])
            out.append(el)
            pos = em.end()
        out.append(body[pos:])
        body = ''.join(out)
        if n_fill == 0:
            die('%s 是 %s 样式，但一个可填充的形状都没找到（素材或规则变了）' % (name, style))
    scale = INK_SCALE.get(key)
    if scale and scale != 1.0:

        

        

        
        # ⚠ 缩放坐标系数值是 **24**（根标签 viewBox="0 0 24 24"，改的只是 width/height）→ 中心是 12，
        #   不是 out_px/2=36；写 36 会把图形推到画布右下角外面去。
        # ⚠ body 是「根标签之后的全部内容」，**包含收尾的 </svg>**：包装层必须插在 </svg> 之前，
        #   否则 <g> 跑到 svg 外面，librsvg 直接报 "unable to read image data"；
        #   且 g 放最前、</g> 紧贴 </svg> 之前（插到末尾就得到一个空组，PNG 看着一点没变）。
        c = 12.0
        g = ('<g transform="translate(%s %s) scale(%s) translate(%s %s)">'
             % (fmt(c), fmt(c), fmt(scale), fmt(-c), fmt(-c)))
        i = body.rfind('</svg>')

        
        body = (g + body[:i] + '</g>' + body[i:]) if i >= 0 else (g + body + '</g>')
    return raw[:m.start()] + new_root + body, n_fill, n_stroke

def rasterize(svg_text):
    p = subprocess.run(
        [MAGICK,
         '-background', 'none',          
         'svg:-',
         '-depth', '8',                  
         '-define', 'png:color-type=6',
         'png:-'],
        input=svg_text.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0 or not p.stdout:
        die('magick 渲染失败（返回码 %d）：%s'
            % (p.returncode, p.stderr.decode('utf-8', 'replace')[:400]))
    return Image.open(io.BytesIO(p.stdout)).convert('RGBA')

def magick_check():
    """启动自检：渲一个 8px 白方块，确认 magick 在、SVG 委托正常、alpha 没丢。"""
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">'
           '<rect x="0" y="0" width="8" height="8" fill="#FFFFFF"/></svg>')
    try:
        img = rasterize(svg)
    except OSError as e:
        die('找不到 `%s`（需要 ImageMagick 7）。装好后重试，或用环境变量指定：\n'
            '  MAGICK=/path/to/magick python scripts/gen_icons.py\n  底层错误：%s' % (MAGICK, e))
    r, g, b, a = img.split()
    if img.size != (8, 8) or a.getextrema() != (255, 255) or r.getextrema() != (255, 255):
        die('magick 自检失败：SVG 渲染不出白块（可能缺 SVG 委托）。自查：\n'
            '  %s -version\n  %s -list format | grep -i svg      # 应看到 SVG rw+（librsvg 委托）'
            % (MAGICK, MAGICK))

def tint(img, color):
    """把 RGB 全部刷成目标颜色，只保留 alpha（默认纯白）。

    两个作用：① 平台不能给 <image> 染色，图标什么颜色就得生成什么颜色；
    ② 抹平 librsvg 在边缘的预乘舍入（如 (254,254,254,254)），否则设备上描边会发灰。
    注意：刷色之后 Image.getbbox() 会返回整幅图（RGB 处处非零），量外沿必须用 alpha 通道。"""
    r, g, b = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    a = img.split()[3]
    return Image.merge('RGBA', (Image.new('L', img.size, r),
                                Image.new('L', img.size, g),
                                Image.new('L', img.size, b), a))

def svg_path(name):
    return os.path.join(VENDOR_DIR, name + '.svg')

def fetch(name):
    url = LUCIDE_URL % name
    print('  拉取 %s' % url)
    req = urllib.request.Request(url, headers={'User-Agent': 'betterpenncm-gen-icons'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode('utf-8')
    except Exception as e:
        die('下载 %s 失败：%s' % (url, e))
    if 'lucide-static v' not in text:
        die('%s 的内容不像 lucide-static 的图标（被重定向到别处了？）' % url)
    os.makedirs(VENDOR_DIR, exist_ok=True)
    with open(svg_path(name), 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    return text

def load_vendor(name, mode):
    path = svg_path(name)
    if mode == 'force' or not os.path.exists(path):
        if mode == 'never':
            die('缺少 %s（去掉 --no-fetch 会自动拉取）' % path)
        fetch(name)
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    if 'viewBox="0 0 24 24"' not in raw:
        die('%s 不是 24 栅格的 Lucide 图标（viewBox 变了？）' % path)
    return raw

def generate(out_px, fetch_mode):
    os.makedirs(ICON_DIR, exist_ok=True)
    magick_check()
    total = 0
    n_files = 0
    for key, name, style, open_paths in ICONS:
        raw = load_vendor(name, fetch_mode)

        if key in ACCENT_ICONS:
            variants = [('-' + ak, c) for ak, c in ACCENTS]
        elif key in DARK_ICONS:

            variants = [('', COLORS.get(key, WHITE)), ('-dark', DARK_FG)]
        else:
            variants = [('', COLORS.get(key, WHITE))]
        for suffix, color in variants:
            svg, n_fill, n_stroke = build_svg(raw, key, name, style, open_paths, out_px, color)
            img = tint(rasterize(svg), color)
            if img.size != (out_px, out_px):
                die('%s 渲染出 %dx%d，预期 %dx%d' % (key + suffix, img.size[0], img.size[1], out_px, out_px))
            path = os.path.join(ICON_DIR, 'icon-%s%s.png' % (key, suffix))
            img.save(path, 'PNG', optimize=True)
            n = os.path.getsize(path)
            total += n
            n_files += 1
            tag = '' if style == 'stroke' else '   [%s：填充 %d / 描边 %d]' % (style, n_fill, n_stroke)
            if color != WHITE:
                tag += '   [着色 %s]' % color
            print('  %-26s %5d B%s' % (os.path.basename(path), n, tag))
    print('%d 个图标 / %d 个文件（Lucide %s，%dpx，线宽 %s），合计 %.1f KB → %s'
          % (len(ICONS), n_files, LUCIDE_VERSION, out_px, fmt(STROKE), total / 1024.0, ICON_DIR))

def check(out_px):
    ok = True
    n_files = sum(len(icon_files(k)) for k, _, _, _ in ICONS)
    print('—— 自检（%d 个图标 / %d 个文件，源图 %dpx）——' % (len(ICONS), n_files, out_px))
    boxes = {}
    for key, name, style, open_paths in ICONS:
        for fname in icon_files(key):
            stem = fname[:-len('.png')]
            path = os.path.join(ICON_DIR, fname)
            if not os.path.exists(path):
                print('  ✗ %-22s 文件不存在' % fname); ok = False; continue
            img = Image.open(path).convert('RGBA')
            r, g, b, a = img.split()
            bbox = a.getbbox()
            cover = sum(a.histogram()[128:]) / float(out_px * out_px)
            want = icon_want_color(key, fname)
            wc = tuple(int(want[i:i + 2], 16) for i in (1, 3, 5))
            problems = []
            if img.size != (out_px, out_px):
                problems.append('尺寸 %dx%d' % img.size)
            if (r.getextrema(), g.getextrema(), b.getextrema()) != tuple((v, v) for v in wc):
                problems.append('颜色不是 %s' % want)
            if bbox is None:
                problems.append('整幅全透明')
            else:
                if not (0.01 <= cover <= 0.70):
                    problems.append('覆盖率 %.1f%% 异常' % (cover * 100))
                if bbox[0] < 1 or bbox[1] < 1 or bbox[2] > out_px - 1 or bbox[3] > out_px - 1:
                    problems.append('内容触边 bbox=%s' % (bbox,))
                boxes[stem] = bbox
            if problems:
                print('  ✗ %-22s %s' % (fname, '；'.join(problems))); ok = False
            else:
                print('  ✓ %-22s bbox=%-16s 覆盖率 %4.1f%%' % (fname, boxes[stem], cover * 100))

    # like / liked 外沿必须对齐（收藏键是原地切换，跳大小非常显眼）—— 拿默认（红）那份比
    if 'icon-like' in boxes and 'icon-liked-red' in boxes:
        diff = max(abs(p - q) for p, q in zip(boxes['icon-like'], boxes['icon-liked-red']))
        print('  %s like/liked 外沿最大差 %dpx' % ('✓' if diff <= 1 else '✗', diff))
        ok = ok and diff <= 1

    # 同一图标的不同主题色变体只应差颜色：外沿（alpha bbox）必须逐像素一致
    for key in ACCENT_ICONS:
        bs = [boxes[f[:-len('.png')]] for f in icon_files(key) if f[:-len('.png')] in boxes]
        if len(bs) < 2:
            continue
        diff = max(max(abs(p - q) for p, q in zip(a, b)) for a in bs for b in bs)
        print('  %s %-6s %d 个主题色变体 外沿最大差 %dpx' % ('✓' if diff == 0 else '✗', key, len(bs), diff))
        ok = ok and diff == 0

    # skip-forward / skip-back 的竖条：专盯「填充模式吞掉开放路径」这个坑
    for key, x0, x1 in (('next', 19.0, 23.0), ('prev', 1.0, 5.0)):
        path = os.path.join(ICON_DIR, 'icon-%s.png' % key)
        if not os.path.exists(path):
            continue
        a = Image.open(path).convert('RGBA').split()[3]
        band = a.crop((int(x0 * out_px / 24.0), 0, int(x1 * out_px / 24.0), out_px))
        n = sum(band.histogram()[128:])
        print('  %s %-6s 竖条区不透明像素 %d' % ('✓' if n > 0 else '✗', key, n))
        ok = ok and n > 0

    # 清单契约：ACCENT_ICONS / DARK_ICONS 里的 key 必须在 ICONS 表里（漏了会静默少图）
    keyset = {k for k, _, _, _ in ICONS}
    stray = [k for k in list(ACCENT_ICONS) + list(DARK_ICONS) if k not in keyset]
    if stray:
        print('  ✗ ACCENT_ICONS/DARK_ICONS 里有不在 ICONS 表里的 key：%s' % ', '.join(stray)); ok = False
    else:
        print('  ✓ 主题色/深色清单的 key 都在 ICONS 表里')

    
    # icons.js 是纯生成物，必须与生成器**逐字节**一致（手改、或改了上面的表忘了 --emit-js，都会在这里被拦下）
    js = os.path.join(ICON_DIR, 'icons.js')
    if os.path.exists(js):
        with open(js, 'r', encoding='utf-8') as f:
            src = f.read()
        want = emit_js()
        if src == want:
            print('  ✓ icons.js 与生成器逐字节一致（%d 个 key / %d 个 import）'
                  % (len(ICONS), sum(len(icon_files(k)) for k, _, _, _ in ICONS)))
        else:
            sl, wl = src.split('\n'), want.split('\n')
            n = min(len(sl), len(wl))
            first = next((i for i in range(n) if sl[i] != wl[i]), n)
            print('  ✗ icons.js 与生成器不一致（首个差异第 %d 行）：' % (first + 1))
            print('      文件：%s' % (sl[first] if first < len(sl) else '<EOF>'))
            print('      生成：%s' % (wl[first] if first < len(wl) else '<EOF>'))
            print('      修复：python scripts/gen_icons.py --emit-js')
            ok = False

    # 孤儿 PNG：只报告不删（无版本控制的工作区不做破坏性默认）
    known = {f for k, _, _, _ in ICONS for f in icon_files(k)} | {'icons.js'}
    orphans = sorted(f for f in os.listdir(ICON_DIR) if f.endswith('.png') and f not in known)
    if orphans:
        print('  ! 图标目录里有不在表内的 PNG（未删除）：%s' % ', '.join(orphans))

    print('自检%s' % ('通过' if ok else '未通过'))
    return ok

PAGE_BG = (15, 15, 17)        
BTN_BG = (35, 36, 40)         
ACCENT = (229, 66, 60)        

def blend(fg, bg, k):
    return tuple(int(round(f * k + b * (1 - k))) for f, b in zip(fg, bg))

def preview(out_px):
    """1 图像像素 = 1 设备像素。三列按钮底取自 NavRail：默认 / 选中态 / danger。"""
    on_bg = blend(ACCENT, BTN_BG, 0.18)     
    cw, ch, pad, top = 128, 96, 14, 46

    # 表头只用 ASCII：PIL 自带字体没有中文字形
    cols = ['key', 'old 24px', 'new 24px', 'new on-state', 'new danger', 'new 24px x3', 'new 13px']
    W = pad * 2 + cw * len(cols)
    H = top + ch * len(ICONS) + pad
    sheet = Image.new('RGB', (W, H), PAGE_BG)
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=15)
    except TypeError:                       
        # 老 Pillow 没有 size 参数
        font = ImageFont.load_default()
    for i, c in enumerate(cols):
        d.text((pad + cw * i + 8, 16), c, fill=(200, 200, 208), font=font)

    for row, (key, name, style, open_paths) in enumerate(ICONS):
        y = top + row * ch
        new = Image.open(os.path.join(ICON_DIR, default_icon(key))).convert('RGBA')
        d.text((pad + 8, y + ch // 2 - 8), key, fill=(185, 185, 192), font=font)
        x = pad + cw

        def btn(w, ox, oy, bg, outline=None):
            d.rounded_rectangle([x + ox, y + oy, x + ox + w, y + oy + w],
                                radius=int(w * 0.3), fill=bg,
                                outline=outline, width=1 if outline else 0)

        old_p = os.path.join(HERE, '_backup', 'handdrawn_png', 'icon-%s.png' % key)
        if os.path.exists(old_p):
            old = Image.open(old_p).convert('RGBA').resize((24, 24), Image.LANCZOS)
            btn(53, 16, 21, BTN_BG)
            sheet.paste(old, (x + 30, y + 35), old)
        x += cw
        for bg, outline in ((BTN_BG, None), (on_bg, ACCENT), (ACCENT, None)):
            btn(53, 16, 21, bg, outline)
            ic = new.resize((24, 24), Image.LANCZOS)
            sheet.paste(ic, (x + 30, y + 35), ic)
            x += cw

        # 24px 渲染结果放大 3 倍（NEAREST）：看真实显示尺寸下的抗锯齿与笔画粗细
        d.rectangle([x, y + 12, x + 72, y + 12 + 72], fill=BTN_BG)
        big = new.resize((24, 24), Image.LANCZOS).resize((72, 72), Image.NEAREST)
        sheet.paste(big, (x, y + 12), big)
        x += cw
        btn(34, 26, 31, BTN_BG)
        sm = new.resize((13, 13), Image.LANCZOS)
        sheet.paste(sm, (x + 36, y + 41), sm)

    os.makedirs(os.path.dirname(SHEET), exist_ok=True)
    sheet.save(SHEET)
    print('对照图 → %s（%dx%d，1 像素 = 1 设备像素）' % (SHEET, W, H))

def main():
    ap = argparse.ArgumentParser(description='Lucide SVG → 图标 PNG')
    ap.add_argument('--size', type=int, default=OUT, help='输出像素（默认 %d）' % OUT)
    ap.add_argument('--preview', action='store_true', help='生成 PC 对照图 shots/icon-sheet.png')
    ap.add_argument('--check', action='store_true', help='只自检，不写文件')
    ap.add_argument('--fetch', action='store_true', help='强制重拉所有 vendor SVG（联网）')
    ap.add_argument('--no-fetch', action='store_true', help='断网：缺 vendor 文件直接报错')
    ap.add_argument('--emit-js', action='store_true', help='按表重写 src/assets/icons.js 后自检')
    args = ap.parse_args()

    if args.check:
        sys.exit(0 if check(args.size) else 1)
    if args.emit_js:
        js = os.path.join(ICON_DIR, 'icons.js')
        with open(js, 'w', encoding='utf-8', newline='\n') as f:
            f.write(emit_js())
        print('✓ 已按表重写 %s' % js)
        sys.exit(0 if check(args.size) else 1)
    generate(args.size, 'never' if args.no_fetch else ('force' if args.fetch else 'missing'))
    check(args.size)
    if args.preview:
        preview(args.size)

if __name__ == '__main__':
    main()
