# -*- coding: utf-8 -*-
"""第一道：CHECKS 表逐文件断言；表引用了不存在的文件时硬失败。"""
import io
import os
import re
import sys
import glob
import glob as _glob

import ctx
from ctx import CHECKS, PROJ

ctx.bad = 0
for rel, needles in CHECKS:
    path = os.path.join(PROJ, rel)
    if not os.path.exists(path):
        print('✗ %-42s 文件不存在' % rel)
        ctx.bad += 1
        continue
    try:
        src = io.open(path, encoding='utf-8').read()
    except Exception as e:
        print('✗ %-42s 读失败 %s' % (rel, e))
        ctx.bad += 1
        continue
    miss = [n for n in needles if n not in src]
    if miss:
        ctx.bad += 1
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

