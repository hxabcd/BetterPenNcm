# -*- coding: utf-8 -*-
"""第七道：分层方向校验（目录前缀 → 目录前缀的 import 边表，R1-R6）。"""
import io
import os
import re
import sys
import glob
import glob as _glob

import ctx
from ctx import CHECKS, PROJ

# ---- 第七道：分层方向校验（目录前缀 → 目录前缀的 import 边表）----
# 轴定义见 _AXIS_OF，_DIR_RULES 是「每个轴允许 import 的目标轴集合」（R1-R6，违例即自检失败）：
#   components 明确允许 → services（域组件编码域知识），但 chrome/ 追加禁止 → services（chrome 是跨应用框架候选）；
#   core 内 platform → infra 限 log.js（万能底座，平台适配层也打日志）；其余 core→core 跨目录禁止。
# 豁免清单：一行一条 (文件, 说明符)。出现新违例要么改代码，要么带理由登记。
LAYER_EXEMPT = {

    
    # 启动序列是全应用的装配点（建目录/开库/灌会话/换肤广播），引域模块装配是它的职责；
    # 这不是「infra 依赖业务」，而是 boot 的域外装配身份 —— 保持集中，不往下拆
    ('src/core/infra/boot.js', '../../ui/theme.js'),
    ('src/core/infra/boot.js', '../../services/player/player.js'),
    ('src/core/infra/boot.js', '../../services/player/history.js'),
    ('src/core/infra/boot.js', '../../services/player/locallists.js'),
    ('src/core/infra/boot.js', '../../services/ncm/login.js'),

    
    # 下载对账/续传是启动序列的一部分：退出时没下完的 .part 要在页面读下载列表前转正，
    # 缺元数据的条目要就地补。同上面的 locallists 一样属于 boot 的域外装配职责。
    ('src/core/infra/boot.js', '../../services/player/download.js'),
}

_AXIS_OF = (
    ('pages/', 'pages'),
    ('components/chrome/', 'chrome'),
    ('components/', 'components'),
    ('ui/mixins/', 'ui'),
    ('ui/', 'ui'),
    ('services/', 'services'),
    ('core/infra/', 'infra'),
    ('core/platform/', 'platform'),
)

def _axis(rel):
    for prefix, name in _AXIS_OF:
        if rel.startswith(prefix):
            return name
    # assets / styles / vendor / app.js 不参与分层
    return None  

_DIR_RULES = {

    # 允许的目标轴集合；None/自己 = 不跨轴（资源除外，另行放行）
    'pages': {'pages', 'components', 'chrome', 'ui', 'services', 'infra', 'platform'},
    'components': {'components', 'chrome', 'ui', 'services', 'infra', 'platform'},
    'chrome': {'chrome', 'ui', 'infra', 'platform'},
    'ui': {'ui', 'infra', 'platform'},
    'services': {'services', 'infra', 'platform'},
    'infra': {'infra', 'platform'},
    'platform': {'platform', 'infra'},
}

_SPEC_RE7 = re.compile(r"""(?:\bfrom|\bimport)\s*(['"])(\.[^'"]+)\1""")
_dir_bad = []
_dir_seen = set()
for _base7 in ('src/pages', 'src/components', 'src/ui', 'src/services', 'src/core'):
    for _p7 in _glob.glob(os.path.join(PROJ, _base7, '**', '*.js'), recursive=True) + \
               _glob.glob(os.path.join(PROJ, _base7, '**', '*.vue'), recursive=True):
        _rel7 = os.path.relpath(_p7, PROJ).replace('\\', '/')
        _src7 = os.path.relpath(_p7, os.path.join(PROJ, 'src')).replace('\\', '/')
        _from = _axis(_src7)
        if not _from:
            continue
        _t7 = io.open(_p7, encoding='utf-8').read()
        _t7 = re.sub(r'/\*.*?\*/', '', _t7, flags=re.S)
        _t7 = re.sub(r'^\s*//.*$', '', _t7, flags=re.M)
        for _m7 in _SPEC_RE7.finditer(_t7):
            _spec7 = _m7.group(2)
            if '?base64' in _spec7:
                continue
            _tgt7 = os.path.normpath(os.path.join(
                os.path.dirname(_src7.replace('/', os.sep)) or '.',
                _spec7.replace('/', os.sep))).replace(os.sep, '/')
            _to = _axis(_tgt7)
            if not _to or _to == _from:
                continue
            if _to in _DIR_RULES.get(_from, ()):
                continue
            _pair = (_from, _to, _rel7, _spec7)
            if _pair in _dir_seen:
                continue
            _dir_seen.add(_pair)
            _dir_bad.append(_pair)

_allowed_exempt = set()
for _f, _to, _rel, _spec in _dir_bad:
    if (_rel, _spec) in LAYER_EXEMPT:
        _allowed_exempt.add((_rel, _spec))
for _f, _to, _rel, _spec in _dir_bad:
    if (_rel, _spec) not in _allowed_exempt:
        ctx.bad += 1
        print('✗ 分层方向违例：%s (%s) → %s  [%s → %s]' % (_rel, _spec, _to.upper(), _f, _to))
if _dir_bad:
    _n_ok = len([1 for _f, _t, _r, _s in _dir_bad if (_r, _s) in LAYER_EXEMPT])
    print('  （分层边：%d 条合法豁免 / %d 条违例）' % (_n_ok, len(_dir_bad) - _n_ok))
else:
    print('✓ %-42s 0 处方向违例（R1-R6）' % '分层方向')

