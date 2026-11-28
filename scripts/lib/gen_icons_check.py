# -*- coding: utf-8 -*-
import os

from PIL import Image

from gen_icons_js import emit_js
from gen_icons_spec import (
    ACCENT_ICONS, DARK_ICONS, ICONS, ICON_DIR, icon_files, icon_want_color,
)

def check(out_px):
    ok = True
    n_files = sum(len(icon_files(k)) for k, _, _, _ in ICONS)
    print('—— 自检（%d 个图标 / %d 个文件，源图 %dpx）——' % (len(ICONS), n_files, out_px))
    boxes = {}
    for key, name, style, open_paths in ICONS:
        for fname in icon_files(key):
            stem = fname[:-len('.png')]
            path = os.path.join(ICON_DIR, fname)
            if not os.path.exists(path):
                print('  ✗ %-22s 文件不存在' % fname); ok = False; continue
            img = Image.open(path).convert('RGBA')
            r, g, b, a = img.split()
            bbox = a.getbbox()
            cover = sum(a.histogram()[128:]) / float(out_px * out_px)
            want = icon_want_color(key, fname)
            wc = tuple(int(want[i:i + 2], 16) for i in (1, 3, 5))
            problems = []
            if img.size != (out_px, out_px):
                problems.append('尺寸 %dx%d' % img.size)
            if (r.getextrema(), g.getextrema(), b.getextrema()) != tuple((v, v) for v in wc):
                problems.append('颜色不是 %s' % want)
            if bbox is None:
                problems.append('整幅全透明')
            else:
                if not (0.01 <= cover <= 0.70):
                    problems.append('覆盖率 %.1f%% 异常' % (cover * 100))
                if bbox[0] < 1 or bbox[1] < 1 or bbox[2] > out_px - 1 or bbox[3] > out_px - 1:
                    problems.append('内容触边 bbox=%s' % (bbox,))
                boxes[stem] = bbox
            if problems:
                print('  ✗ %-22s %s' % (fname, '；'.join(problems))); ok = False
            else:
                print('  ✓ %-22s bbox=%-16s 覆盖率 %4.1f%%' % (fname, boxes[stem], cover * 100))

    # like / liked 外沿必须对齐（收藏键是原地切换，跳大小非常显眼）—— 拿默认（红）那份比
    if 'icon-like' in boxes and 'icon-liked-red' in boxes:
        diff = max(abs(p - q) for p, q in zip(boxes['icon-like'], boxes['icon-liked-red']))
        print('  %s like/liked 外沿最大差 %dpx' % ('✓' if diff <= 1 else '✗', diff))
        ok = ok and diff <= 1

    # 同一图标的不同主题色变体只应差颜色：外沿（alpha bbox）必须逐像素一致
    for key in ACCENT_ICONS:
        bs = [boxes[f[:-len('.png')]] for f in icon_files(key) if f[:-len('.png')] in boxes]
        if len(bs) < 2:
            continue
        diff = max(max(abs(p - q) for p, q in zip(a, b)) for a in bs for b in bs)
        print('  %s %-6s %d 个主题色变体 外沿最大差 %dpx' % ('✓' if diff == 0 else '✗', key, len(bs), diff))
        ok = ok and diff == 0

    # skip-forward / skip-back 的竖条：专盯「填充模式吞掉开放路径」这个坑
    for key, x0, x1 in (('next', 19.0, 23.0), ('prev', 1.0, 5.0)):
        path = os.path.join(ICON_DIR, 'icon-%s.png' % key)
        if not os.path.exists(path):
            continue
        a = Image.open(path).convert('RGBA').split()[3]
        band = a.crop((int(x0 * out_px / 24.0), 0, int(x1 * out_px / 24.0), out_px))
        n = sum(band.histogram()[128:])
        print('  %s %-6s 竖条区不透明像素 %d' % ('✓' if n > 0 else '✗', key, n))
        ok = ok and n > 0

    # 清单契约：ACCENT_ICONS / DARK_ICONS 里的 key 必须在 ICONS 表里（漏了会静默少图）
    keyset = {k for k, _, _, _ in ICONS}
    stray = [k for k in list(ACCENT_ICONS) + list(DARK_ICONS) if k not in keyset]
    if stray:
        print('  ✗ ACCENT_ICONS/DARK_ICONS 里有不在 ICONS 表里的 key：%s' % ', '.join(stray)); ok = False
    else:
        print('  ✓ 主题色/深色清单的 key 都在 ICONS 表里')

    
    # icons.js 是纯生成物，必须与生成器**逐字节**一致（手改、或改了上面的表忘了 --emit-js，都会在这里被拦下）
    js = os.path.join(ICON_DIR, 'icons.js')
    if os.path.exists(js):
        with open(js, 'r', encoding='utf-8') as f:
            src = f.read()
        want = emit_js()
        if src == want:
            print('  ✓ icons.js 与生成器逐字节一致（%d 个 key / %d 个 import）'
                  % (len(ICONS), sum(len(icon_files(k)) for k, _, _, _ in ICONS)))
        else:
            sl, wl = src.split('\n'), want.split('\n')
            n = min(len(sl), len(wl))
            first = next((i for i in range(n) if sl[i] != wl[i]), n)
            print('  ✗ icons.js 与生成器不一致（首个差异第 %d 行）：' % (first + 1))
            print('      文件：%s' % (sl[first] if first < len(sl) else '<EOF>'))
            print('      生成：%s' % (wl[first] if first < len(wl) else '<EOF>'))
            print('      修复：python scripts/gen_icons.py --emit-js')
            ok = False

    # 孤儿 PNG：只报告不删（无版本控制的工作区不做破坏性默认）
    known = {f for k, _, _, _ in ICONS for f in icon_files(k)} | {'icons.js'}
    orphans = sorted(f for f in os.listdir(ICON_DIR) if f.endswith('.png') and f not in known)
    if orphans:
        print('  ! 图标目录里有不在表内的 PNG（未删除）：%s' % ', '.join(orphans))

    print('自检%s' % ('通过' if ok else '未通过'))
    return ok
