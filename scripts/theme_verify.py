# -*- coding: utf-8 -*-
"""项目自检（只读）：主题/令牌约束、模板绑定、mixin 契约、导航路由表一致性。
用法：python scripts/theme_verify.py   （读 src/ 下的实际内容，只读不写）
"""
import io
import os
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.normpath(os.path.join(HERE, '..'))

# (文件, [必须出现的片段...])
CHECKS = [
    ('src/utils/theme.js', ['export const ACCENTS', 'export function currentAccent(', 'export async function setAccent(',
                            'export function currentAccentKey(', 'export const accentMixin',
                            'vm.accent = currentAccent()',
                            # 亮色预设的对比度兜底（Vocaloid 七色里 6 个是亮色）
                            'export const FG_LIGHT', 'export const FG_DARK', 'function pickOn(',
                            'a.on = pickOn(a.c)', "key: 'red'", "c: '#D93A49'"]),
    ('src/utils/config.js', ["accentColor: 'red'"]),
    ('src/styles/common.less', ['默认主题色 = 重音红', '@accent-2: #F58A93']),
    ('src/utils/boot.js', ['背景色/主题色同理']),
    ('src/assets/icons.js', ['export const ACCENT_ICON', 'export function aIcon', 'icon-pl-teal.png?base64',
                             'icon-chevright.png?base64',
                             # 实心主题色上的图标：亮色预设要深色版
                             'export const FG_ICON', 'export function fgIcon', 'icon-play-dark.png?base64']),
    ('scripts/gen_icons.py', ['ACCENT_ICONS = ', 'ACCENTS = (', 'def icon_files(', 'def icon_want_color',
                             "'chevright': '#888890'",
                             'DARK_ICONS = ', "('red', '#D93A49')", "DARK_FG = '#14151a'"]),

    ('src/components/NavRail.vue', ['accentMixin', 'this.accent.c', 'TOK.btnBg', 'width: 25vh']),
    # SongRow：showQuality 列；勾选圈两态（TOK.markBorder）也在这
    ('src/components/SongRow.vue', ['accentMixin', 'this.accent.a12', 'this.accent.c', 'showQuality', 'TOK.markBorder']),
    ('src/components/LyricPanel.vue', ['accentMixin', 'this.accent.c : ']),
    # keyboard.vue 已弃用移除，不再校验

    ('src/pages/index/index.vue', ['accentMixin', '{ color: accent.c }', '{ backgroundColor: accent.c }',
                                   "cico('pl')", "cico('dl')", "cico('hist')", 'return aIcon(key, this.accent.key)']),
    # 播放页 2026-10-29 按设计稿重构、2026-10-30 调整交互：
    # 左栏改回全局 PageShell/NavRail（设计稿左栏样式已应用到 NavRail 全局），页面只剩
    # 控制区 + 子面板；默认空面板，三个切换键开合。判据钉「装配关系 + 主题色/开合契约」。
    ('src/pages/player/player.vue', ['page-shell', 'control-panel', 'lyric-board',
                                     'comment-panel', 'timer-panel', 'seek-panel', 'hint-toast',
                                     'sleepTimer', 'pageFrameMixin', 'toggleSub', 'seekView',
                                     "go('songinfo'"]),
    ('src/components/player/ControlPanel.vue', ['accentMixin', '{ backgroundColor: accent.c }',
                                                 "aIcon('liked', this.accent.key)", 'fgIcon',
                                                 'TOK.btnBg', 'ICON.micvocal', 'ICON.disc3']),
    # 播放页子面板（2026-10-29 重构新增）：判据钉「主题色/令牌接入 + 对外事件契约」，
    # 几何在设计稿与组件注释里，不重复巡（尺寸值巡了必误报）。
    ('src/components/player/LyricBoard.vue', ['accentMixin', 'seekline', 'TOK.text2', 'trackStyle']),
    ('src/components/player/CommentPanel.vue', ['TOK.cardBg', 'ICON.thumbsup', 'fetchComments',
                                                'postComment', "this.$emit('toast'"]),
    ('src/components/player/TimerPanel.vue', ['accentMixin', 'fgIcon', 'sleepTimer', 'TOK.cardBg']),
    ('src/components/player/SeekPanel.vue', ['accentMixin', 'touchAxis', 'TRACK_W', 'timer']),
    ('src/utils/ncm/comments.js', ['fetchComments', 'likeComment', 'postComment', 'threadId']),
    ('src/utils/player/sleeptimer.js', ['sleepTimer', 'setKeepTrack', 'beginTail', 'onPlayer']),
    ('src/pages/account/account.vue', ['accentMixin', '{ backgroundColor: accent.c }', 'this.accent.c } : { backgroundColor']),
    ('src/pages/album/album.vue', ['accentMixin', '{ color: accent.light }']),
    ('src/pages/artist/artist.vue', ['accentMixin', '{ color: accent.light }']),
    ('src/pages/dlqueue/dlqueue.vue', ['accentMixin', 'this.accent.light', 'this.accent.a16']),
    ('src/pages/downloads/downloads.vue', ['accentMixin', 'cico(', 'aIcon', 'dlpl', 'dlar', 'dlal']),
    ('src/pages/dltracks/dltracks.vue', ['accentMixin', 'ICON.pull', 'ICON.sync', 'lastPullText',
                                         'multiSelectMixin', 'multiList()', 'playlistView', 'syncList']),
    ('src/pages/dlartists/dlartists.vue', ["'context-sheet': ContextSheet", 'sortKey', 'localArtistList', 'accentMixin']),
    ('src/pages/dlalbums/dlalbums.vue', ["'context-sheet': ContextSheet", 'sortKey', 'cols', 'localAlbumList', 'accentMixin']),
    ('src/components/ContextSheet.vue', ['accentMixin', 'OptChip', 'TOK.panel2', "this.$emit('pick'"]),
    ('src/pages/list/list.vue', ['accentMixin', '{ color: accent.light }', 'this.accent.a18', 'this.accent.light : ']),
    # login 混 accentMixin（原手写 currentAccent() 已删），判据跟着改
    ('src/pages/login/login.vue', ['accentMixin', '{ color: accent.c }', '{ backgroundColor: accent.c }']),
    # 四处逐字节相同的胶囊样式搬进 components/OptChip.vue（accent 判据跟着搬，
    # 见下方 OptChip 条目）；本页改守「用的是共享控件」——防往回手写
    ('src/pages/playeropts/playeropts.vue', ["'opt-chip': OptChip", "'opt-toggle': OptToggle"]),
    ('src/pages/playlists/playlists.vue', ['accentMixin', 'this.accent.light', '{ color: accent.light }']),
    ('src/pages/plinfo/plinfo.vue', ['accentMixin', 'this.accent.light', 'idxStyle', "'context-sheet': ContextSheet"]),
    # 选中底 a20 → a12、勾选圈与 SongRow 对齐（统一行度量）；a14 仍是「当前播放底」
    ('src/pages/queue/queue.vue', ['accentMixin', 'this.accent.a12', 'this.accent.a14', 'this.accent.light',
                                   '{ color: accent.light }']),
    # 主题色/背景色的开关在二级页 setlook（settings.vue 是分组索引）
    ('src/pages/setlook/setlook.vue', ['accentMixin', 'ACCENTS', 'currentAccentKey()', 'accents: ACCENTS',
                                       'accentKey:', 'lk-acrow', 'acStyle(a)', 'acTextStyle(a)',
                                       'pickAccent(key)', 'color: a.on', "'opt-toggle': OptToggle"]),
    ('src/pages/setdl/setdl.vue', ["'opt-chip': OptChip", "'opt-toggle': OptToggle", "'cue-row': CueRow", 'autoPull']),
    ('src/pages/songinfo/songinfo.vue', ['accentMixin', '{ color: accent.light }']),
    ('src/pages/storage/storage.vue', ['accentMixin', 'this.accent.c : ']),

    # 共享控件（主题色样式实体的所在处；改视觉时判据先看这里）
    ('src/components/OptChip.vue', ['accentMixin', 'this.accent.a18', 'this.accent.c', 'this.accent.light',
                                    'TOK.panel2', 'TOK.text2']),
    ('src/components/CueRow.vue', ['cue: { type: Boolean', 'dim: { type: Boolean', 'chevright']),

    # 左栏兜底判据：frame.js 的 rail 必须在 computed；PageShell 必须兜底
    # 非数组。语义判据在第四道（mixin 分组），这两条防的是「兜底/分组被改回去」。
    ('src/utils/ui/frame.js', ['computed: {', 'return [railBack()]']),
    ('src/components/PageShell.vue', ['Array.isArray(this.rail)', 'railItems', 'railBack']),

    # 导航层：逻辑页 → 实例槽位（页面代码只认逻辑页名；槽位表与 app.json 由第六道交叉校验）
    ('src/utils/nav.js', ['const PAGES = {', 'export function go(', 'export function paramsFor(',
                          'export function attachPage(', 'export function noteLifeCycle(',
                          # 连点合并 / 槽位耗尽的退化策略不能悄悄丢掉（第六道只查调用点，查不到行为）
                          'DEDUPE_MS', 'dup-ignore', 'topLiveSlot(']),
]

