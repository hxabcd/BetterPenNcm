# -*- coding: utf-8 -*-
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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
