# -*- coding: utf-8 -*-
"""S1 一次性 import 改写工具（用后即删，不留在 scripts/）。

按 docs/目录与分层重构方案.md §3a：解析每条 import/export-from 的说明符为
src 内绝对路径，命中 MOVE_MAP 就按新位置改写相对路径。

要求（§3a）：① 幂等（重跑零 diff）；② 输出改写报告（每文件改动数 / 每规则
命中数 / 剩余 utils/ import 必须为 0）；③ 不改动态 import（本工程动态 import
全是裸模块，解析器遇到不以 ./ 或 ../ 开头的说明符直接跳过）。

用法：
  python scripts/reimport.py --batch 1   # services 轴（ncm/player/cover/songact/media）
  python scripts/reimport.py --batch 2   # core + ui 轴（其余）
  python scripts/reimport.py --batch 12  # 两批一起（校验幂等时用）
"""
import io
import os
import re
import sys
from collections import defaultdict

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.normpath(os.path.join(HERE, '..'))
SRC = os.path.join(PROJ, 'src')

# 旧路径（相对 src/，POSIX 形式）→ 新路径。与方案附录 B 完全一致。
# S1 的过渡决策：multidl.js 整文件先落 ui/dlselect.js（S3 才拆业务函数）；
# theme.js 整移（accent 拆分在 S3）；dlvis 暂留 services/player（S3 改造）。
MOVE_MAP = {
    # ---- core/infra ----
    'boot.js': 'core/infra/boot.js',
    'config.js': 'core/infra/config.js',
    'format.js': 'core/infra/format.js',
    'events.js': 'core/infra/events.js',
    'log.js': 'core/infra/log.js',
    'nav.js': 'core/infra/nav.js',
    'paths.js': 'core/infra/paths.js',
    'store.js': 'core/infra/store.js',
    'util.js': 'core/infra/util.js',
    'buildInfo.js': 'core/infra/buildInfo.js',
    'logconfig.generated.js': 'core/infra/logconfig.generated.js',
    'net/request.js': 'core/infra/net/request.js',
    'net/cookies.js': 'core/infra/net/cookies.js',
    'net/status.js': 'core/infra/net/status.js',
    # ---- core/platform ----
    'exec.js': 'core/platform/exec.js',
    'fsutil.js': 'core/platform/fsutil.js',
    'systemKeyboard.js': 'core/platform/systemKeyboard.js',
    'touch.js': 'core/platform/touch.js',
    'db.js': 'core/platform/db.js',
    # ---- ui（mixins + 提升）----
    'rail.js': 'ui/rail.js',
    'theme.js': 'ui/theme.js',
    'multidl.js': 'ui/dlselect.js',
    'ui/frame.js': 'ui/mixins/frame.js',
    'ui/toast.js': 'ui/mixins/toast.js',
    'ui/arm.js': 'ui/mixins/arm.js',
    'ui/multi.js': 'ui/mixins/multi.js',
    'ui/pagebus.js': 'ui/mixins/pagebus.js',
    'ui/infinite.js': 'ui/mixins/infinite.js',
    'ui/tokens.js': 'ui/tokens.js',
    'ui/vis.js': 'ui/vis.js',
    'ui/paging.js': 'ui/paging.js',
    # ---- services/ncm ----
    'ncm/api.js': 'services/ncm/api.js',
    'ncm/comments.js': 'services/ncm/comments.js',
    'ncm/crypto.js': 'services/ncm/crypto.js',
    'ncm/like.js': 'services/ncm/like.js',
    'ncm/login.js': 'services/ncm/login.js',
    'ncm/playlist.js': 'services/ncm/playlist.js',
    'ncm/recommend.js': 'services/ncm/recommend.js',
    'ncm/subscribe.js': 'services/ncm/subscribe.js',
    'ncm/weapi.js': 'services/ncm/weapi.js',
    'ncm/wecurl.js': 'services/ncm/wecurl.js',
    # ---- services/player ----
    'player/cache.js': 'services/player/cache.js',
    'player/dlorigin.js': 'services/player/dlorigin.js',
    'player/dlvis.js': 'services/player/dlvis.js',
    'player/download.js': 'services/player/download.js',
    'player/engine/clock.js': 'services/player/engine/clock.js',
    'player/engine/index.js': 'services/player/engine/index.js',
    'player/engine/soundplayer.js': 'services/player/engine/soundplayer.js',
    'player/fetcher.js': 'services/player/fetcher.js',
    'player/files.js': 'services/player/files.js',
    'player/history.js': 'services/player/history.js',
    'player/layout.js': 'services/player/layout.js',
    'player/locallists.js': 'services/player/locallists.js',
    'player/localmeta.js': 'services/player/localmeta.js',
    'player/lyric.js': 'services/player/lyric.js',
    'player/lyriclayout.js': 'services/player/lyriclayout.js',
    'player/player.js': 'services/player/player.js',
    'player/progress.js': 'services/player/progress.js',
    'player/quality.js': 'services/player/quality.js',
    'player/scheduler.js': 'services/player/scheduler.js',
    'player/session.js': 'services/player/session.js',
    'player/sig.js': 'services/player/sig.js',
    'player/sleeptimer.js': 'services/player/sleeptimer.js',
    'player/sound.js': 'services/player/sound.js',
    'player/source.js': 'services/player/source.js',
    'player/tasks.js': 'services/player/tasks.js',
    # ---- services/cover + 域胶水 ----
    'cover.js': 'services/cover/cover.js',
    'coverColor.js': 'services/cover/color.js',
    'artistavatar.js': 'services/cover/artistavatar.js',
    'artistmeta.js': 'services/cover/artistmeta.js',
    'songact.js': 'services/player/acts.js',
    'media.js': 'services/player/media.js',
}

