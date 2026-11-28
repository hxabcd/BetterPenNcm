# -*- coding: utf-8 -*-
"""第六道：导航路由表自检（逻辑页 / 实例槽位 / app.json 三者一致 + 调用点只写逻辑页名）。"""
import io
import os
import re
import sys
import glob
import glob as _glob

import ctx
from ctx import CHECKS, PROJ

# ---- 第六道：导航路由表自检（逻辑页 / 实例槽位 / app.json 三者一致 + 调用点只写逻辑页名）----
# 导航层（src/core/infra/nav.js）按「逻辑页 → 实例槽位 key」分配页面实例：页面代码只写逻辑页名，
# 每次 go() 会 navTo 一个**当前不在栈里**的槽位 key（= 真正压栈）。三者不一致会静默退化：
#   - 新页面没登记进 PAGES / app.json → 导航回落平台语义（层级退回）或直接断链；
#   - 槽位 key 没注册 / 指向别的 .vue → 压栈时黑屏或跑错页面；
#   - 调用点写了旧别名 key 或变量 → 绕过槽位分配，平台「复用栈内同名页」的语义重新出现。
# 这些构建期都不报错，所以必须在自检里兜住。
import json as _json

_nav_js = io.open(os.path.join(PROJ, 'src/core/infra/nav.js'), encoding='utf-8').read()
_logic_slots = {}
for _m in re.finditer(r'^\s{2}([A-Za-z][\w]*):\s*\{\s*slots:\s*\[([^\]]+)\]', _nav_js, re.M):
    _logic_slots[_m.group(1)] = [s.strip().strip('\'"') for s in _m.group(2).split(',') if s.strip()]

_app_pages = _json.load(io.open(os.path.join(PROJ, 'src/app.json'), encoding='utf-8'))['pages']
_nav_bad = []
if not _logic_slots:
    _nav_bad.append('src/core/infra/nav.js 的 PAGES 表解析为空（表结构变了？同步本条自检）')
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
for _base in ('src/pages', 'src/components', 'src/core', 'src/ui', 'src/services'):
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
    if _rel2 == 'src/core/infra/nav.js':
        continue  
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
    ctx.bad += len(_nav_bad)
    print('✗ 导航路由表自检：%d 处问题' % len(_nav_bad))
    for _m in _nav_bad:
        print('   - %s' % _m)
else:
    print('✓ %-42s %d 个逻辑页 / %d 个页面 key / %d 处 go() 调用点'
          % ('导航路由表', len(_logic_slots), len(_app_pages), _go_calls))

