# -*- coding: utf-8 -*-
"""第二道：跨模块符号「用了但没 import」；第三道：mixin 契约。"""
import io
import os
import re
import sys
import glob
import glob as _glob

import ctx
from ctx import CHECKS, PROJ

# ---- 第二道：跨模块符号「用了但没 import」 ----
# 这是本项目最阴的一类 bug：JS 里引用了没导入的名字，**构建不报错**（当成全局查找），
# 运行时才抛 ReferenceError —— 发生在 data()/render 里就是**整页黑屏**。
SYMBOLS = ['currentBg', 'currentAccent', 'currentAccentKey', 'bindTheme', 'unbindTheme',
           'setBg', 'setAccent', 'accentMixin', 'aIcon', 'fgIcon', 'ACCENTS', 'PRESETS', 'currentKey', 'ICON',
           'railBack', 'railBtn']
import re

for rel, _ in CHECKS:
    # theme.js / accent.js / icons.js 是符号**定义处**；scripts/ 是 Python（自带 ACCENTS 等定义）
    if rel.startswith(('src/ui/theme.js', 'src/ui/mixins/accent.js', 'src/assets/icons.js', 'scripts/')):
        continue  
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
        ctx.bad += 1
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
        ctx.bad += 1
        print('✗ %-42s 接了 multiSelectMixin 但没定义 multiList()（全选会静默失效）' % rel)