# 批次划分：批 1 = services 轴，批 2 = core + ui 轴（§6 S1）
BATCH1_NEW_PREFIXES = ('services/',)
BATCH2_NEW_PREFIXES = ('core/', 'ui/')

# 只处理 import / export-from 语句里的字符串说明符。
# 说明符模式：'...' 或 "..."（本工程 import 全用单引号，双引号兜底）。
SPEC_RE = re.compile(
    r"""(?P<kw>\b(?:import|from)\s*)(?P<q>['"])(?P<spec>\.[-.\w/]*(?:\.js|\.vue|\.png[^'"]*)?)(?P=q)"""
)


def iter_src_files():
    for base, _dirs, files in os.walk(SRC):
        for fn in files:
            if fn.endswith(('.js', '.vue')):
                yield os.path.join(base, fn)


def rel_posix(p):
    return os.path.relpath(p, SRC).replace('\\', '/')


def resolve(importer_rel, spec):
    """说明符 → src 内绝对路径（POSIX 相对 src/）或 None（裸模块/出 src）。"""
    base = os.path.dirname(importer_rel.replace('/', os.sep))
    target = os.path.normpath(os.path.join(base, spec.replace('/', os.sep)))
    target = target.replace(os.sep, '/')
    if target.startswith('../') or target == '..':
        return None  # 跳出 src（本工程不存在，防御）
    return target


def rewrite_spec(importer_rel, spec):
    """返回 (新说明符, 命中的旧键) 或 None。"""
    target = resolve(importer_rel, spec)
    if not target:
        return None
    old_key = target[len('utils/'):] if target.startswith('utils/') else target
    if old_key not in MOVE_MAP:
        return None
    new_rel = MOVE_MAP[old_key]
    depth = importer_rel.count('/') + 1
    up = '../' * depth
    return up + new_rel, old_key


def rewrite_file(path, batch):
    text = io.open(path, encoding='utf-8', newline='').read()
    rel = rel_posix(path)
    allowed = BATCH1_NEW_PREFIXES + BATCH2_NEW_PREFIXES
    prefixes = (allowed if batch == 12 else
                (BATCH1_NEW_PREFIXES if batch == 1 else BATCH2_NEW_PREFIXES))
    count = 0
    rules = defaultdict(int)

    def sub(m):
        nonlocal count
        r = rewrite_spec(rel, m.group('spec'))
        if not r:
            return m.group(0)
        new_spec, old_key = r
        if not MOVE_MAP[old_key].startswith(prefixes):
            return m.group(0)
        count += 1
        rules['%s -> %s' % (old_key, MOVE_MAP[old_key])] += 1
        return m.group('kw') + m.group('q') + new_spec + m.group('q')

    new_text = SPEC_RE.sub(sub, text)
    if count:
        io.open(path, 'w', encoding='utf-8', newline='').write(new_text)
    return count, rules


def main():
    batch = 12
    for arg in sys.argv[1:]:
        if arg == '--batch':
            continue
        batch = int(arg)
    total = 0
    per_rule = defaultdict(int)
    per_file = {}
    for path in iter_src_files():
        n, rules = rewrite_file(path, batch)
        if n:
            per_file[rel_posix(path)] = n
            total += n
            for k, v in rules.items():
                per_rule[k] += v
    print('改写 %d 处 import，涉及 %d 个文件' % (total, len(per_file)))
    for f in sorted(per_file):
        print('  %-52s %d 处' % (f, per_file[f]))
    print('--- 每条规则命中 ---')
    for k in sorted(per_rule):
        print('  %-58s %d' % (k, per_rule[k]))
    # 剩余 utils/ import 检查（§3a ③）：必须为 0
    leftover = []
    for path in iter_src_files():
        text = io.open(path, encoding='utf-8').read()
        for m in SPEC_RE.finditer(text):
            t = resolve(rel_posix(path), m.group('spec'))
            if t and (t.startswith('utils/') or t == 'utils'):
                leftover.append('%s: %s' % (rel_posix(path), m.group('spec')))
    if leftover:
        print('✗ 仍有 %d 处 utils/ import 未改写：' % len(leftover))
        for s in leftover:
            print('  ' + s)
        return 1
    print('✓ 剩余 utils/ import = 0')
    return 0


if __name__ == '__main__':
    sys.exit(main())