bad = 0
for rel, needles in CHECKS:
    path = os.path.join(PROJ, rel)
    if not os.path.exists(path):
        print('✗ %-42s 文件不存在' % rel)
        bad += 1
        continue
    try:
        src = io.open(path, encoding='utf-8').read()
    except Exception as e:
        print('✗ %-42s 读失败 %s' % (rel, e))
        bad += 1
        continue
    miss = [n for n in needles if n not in src]
    if miss:
        bad += 1
        print('✗ %-42s 缺：%s' % (rel, ' | '.join(miss)))
    else:
        print('✓ %-42s %d 项' % (rel, len(needles)))

# ⚠ 删/并文件后**必须同步上表**（否则第一道就 FileNotFoundError）。自检自己兜底这一类漂移：
CHECKS_MISSING = [rel for rel, _ in CHECKS if not os.path.exists(os.path.join(PROJ, rel))]
if CHECKS_MISSING:
    print('✗ CHECKS 表引用了不存在的文件（删/并文件后忘了同步判据）：')
    for _m in CHECKS_MISSING:
        print('   - %s' % _m)
    sys.exit(1)

# ---- 第二道：跨模块符号「用了但没 import」 ----
# 这是本项目最阴的一类 bug：JS 里引用了没导入的名字，**构建不报错**（当成全局查找），
# 运行时才抛 `ReferenceError` —— 发生在 data()/render 里就是**整页黑屏**。
SYMBOLS = ['currentBg', 'currentAccent', 'currentAccentKey', 'bindTheme', 'unbindTheme',
           'setBg', 'setAccent', 'accentMixin', 'aIcon', 'fgIcon', 'ACCENTS', 'PRESETS', 'currentKey', 'ICON',
           'railBack', 'railBtn']
