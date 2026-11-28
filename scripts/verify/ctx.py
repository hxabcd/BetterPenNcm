# -*- coding: utf-8 -*-
"""自检的共享上下文：项目根、CHECKS 判据表、失败数与警示列表。

CHECKS 是「文件 → 必须出现的字符串」表：第一道按它逐条断言，第二/三道也按它遍历。
⚠ 增删页面或搬移文件后**必须同步这张表**，第一道会兜底「表引用了不存在的文件」。
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.normpath(os.path.join(HERE, '..', '..'))

bad = 0
warns = []

CHECKS = [

    ('src/ui/theme.js', ['export const ACCENTS', 'export function currentAccent(', 'export async function setAccent(',
                            'export function currentAccentKey(', 'export const THEME_EVENT',

                            'export const FG_LIGHT', 'export const FG_DARK', 'function pickOn(',
                            'a.on = pickOn(a.c)', "key: 'red'", "c: '#D93A49'"]),
    ('src/ui/mixins/accent.js', ['export const accentMixin', 'vm.accent = currentAccent()', 'THEME_EVENT', 'fgIcon']),
    ('src/core/infra/config.js', ["accentColor: 'red'"]),
    ('src/styles/common.less', ['默认主题色 = 重音红', '@accent-2: #F58A93']),

    
    # X3S 设备自带 libsqlite3 3.21（2017）：没有 UPSERT 语法（3.24 才有）。
    # upsertSql 必须用 INSERT OR IGNORE + UPDATE 的等价写法，否则索引写入整批失败。
    ('src/core/platform/db.js', ['INSERT OR IGNORE INTO', 'X3S 的 libsqlite3']),
    ('src/core/infra/boot.js', ['背景色/主题色同理']),
    ('src/assets/icons.js', ['export const ACCENT_ICON', 'export function aIcon', 'icon-pl-teal.png?base64',
                             'icon-chevright.png?base64',

                             'export const FG_ICON', 'export function fgIcon', 'icon-play-dark.png?base64']),
    ('scripts/lib/gen_icons_spec.py', ['ACCENT_ICONS = ', 'ACCENTS = (', 'def icon_files(', 'def icon_want_color',
                             "'chevright': '#888890'",
                             'DARK_ICONS = ', "('red', '#D93A49')", "DARK_FG = '#14151a'"]),

    ('src/components/NavRail.vue', ['accentMixin', 'this.accent.c', 'TOK.btnBg', 'width: 25vh']),

    ('src/components/SongRow.vue', ['accentMixin', 'this.accent.a12', 'this.accent.c', 'showQuality', 'TOK.markBorder']),

    ('src/pages/index/index.vue', ['accentMixin', '{ color: accent.c }', '{ backgroundColor: accent.c }',
                                   "cico('pl')", "cico('dl')", "cico('hist')", 'return aIcon(key, this.accent.key)']),

    

    ('src/pages/player/player.vue', ['page-shell', 'control-panel', 'lyric-board',
                                     'comment-panel', 'timer-panel', 'seek-panel', 'hint-toast',
                                     'sleepTimer', 'pageFrameMixin', 'toggleSub', 'seekView',
                                     "go('songinfo'"]),
    ('src/components/player/ControlPanel.vue', ['accentMixin', '{ backgroundColor: accent.c }',
                                                 "aIcon('liked', this.accent.key)", 'fgIcon',
                                                 'TOK.btnBg', 'ICON.micvocal', 'ICON.disc3']),

    
    ('src/components/player/LyricBoard.vue', ['accentMixin', 'seekline', 'TOK.text2', 'trackStyle']),
    ('src/components/player/CommentPanel.vue', ['TOK.cardBg', 'ICON.thumbsup', 'fetchComments',
                                                'postComment', "this.$emit('toast'"]),
    ('src/components/player/TimerPanel.vue', ['accentMixin', 'fgIcon', 'sleepTimer', 'TOK.cardBg']),
    ('src/components/player/SeekPanel.vue', ['accentMixin', 'touchAxis', 'trackW', 'timer']),
    ('src/services/ncm/comments.js', ['fetchComments', 'likeComment', 'postComment', 'threadId']),
    ('src/services/player/sleeptimer.js', ['sleepTimer', 'setKeepTrack', 'beginTail', 'onPlayer']),
    ('src/pages/account/account.vue', ['accentMixin', '{ backgroundColor: accent.c }', 'this.accent.c } : { backgroundColor']),
    ('src/pages/album/album.vue', ['accentMixin', '{ color: accent.light }']),
    ('src/pages/artist/artist.vue', ['accentMixin', '{ color: accent.light }']),

    

    # dlqueue：取消有两个入口 —— 行内按钮单击即取消（`const ok = cancelTask(id)`，不许退回两次点按），
    # 左栏「取消全部」才走两次点按确认（armed + 实心主题色键）。判据钉住服务层函数与两种接线，防止确认强度被改乱。
    ('src/pages/dlqueue/dlqueue.vue', ['accentMixin', 'this.accent.light',
                                       'cancelTask', 'cancelDownload', 'fgIcon',
                                       'const ok = cancelTask(id)', "this.isArmed('stopall')"]),
    ('src/pages/downloads/downloads.vue', ['accentMixin', 'cico(', 'aIcon', 'dlpl', 'dlar', 'dlal']),
    ('src/pages/dltracks/dltracks.vue', ['accentMixin', 'ICON.pull', 'ICON.sync', 'lastPullText',
                                         'multiSelectMixin', 'multiList()', 'playlistView', 'syncList']),
    ('src/pages/dlartists/dlartists.vue', ["'context-sheet': ContextSheet", 'sortKey', 'localArtistList', 'accentMixin']),
    ('src/pages/dlalbums/dlalbums.vue', ["'context-sheet': ContextSheet", 'sortKey', 'cols', 'localAlbumList', 'accentMixin']),
    ('src/components/ContextSheet.vue', ['accentMixin', 'OptChip', 'TOK.panel2', "this.$emit('pick'"]),

    

    ('src/pages/list/list.vue', ['accentMixin', '{ color: accent.light }', 'search-sidebar',
                                 'context-sheet', 'sortOptions', 'KINDS']),
    ('src/components/list/SearchSidebar.vue', ['accentMixin', 'this.accent.a18', 'this.accent.light : ', 'SEARCH_TYPES']),

    ('src/pages/login/login.vue', ['accentMixin', '{ color: accent.c }', '{ backgroundColor: accent.c }']),

    
    ('src/pages/playeropts/playeropts.vue', ["'opt-chip': OptChip", "'opt-toggle': OptToggle"]),
    ('src/pages/playlists/playlists.vue', ['accentMixin', 'this.accent.light', '{ color: accent.light }']),
    ('src/pages/plinfo/plinfo.vue', ['accentMixin', 'this.accent.light', 'idxStyle', "'context-sheet': ContextSheet"]),

    ('src/pages/queue/queue.vue', ['accentMixin', 'this.accent.a12', 'this.accent.a14', 'this.accent.light',
                                   '{ color: accent.light }']),

    ('src/pages/setlook/setlook.vue', ['accentMixin', 'ACCENTS', 'currentAccentKey()', 'accents: ACCENTS',
                                       'accentKey:', 'lk-acrow', 'acStyle(a)', 'acTextStyle(a)',
                                       'pickAccent(key)', 'color: a.on', "'opt-toggle': OptToggle"]),
    ('src/pages/setdl/setdl.vue', ["'opt-chip': OptChip", "'opt-toggle': OptToggle", "'cue-row': CueRow", 'autoPull']),
    ('src/pages/songinfo/songinfo.vue', ['accentMixin', '{ color: accent.light }']),
    ('src/pages/storage/storage.vue', ['accentMixin', 'this.accent.c : ']),

    ('src/components/OptChip.vue', ['accentMixin', 'this.accent.a18', 'this.accent.c', 'this.accent.light',
                                    'TOK.panel2', 'TOK.text2']),
    ('src/components/CueRow.vue', ['cue: { type: Boolean', 'dim: { type: Boolean', 'chevright']),

    
    # 左栏兜底判据：frame.js 的 rail 必须在 computed；PageShell 必须兜底非数组（语义判据在第四道，
    # 这两条防的是「兜底/分组被改回去」）
    ('src/ui/mixins/frame.js', ['computed: {', 'return [railBack()]']),
    ('src/components/PageShell.vue', ['Array.isArray(this.rail)', 'railItems', 'railBack']),

    # 导航层：连点合并 / 槽位耗尽的退化策略不能悄悄丢掉（第六道只查调用点，查不到行为）
    ('src/core/infra/nav.js', ['const PAGES = {', 'export function go(', 'export function paramsFor(',
                          'export function attachPage(', 'export function noteLifeCycle(',

                          'DEDUPE_MS', 'dup-ignore', 'topLiveSlot(']),
]
