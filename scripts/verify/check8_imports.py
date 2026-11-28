# -*- coding: utf-8 -*-
"""第八道：相对导入存在性（目录重构后路径写错只在运行期黑屏）。"""
import io
import os
import re
import sys
import glob
import glob as _glob

import ctx
from ctx import CHECKS, PROJ

# ---- 第八道：相对导入存在性（目录重构后路径写错只在运行期黑页）----
# 判据：src/**/*.{js,vue} 里所有相对 import/from 的目标（补常见扩展名）必须存在。
# 这类错误构建期不报（aiot-cli 只给一行「未找到以下模块」警告），页面运行到 import 才炸。
_SPEC_RE8 = re.compile(r"""(?:\bfrom|\bimport\s*\(\s*)\s*(['"])(\.[^'"]+)\1""")
_EXT8 = ('', '.js', '.vue', '.json', '.less', '.css', '.png', '.svg', '.gif', '.jpg')
_n_imports8 = 0
_n_bad8 = 0
for _base8 in ('src',):
    _files8 = _glob.glob(os.path.join(PROJ, _base8, '**', '*.js'), recursive=True) + \
              _glob.glob(os.path.join(PROJ, _base8, '**', '*.vue'), recursive=True)
    for _p8 in _files8:
        _rel8 = os.path.relpath(_p8, PROJ).replace('\\', '/')
        try:
            _t8 = io.open(_p8, encoding='utf-8').read()
        except Exception:
            continue
        _t8 = re.sub(r'/\*.*?\*/', '', _t8, flags=re.S)
        _t8 = re.sub(r'^\s*//.*$', '', _t8, flags=re.M)
        for _m8 in _SPEC_RE8.finditer(_t8):
            _spec8 = _m8.group(2)
            if '?base64' in _spec8:
                _spec8 = _spec8.split('?', 1)[0]
            _target8 = os.path.normpath(os.path.join(
                os.path.dirname(_rel8), _spec8.replace('/', os.sep)))
            _n_imports8 += 1
            if any(os.path.exists(os.path.join(PROJ, _target8 + _e)) for _e in _EXT8):
                continue
            _n_bad8 += 1
            ctx.bad += 1
            print('✗ 相对导入不存在：%s → %s' % (_rel8, _m8.group(2)))
if _n_bad8:
    print('  （相对导入：%d 条检查 / %d 条不存在）' % (_n_imports8, _n_bad8))
else:
    print('✓ %-42s %d 条相对导入全部存在' % ('相对导入', _n_imports8))