import re

for rel, _ in CHECKS:
    if rel.startswith(('src/utils/theme.js', 'src/assets/icons.js', 'scripts/')):
        continue  # theme.js / icons.js 是符号**定义处**；gen_icons.py 是 Python（自带 ACCENTS 定义）
    src = io.open(os.path.join(PROJ, rel), encoding='utf-8').read()
    # 只看 <script> 段（模板里的同名字符串不算）
    m = re.search(r'<script>(.*?)</script>', src, re.S)
    body = m.group(1) if m else src
    imported = set()
    for im in re.finditer(r'import\s+(?:\{([^}]*)\}|(\w+))\s+from', body):
        if im.group(1):
            for part in im.group(1).split(','):
                part = part.strip()
                if ' as ' in part:
                    part = part.split(' as ')[-1].strip()
                if part:
                    imported.add(part)
        if im.group(2):
            imported.add(im.group(2))
    # 去掉 import 行与注释再判「是否被使用」（否则注释里提一句符号就误报）
    stripped = re.sub(r'^import\s.*$', '', body, flags=re.M)
    stripped = re.sub(r'/\*.*?\*/', '', stripped, flags=re.S)
    stripped = re.sub(r'^\s*//.*$', '', stripped, flags=re.M)
    stripped = re.sub(r'<!--.*?-->', '', stripped, flags=re.S)
    # ⚠ `this.fgIcon(...)` 是 accentMixin 给的**方法**，不需要 import —— 先把 this. 前缀的抹掉
    stripped = re.sub(r'\bthis\.\w+\b', 'this.', stripped)
    used = [s for s in SYMBOLS if re.search(r'\b%s\b' % s, stripped) and s not in imported]
    if used:
        bad += 1
        print('✗ %-42s 用了但没 import：%s' % (rel, ', '.join(used)))

