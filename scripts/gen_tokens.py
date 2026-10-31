# -*- coding: utf-8 -*-
"""设计令牌生成 / 校验

唯一来源 = `src/utils/ui/tokens.js` 的 TOK 表；
生成物   = `src/styles/common.less` 里 `@tokens:begin` ~ `@tokens:end` 之间的令牌段。

用法：
    python scripts/gen_tokens.py           # 校验（默认）：生成物与值表逐条比对，不一致退 1
    python scripts/gen_tokens.py --write   # 按值表重写令牌段

两个方向的完整性也校验：
  - TOK 里每个 key 必须有 DESC（LESS 注释）与 LESS_NAME（=null 表示仅 JS 用）
  - LESS 段里不允许出现 TOK 之外的 token；文件其余位置只手写白名单里的 token（见 OUTSIDE）
"""
import io
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.normpath(os.path.join(HERE, '..'))
TOKENS_JS = os.path.join(PROJ, 'src', 'utils', 'ui', 'tokens.js')
LESS = os.path.join(PROJ, 'src', 'styles', 'common.less')

BEGIN_MARK = '/* @tokens:begin'
END_MARK = '/* @tokens:end */'
# 允许手写在生成段之外的文件级 token（书面默认值，真值在 utils/theme.js，故意不进值表）
OUTSIDE = ['accent', 'accent-2']
PAD = 40  # `@name: value;` 对齐到该列后接注释


def parse_tables():
    src = io.open(TOKENS_JS, encoding='utf-8').read()

    def flat(name):
        m = re.search(r'export const %s = \{(.*?)\n\}' % name, src, re.S)
        if not m:
            raise SystemExit('✗ %s 里找不到 %s 表' % (TOKENS_JS, name))
        out = {}
        for line in m.group(1).splitlines():
            mm = re.match(r"\s*(\w+):\s*'([^']*)'", line)
            if mm:
                out[mm.group(1)] = mm.group(2)
        return out

    tok = flat('TOK')
    desc = flat('DESC')
    names = {}
    m = re.search(r'export const LESS_NAME = \{(.*?)\n\}', src, re.S)
    if not m:
        raise SystemExit('✗ 找不到 LESS_NAME 表')
    for line in m.group(1).splitlines():
        mm = re.match(r"\s*(\w+):\s*(?:'([^']*)'|(null))", line)
        if mm:
            names[mm.group(1)] = mm.group(2) if mm.group(2) is not None else None
    return tok, desc, names


def render_block(tok, desc, names):
    lines = []
    for k, v in tok.items():
        less = names.get(k)
        if less is None:
            continue
        head = '@%s: %s;' % (less, v)
        lines.append((head.ljust(PAD) + '/* %s */' % desc.get(k, '')).rstrip())
    return lines


def read_block(text):
    lines = text.split('\n')
    b = e = None
    for i, ln in enumerate(lines):
        if b is None and ln.startswith(BEGIN_MARK):
            b = i
        elif b is not None and ln.strip() == END_MARK:
            e = i
            break
    if b is None or e is None:
        raise SystemExit('✗ common.less 里找不到 @tokens:begin/end 标记')
    return lines, b, e


def main():
    write = '--write' in sys.argv
    tok, desc, names = parse_tables()

    # 契约完整性：值表 / 说明 / LESS 名三表一一对应
    bad = []
    for k in tok:
        if k not in desc:
            bad.append('TOK 有 %s 但 DESC 没有' % k)
        if k not in names:
            bad.append('TOK 有 %s 但 LESS_NAME 没有（仅 JS 用请显式写 null）' % k)
    for k in list(desc) + list(names):
        if k not in tok:
            bad.append('DESC/LESS_NAME 里的 %s 不在 TOK 里' % k)
    if bad:
        print('✗ 值表契约不完整：')
        for b in bad:
            print('   - ' + b)
        return 1

    want = render_block(tok, desc, names)
    text = io.open(LESS, encoding='utf-8').read()
    lines, b, e = read_block(text)
    cur = [ln.rstrip() for ln in lines[b + 1:e]]

    # 段外 token 巡检：文件里出现的 @xxx: 定义，只允许生成段内 + 白名单
    outside_defined = set()
    for i, ln in enumerate(lines):
        if b < i < e:
            continue
        mm = re.match(r'^@([\w-]+)\s*:', ln)
        if mm:
            outside_defined.add(mm.group(1))
    strays = sorted(outside_defined - set(OUTSIDE))
    if strays:
        print('⚠ 段外的手写 token（不在白名单 %s 里）：%s' % (OUTSIDE, ', '.join(strays)))

    if cur == want:
        print('✓ 令牌段与值表一致（%d 个 token）' % len(want))
        return 0
    if write:
        out = lines[:b + 1] + want + lines[e:]
        io.open(LESS, 'w', encoding='utf-8', newline='').write('\n'.join(out))
        print('✓ 已按值表重写令牌段（%d 个 token）' % len(want))
        return 0

    print('✗ 令牌段与值表不一致（跑 --write 重写，或改回值表）：')
    only_file = [x for x in cur if x not in want]
    only_want = [x for x in want if x not in cur]
    for x in only_file:
        print('   文件独有: ' + x)
    for x in only_want:
        print('   值表要求: ' + x)
    return 1


if __name__ == '__main__':
    sys.exit(main())
