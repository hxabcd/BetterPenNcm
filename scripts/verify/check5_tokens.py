# -*- coding: utf-8 -*-
"""第五道：token 值字面量巡检（硬失败）。"""
import io
import os
import re
import sys
import glob
import glob as _glob

import ctx
from ctx import CHECKS, PROJ

# ---- 第五道：token 值字面量巡检（硬失败）----
# 规则：token 的**颜色值**只能待在 src/ui/tokens.js（唯一来源）；消费走 TOK（JS）或 common.less 的生成段（LESS 用 @名）。
# 为什么只巡颜色不巡尺寸：尺寸值（6vh / 15vh…）与普通内边距/字号撞车，巡了必误报；
# 颜色是 8 位十六进制/rgba，唯一性足够。新增 token 时把它的颜色值加进下表即可。
TOKEN_VALUES = ['#1a1b1f', '#232428', 'rgba(255, 255, 255, 0.08)', '#ffffff', '#b9b9c0', '#888890',
                '#7bd88f', '#ffd166', '#ff9a9a', '#2e3138', '#1c1e23', 'rgba(0, 0, 0, 0.28)',
                'rgba(4, 7, 10, 0.6)', 'rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0.85)',

                '#242424', '#272727', '#373737', '#282828']
TOKEN_VALUE_OK = {'src/ui/tokens.js', 'src/styles/common.less', 'scripts/gen_tokens.py'}
# 豁免清单（当前为空，逐条登记）：列在这里的文件只降级为警示，不直接判失败
TOKEN_VALUE_DEFERRED = set()  

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
        ctx.bad += 1
        print('✗ %-42s token 值字面量：%s（改走 TOK / LESS 生成段）' % (rel, ', '.join(hits)))