# ---- 第三道：mixin 契约（静默失效类）----
# 页面接了 multiSelectMixin 就必须定义 multiList()（多选范围）——漏了不会报错，
# 但 allPicked/toggleAll 永远按空数组算 → 「全选」静默失效。同类：armMixin 无契约数据字段，
# toastMixin 无契约方法，故只查这一条硬契约。
for rel, _ in CHECKS:
    if not rel.startswith('src/pages/'):
        continue
    src = io.open(os.path.join(PROJ, rel), encoding='utf-8').read()
    if 'multiSelectMixin' in src and 'multiList()' not in src:
        bad += 1
        print('✗ %-42s 接了 multiSelectMixin 但没定义 multiList()（全选会静默失效）' % rel)

# ---- 第四道（硬失败）：模板裸绑定必须有**值**定义 ----
# 两类命中：
#   ① 全工程找不到定义（原 artist.vue moreStyle 类）→ 警示；
#   ② **只有 methods 提供** → 硬失败。模板 `:x="name"` 编译出来是「取字段」
#      （字节码实证：get_field rail），method 版取到的是函数——轻则静默失效
#      （LyricPanel.transStyle），重则组件炸掉、整块 UI 消失（pageFrameMixin.rail
#      写进 methods → NavRail 拿函数 slice 报错 → 11 个页面左栏全没）。
# 判法：按缩进把 mixin / 页面 script 的 computed·methods·data·props 成员归组。
GROUP_LINE = re.compile(r'^  (computed|methods|data|props)\s*[:(]')
MEMBER_LINE = re.compile(r'^    ([A-Za-z_$][\w$]*)\s*[:(]')
MEMBER6_LINE = re.compile(r'^      ([A-Za-z_$][\w$]*)\s*[:(]')
RETURN_OBJ_LINE = re.compile(r'^\s*return\s*\{(.*)\}\s*$')


def group_map(text):
    """名字 → 出现过的组集合（本工程缩进规范：组 2 空格、成员 4；data 的 return 里 6）"""
    m = {}
    group = None
    for line in text.splitlines():
        if re.match(r'^[A-Za-z}<]', line):  # 顶格行 = 对象/函数边界，清状态
            group = None
            continue
        g = GROUP_LINE.match(line)
        if g:
            group = g.group(1)
            continue
        mm = MEMBER_LINE.match(line)
        if mm and group:
            m.setdefault(mm.group(1), set()).add(group)
        if group == 'data':
            m6 = MEMBER6_LINE.match(line)  # data(){ return { 多行写法
            if m6:
                m.setdefault(m6.group(1), set()).add('data')
            rl = RETURN_OBJ_LINE.match(line)  # 单行 return { a: 1, b: 2 }
            if rl:
                for kv in rl.group(1).split(','):
                    k = kv.split(':')[0].strip()
                    if re.match(r'^[A-Za-z_$][\w$]*$', k):
                        m.setdefault(k, set()).add('data')
    return m


MIXIN_SOURCES = {
    'accentMixin': 'src/utils/theme.js',
    'toastMixin': 'src/utils/ui/toast.js',
    'armMixin': 'src/utils/ui/arm.js',
    'multiSelectMixin': 'src/utils/ui/multi.js',
    'pageFrameMixin': 'src/utils/ui/frame.js',
    'pageBusMixin': 'src/utils/ui/pagebus.js',
}
MIXIN_GROUPS = {mx: group_map(io.open(os.path.join(PROJ, rel), encoding='utf-8').read())
                for mx, rel in MIXIN_SOURCES.items()}

import glob as _glob4
warns = []
_view_files = []
for _base in ('src/pages', 'src/components'):
    for _p in _glob4.glob(os.path.join(PROJ, _base, '**', '*.vue'), recursive=True):
        _rel = os.path.relpath(_p, PROJ).replace('\\', '/')
        if '_backup' in _rel:
            continue
        _view_files.append(_rel)

