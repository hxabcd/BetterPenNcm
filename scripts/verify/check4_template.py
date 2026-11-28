# -*- coding: utf-8 -*-
"""第四道（硬失败）：模板裸绑定必须有值定义；附带 methods 与 mixin computed 同名检查。"""
import io
import os
import re
import sys
import glob
import glob as _glob

import ctx
from ctx import CHECKS, PROJ

# ---- 第四道（硬失败）：模板裸绑定必须有**值**定义 ----
# 两类命中：
#   ① 全工程找不到定义 → 警示；
#   ② **只有 methods 提供** → 硬失败。模板 `:x="name"` 编译出来是「取字段」
#      （字节码实证：get_field rail），method 版取到的是函数——轻则静默失效
#      （原 LyricPanel.transStyle），重则组件炸掉、整块 UI 消失（pageFrameMixin.rail
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
        if re.match(r'^[A-Za-z}<]', line):  
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
            m6 = MEMBER6_LINE.match(line)  
            if m6:
                m.setdefault(m6.group(1), set()).add('data')
            rl = RETURN_OBJ_LINE.match(line)  
            if rl:
                for kv in rl.group(1).split(','):
                    k = kv.split(':')[0].strip()
                    if re.match(r'^[A-Za-z_$][\w$]*$', k):
                        m.setdefault(k, set()).add('data')
    return m

MIXIN_SOURCES = {
    'accentMixin': 'src/ui/mixins/accent.js',
    'toastMixin': 'src/ui/mixins/toast.js',
    'armMixin': 'src/ui/mixins/arm.js',
    'multiSelectMixin': 'src/ui/mixins/multi.js',
    'pageFrameMixin': 'src/ui/mixins/frame.js',
    'pageBusMixin': 'src/ui/mixins/pagebus.js',
}
MIXIN_GROUPS = {mx: group_map(io.open(os.path.join(PROJ, rel), encoding='utf-8').read())
                for mx, rel in MIXIN_SOURCES.items()}

import glob as _glob4
ctx.warns = []
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
    # 注释里提到绑定形式不算
    tpl = re.sub(r'<!--.*?-->', '', tpl, flags=re.S)  
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

    
    # 裸绑定名：:x="name" 与 v-for="x in name" 的集合名，模板都编译成 get_field。
    # 后者容易漏检：queue.vue 曾把 rows() 写在 methods，v-for 取到函数 → 整窗 0 行、页面中间全空。
    bare = []
    for b in re.finditer(r':([a-zA-Z][\w-]*)="([A-Za-z_$][\w$]*)"', tpl):
        bare.append((':%s="%s"' % (b.group(1), b.group(2)), b.group(2)))
    for b in re.finditer(
            r'v-for="\s*\(?\s*[A-Za-z_$][\w$]*\s*(?:,\s*[A-Za-z_$][\w$]*\s*)?\)?\s+in\s+([A-Za-z_$][\w$]*)\s*"',
            tpl):
        bare.append(('v-for 集合 %s' % b.group(1), b.group(1)))
    for label, name in bare:
        if name in ('true', 'false', 'null', 'undefined') or name in locals_:
            continue
        groups = set(provided.get(name, set())) | set(pgroups.get(name, set()))
        if groups == {'methods'}:
            ctx.bad += 1
            print('✗ %-42s %s 只由 methods 提供（模板编译成取字段 → 拿到函数：静默失效或炸）'
                  % (rel, label))
        elif not groups:
            warns.append('%s 的 %s 在 script 里找不到定义' % (rel, label))

    

    

    # ---- 第四道补：页面 methods 与 mixin computed 同名（静默失效，上面的并集判不出来）----
    # Vue initState 是 methods → data → computed；initComputed 里 `if (!(key in vm))` 在
    # 同名 method 存在时为假 → **只 warn 不覆盖**，vm[key] 仍是 mixin 那个 computed。
    # 实测：页面 methods.rail() 被整份丢掉，左栏回到 mixin 的 [返回]（「创建歌单」键从未出现）。
    # 模板里的裸绑定走上面那条并集判据，所以这里必须独立扫**页面自己**的分组。
    for _name, _groups in pgroups.items():
        if 'methods' not in _groups:
            continue
        for _mx, _mp in MIXIN_GROUPS.items():
            if not re.search(r'\b%s\b' % _mx, body_c):
                continue
            if 'computed' in _mp.get(_name, set()):
                ctx.bad += 1
                print('✗ %-42s 成员 %s 写在 methods，但 %s 已提供同名 computed'
                      '（Vue 保留 mixin 那份 → 页面这份整个失效）' % (rel, _name, _mx))
                break

