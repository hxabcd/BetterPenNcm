# -*- coding: utf-8 -*-
"""项目自检（只读）：主题/令牌约束、模板绑定、mixin 契约、导航路由表一致性、相对导入存在性。
用法：python scripts/theme_verify.py   （读 src/ 下的实际内容，只读不写）

八道检查各在 scripts/verify/check*.py，本文件只按顺序跑完并汇总退出码。
"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'verify'))

import ctx
import check1_needles      # noqa: E402
import check2_symbols      # noqa: E402
import check4_template     # noqa: E402
import check5_tokens       # noqa: E402
import check6_nav          # noqa: E402
import check7_layers       # noqa: E402
import check8_imports      # noqa: E402

print()
print('结果：%s（%d 处待修%s）' % ('全部到位' if not ctx.bad else '有缺口', ctx.bad,
                                  '' if not ctx.warns else '，%d 处警示' % len(ctx.warns)))
sys.exit(1 if ctx.bad else 0)