for rel in sorted(_view_files):
    src = io.open(os.path.join(PROJ, rel), encoding='utf-8').read()
    mt = re.search(r'<template>(.*?)</template>', src, re.S)
    ms = re.search(r'<script>(.*?)</script>', src, re.S)
    if not mt or not ms:
        continue
    tpl, body = mt.group(1), ms.group(1)
    tpl = re.sub(r'<!--.*?-->', '', tpl, flags=re.S)  # 注释里提到绑定形式不算
    body_c = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
    body_c = re.sub(r'^\s*//.*$', '', body_c, flags=re.M)
    provided = {}
    for mx, mp in MIXIN_GROUPS.items():
        if re.search(r'\b%s\b' % mx, body_c):
            for k, v in mp.items():
                provided.setdefault(k, set()).update(v)
    pgroups = group_map(body_c)
    # 模板局部名（v-for 别名）与字面量不算
    locals_ = set(re.findall(r'v-for="\s*\(?\s*([A-Za-z_$][\w$]*)', tpl))
    locals_ |= set(re.findall(r'v-for="\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)', tpl))
    for b in re.finditer(r':([a-zA-Z][\w-]*)="([A-Za-z_$][\w$]*)"', tpl):
        attr, name = b.group(1), b.group(2)
        if name in ('true', 'false', 'null', 'undefined') or name in locals_:
            continue
        groups = set(provided.get(name, set())) | set(pgroups.get(name, set()))
        if groups == {'methods'}:
            bad += 1
            print('✗ %-42s :%s="%s" 只由 methods 提供（模板编译成取字段 → 拿到函数：静默失效或炸）'
                  % (rel, attr, name))
        elif not groups:
            warns.append('%s 的 :%s="%s" 在 script 里找不到定义' % (rel, attr, name))

    # ---- 第四道补：页面 methods 与 mixin computed 同名（静默失效，上面的并集判不出来）----
    # Vue initState 是 methods → data → computed；initComputed 里 `if (!(key in vm))` 在
    # 同名 method 存在时为假 → **只 warn 不覆盖**，`vm[key]` 仍是 mixin 那个 computed。
    # 实测：页面 methods.rail() 被整份丢掉，左栏回到 mixin 的 [返回]（「创建歌单」键从未出现）。
    # 模板里的裸绑定走上面那条并集判据，所以这里必须独立扫**页面自己**的分组。
    for _name, _groups in pgroups.items():
        if 'methods' not in _groups:
            continue
        for _mx, _mp in MIXIN_GROUPS.items():
            if not re.search(r'\b%s\b' % _mx, body_c):
                continue
            if 'computed' in _mp.get(_name, set()):
                bad += 1
                print('✗ %-42s 成员 %s 写在 methods，但 %s 已提供同名 computed'
                      '（Vue 保留 mixin 那份 → 页面这份整个失效）' % (rel, _name, _mx))
                break
# ---- 第五道：token 值字面量巡检（硬失败）----
# 规则：token 的**颜色值**只能待在 src/utils/ui/tokens.js（唯一来源）；
# 消费走 TOK（JS）或 common.less 的生成段（LESS 用 @名）。
# 为什么只巡颜色不巡尺寸：尺寸值（6vh / 15vh…）与普通内边距/字号撞车，巡了必误报；
# 颜色是 8 位十六进制/rgba，唯一性足够。新增 token 时把它的颜色值加进下表即可。
TOKEN_VALUES = ['#1a1b1f', '#232428', 'rgba(255, 255, 255, 0.08)', '#ffffff', '#b9b9c0', '#888890',
                '#7bd88f', '#ffd166', '#ff9a9a', '#2e3138', '#1c1e23', 'rgba(0, 0, 0, 0.28)',
                'rgba(4, 7, 10, 0.6)', 'rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0.85)',
                # 播放页重构（PlayerPage 14:1570）新增的 4 个面/槽色
                '#242424', '#272727', '#373737', '#282828']
TOKEN_VALUE_OK = {'src/utils/ui/tokens.js', 'src/styles/common.less', 'scripts/gen_tokens.py'}
TOKEN_VALUE_DEFERRED = set()  # 当前没有豁免文件

import glob as _glob

_scan = []
for _base in ('src/pages', 'src/components', 'src/styles'):
    for _p in _glob.glob(os.path.join(PROJ, _base, '**', '*.*'), recursive=True):
        _rel = os.path.relpath(_p, PROJ).replace('\\', '/')
        if '_backup' in _rel or not _rel.endswith(('.vue', '.less', '.js')):
            continue
        _scan.append(_rel)
for rel in sorted(_scan):
    if rel in TOKEN_VALUE_OK:
        continue
    text = io.open(os.path.join(PROJ, rel), encoding='utf-8').read()
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    text = re.sub(r'<!--.*?-->', '', text, flags=re.S)
    text = re.sub(r'^\s*//.*$', '', text, flags=re.M)
    hits = [v for v in TOKEN_VALUES if v in text]
    if not hits:
        continue
    if rel in TOKEN_VALUE_DEFERRED:
        warns.append('%s 仍是 token 值字面量：%s' % (rel, ', '.join(hits)))
    else:
        bad += 1
        print('✗ %-42s token 值字面量：%s（改走 TOK / LESS 生成段）' % (rel, ', '.join(hits)))

# ---- 第六道：导航路由表自检（逻辑页 / 实例槽位 / app.json 三者一致 + 调用点只写逻辑页名）----
# 导航层（src/utils/nav.js）按「逻辑页 → 实例槽位 key」分配页面实例：页面代码只写逻辑页名，
# 每次 go() 会 navTo 一个**当前不在栈里**的槽位 key（= 真正压栈）。三者不一致会静默退化：
#   - 新页面没登记进 PAGES / app.json → 导航回落平台语义（层级退回）或直接断链；
#   - 槽位 key 没注册 / 指向别的 .vue → 压栈时黑屏或跑错页面；
#   - 调用点写了旧别名 key 或变量 → 绕过槽位分配，平台复用语义重新出现。
# 这些构建期都不报错，所以必须在自检里兜住。
import json as _json

_nav_js = io.open(os.path.join(PROJ, 'src/utils/nav.js'), encoding='utf-8').read()
_logic_slots = {}
for _m in re.finditer(r'^\s{2}([A-Za-z][\w]*):\s*\{\s*slots:\s*\[([^\]]+)\]', _nav_js, re.M):
    _logic_slots[_m.group(1)] = [s.strip().strip('\'"') for s in _m.group(2).split(',') if s.strip()]

_app_pages = _json.load(io.open(os.path.join(PROJ, 'src/app.json'), encoding='utf-8'))['pages']
_nav_bad = []
if not _logic_slots:
    _nav_bad.append('src/utils/nav.js 的 PAGES 表解析为空（表结构变了？同步本条自检）')
if 'index' not in _app_pages:
    _nav_bad.append('src/app.json 缺少入口页 key = index')

_seen_slots = {}
for _logical in sorted(_logic_slots):
    _slots = _logic_slots[_logical]
    if not _slots:
        _nav_bad.append('逻辑页 %s 没有槽位' % _logical)
        continue
    if _slots[0] != _logical:
        _nav_bad.append('逻辑页 %s 的 slots[0] 必须是同名基础 key（现在 %s）' % (_logical, _slots[0]))
    if _logical not in _app_pages:
        _nav_bad.append('逻辑页 %s 未在 src/app.json 注册基础 key' % _logical)
        continue
    _base_vue = _app_pages[_logical]
    for _slot in _slots:
        if _slot in _seen_slots:
            _nav_bad.append('槽位 key %s 同时属于逻辑页 %s 与 %s' % (_slot, _seen_slots[_slot], _logical))
        _seen_slots[_slot] = _logical
        if _slot not in _app_pages:
            _nav_bad.append('逻辑页 %s 的槽位 %s 未在 src/app.json 注册' % (_logical, _slot))
        elif _app_pages[_slot] != _base_vue:
            _nav_bad.append('槽位 %s 指向 %s，与逻辑页 %s 的 %s 不一致（别名 key 必须指向同一 .vue）'
                            % (_slot, _app_pages[_slot], _logical, _base_vue))
for _key in sorted(_app_pages):
    if _key not in _seen_slots:
        _nav_bad.append('src/app.json 的页面 key %s 没登记进 utils/nav.js 槽位表（孤儿页）' % _key)
    if not os.path.exists(os.path.join(PROJ, 'src', _app_pages[_key])):
        _nav_bad.append('src/app.json 的 %s 指向不存在的文件 %s' % (_key, _app_pages[_key]))

# 调用点：go() 第一参必须是已登记逻辑页的字符串字面量；页面不得出现旧别名 / 旧适配 / 直连 navTo
_nav_files = []
for _base in ('src/pages', 'src/components', 'src/utils'):
    for _p in _glob.glob(os.path.join(PROJ, _base, '**', '*.*'), recursive=True):
        _rel2 = os.path.relpath(_p, PROJ).replace('\\', '/')
        if not _rel2.endswith(('.vue', '.js')):
            continue
        _nav_files.append(_rel2)
_go_calls = 0
for _rel2 in sorted(_nav_files):
    _text = io.open(os.path.join(PROJ, _rel2), encoding='utf-8').read()
    _text = re.sub(r'/\*.*?\*/', '', _text, flags=re.S)
    _text = re.sub(r'<!--.*?-->', '', _text, flags=re.S)
    _text = re.sub(r'^\s*//.*$', '', _text, flags=re.M)
    if re.search(r'songinfonested|artistlist|playlistpick', _text):
        _nav_bad.append('%s 仍引用旧别名 key（已由逻辑页 + 实例槽位取代）' % _rel2)
    if _rel2 == 'src/utils/nav.js':
        continue  # 定义处：本身含 go()/navTo 定义，不扫
    if 'onPageParams' in _text:
        _nav_bad.append('%s 仍引用已废弃的 onPageParams（导航层只做压栈，不再复用页面实例）' % _rel2)
    if re.search(r'\$falcon\.navTo\s*\(', _text):
        _nav_bad.append('%s 直连 $falcon.navTo（必须走 utils/nav.js 的 go()，否则绕过槽位分配）' % _rel2)
    for _m in re.finditer(r'(?<![\w.$])go\(', _text):
        _lit = re.match(r'\s*([\'"])([A-Za-z][\w]*)\1', _text[_m.end():_m.end() + 60])
        if not _lit:
            _nav_bad.append('%s 的 go() 第一参不是字符串字面量（页面只能写逻辑页名，'
                            '变量目标会让静态核对失效）' % _rel2)
            continue
        _go_calls += 1
        _name = _lit.group(2)
        if _name not in _logic_slots:
            _nav_bad.append('%s 的 go(\'%s\') 未登记为逻辑页（见 utils/nav.js 的 PAGES）' % (_rel2, _name))
        elif _name == 'index':
            _nav_bad.append('%s 的 go(\'index\') —— index 是根页/入口页，不是导航目标（回上层用 finish 链路）'
                            % _rel2)
# settings 的二级菜单表（GROUPS 的 key）必须与 openGroup 的字面量分支一一对应（新增/改名漏一处会静默 no-op）
_settings = io.open(os.path.join(PROJ, 'src/pages/settings/settings.vue'), encoding='utf-8').read()
_menu_keys = set(re.findall(r"\{\s*key:\s*'([A-Za-z][\w]*)'", _settings))
_branch_pairs = re.findall(r"if \(key === '([A-Za-z][\w]*)'\) go\('([A-Za-z][\w]*)'\)", _settings)
for _k, _v in _branch_pairs:
    if _k != _v:
        _nav_bad.append('settings.vue 的菜单分支 key=%s 却 go(\'%s\')（菜单表与分支必须同名）' % (_k, _v))
if set(_k for _k, _ in _branch_pairs) != _menu_keys:
    _nav_bad.append('settings.vue 的 GROUPS 菜单 key %s 与 openGroup 的 go() 分支 %s 不一致'
                    % (sorted(_menu_keys), sorted(set(_k for _k, _ in _branch_pairs))))
# 每个页面 .vue 都必须能在 app.json 找到（probe / anim 仅探针构建打包，跳过）
for _p in _glob.glob(os.path.join(PROJ, 'src/pages', '*', '*.vue')):
    _rel2 = os.path.relpath(_p, PROJ).replace('\\', '/')
    if _rel2.startswith('src/pages/probe/') or _rel2.startswith('src/pages/anim/'):
        continue
    if _rel2[len('src/'):] not in _app_pages.values():
        _nav_bad.append('页面文件 %s 未在 src/app.json 注册（新页面要先注册 key 并登记导航槽位）' % _rel2)

if _nav_bad:
    bad += len(_nav_bad)
    print('✗ 导航路由表自检：%d 处问题' % len(_nav_bad))
    for _m in _nav_bad:
        print('   - %s' % _m)
else:
    print('✓ %-42s %d 个逻辑页 / %d 个页面 key / %d 处 go() 调用点'
          % ('导航路由表', len(_logic_slots), len(_app_pages), _go_calls))

for w in warns:
    print('⚠ %s' % w)

print()
print('结果：%s（%d 处待修%s）' % ('全部到位' if not bad else '有缺口', bad,
                                  '' if not warns else '，%d 处警示' % len(warns)))
sys.exit(1 if bad else 0)
