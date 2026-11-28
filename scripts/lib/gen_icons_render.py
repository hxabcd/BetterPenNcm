# -*- coding: utf-8 -*-
import io
import os
import re
import subprocess
import sys
import urllib.request

from PIL import Image

from gen_icons_spec import (
    COLORS, DARK_FG, DARK_ICONS, ELEM_RE, ACCENT_ICONS, ACCENTS, ICONS, ICON_DIR,
    INK_SCALE, LUCIDE_URL, LUCIDE_VERSION, MAGICK, ROOT_RE, STROKE, VENDOR_DIR,
    WHITE,
)

def die(msg):
    sys.exit('错误：%s' % msg)

def fmt(v):
    return '%g' % v

def build_svg(raw, key, name, style, open_paths, out_px, color):
    """Lucide 原件 → 目标尺寸 / 目标颜色 / 目标线宽的 SVG 文本。

    key 只用来查 INK_SCALE（墨迹缩放）；name 是 lucide 名，只用于报错信息。
    返回 (svg 文本, 被填充的形状数, 保持描边的形状数)。"""
    m = ROOT_RE.search(raw)
    if not m:
        die('%s.svg 里找不到根 <svg> 标签' % name)
    root = m.group(0)
    if root.count('stroke-width=') != 1:
        die('%s.svg 根标签的 stroke-width 出现 %d 次（预期 1）：属性结构变了，请人工核对'
            % (name, root.count('stroke-width=')))
    new_root = (root
                .replace('width="24"', 'width="%d"' % out_px, 1)
                .replace('height="24"', 'height="%d"' % out_px, 1)
                .replace('stroke-width="2"', 'stroke-width="%s"' % fmt(STROKE), 1)
                .replace('currentColor', color))
    body = raw[m.end():]
    n_fill = n_stroke = 0
    if style != 'stroke':
        keep_stroke = (style == 'fill-align')
        # 形状分类：以 z 结尾 = 闭合；不以 z 结尾但首尾同点（SVG 填充时隐式闭合，如 heart）也算闭合；
        # line / polyline 没有面积只能描边；open_paths 里显式列出的开放路径必须保留描边（否则竖条被填没）。
        out, pos = [], 0
        for em in ELEM_RE.finditer(body):
            tag, el = em.group(1), em.group(0)
            d = re.search(r'\bd="([^"]*)"', el)
            if d:
                d = d.group(1).strip()
                if d in open_paths:
                    cls = 'stroke'          
                else:

                    cls = 'fill'
            elif tag in ('rect', 'circle', 'ellipse', 'polygon'):
                cls = 'fill'
            else:                           
                cls = 'stroke'
            if cls == 'fill':
                n_fill += 1
                el = el[:-2] + ' fill="%s"%s/>' % (color, '' if keep_stroke else ' stroke="none"')
            else:
                n_stroke += 1
            out.append(body[pos:em.start()])
            out.append(el)
            pos = em.end()
        out.append(body[pos:])
        body = ''.join(out)
        if n_fill == 0:
            die('%s 是 %s 样式，但一个可填充的形状都没找到（素材或规则变了）' % (name, style))
    scale = INK_SCALE.get(key)
    if scale and scale != 1.0:

        

        

        

        # ⚠ 缩放坐标系数值是 **24**（根标签 viewBox="0 0 24 24"，改的只是 width/height）→ 中心是 12，
        #   不是 out_px/2=36；写 36 会把图形推到画布右下角外面去。
        # ⚠ body 是「根标签之后的全部内容」，**包含收尾的 </svg>**：包装层必须插在 </svg> 之前，
        #   否则 <g> 跑到 svg 外面，librsvg 直接报 "unable to read image data"；
        #   且 g 放最前、</g> 紧贴 </svg> 之前（插到末尾就得到一个空组，PNG 看着一点没变）。
        c = 12.0
        g = ('<g transform="translate(%s %s) scale(%s) translate(%s %s)">'
             % (fmt(c), fmt(c), fmt(scale), fmt(-c), fmt(-c)))
        i = body.rfind('</svg>')

        
        body = (g + body[:i] + '</g>' + body[i:]) if i >= 0 else (g + body + '</g>')
    return raw[:m.start()] + new_root + body, n_fill, n_stroke

def rasterize(svg_text):
    p = subprocess.run(
        [MAGICK,
         '-background', 'none',          
         'svg:-',
         '-depth', '8',                  
         '-define', 'png:color-type=6',
         'png:-'],
        input=svg_text.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0 or not p.stdout:
        die('magick 渲染失败（返回码 %d）：%s'
            % (p.returncode, p.stderr.decode('utf-8', 'replace')[:400]))
    return Image.open(io.BytesIO(p.stdout)).convert('RGBA')

def magick_check():
    """启动自检：渲一个 8px 白方块，确认 magick 在、SVG 委托正常、alpha 没丢。"""
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">'
           '<rect x="0" y="0" width="8" height="8" fill="#FFFFFF"/></svg>')
    try:
        img = rasterize(svg)
    except OSError as e:
        die('找不到 `%s`（需要 ImageMagick 7）。装好后重试，或用环境变量指定：\n'
            '  MAGICK=/path/to/magick python scripts/gen_icons.py\n  底层错误：%s' % (MAGICK, e))
    r, g, b, a = img.split()
    if img.size != (8, 8) or a.getextrema() != (255, 255) or r.getextrema() != (255, 255):
        die('magick 自检失败：SVG 渲染不出白块（可能缺 SVG 委托）。自查：\n'
            '  %s -version\n  %s -list format | grep -i svg      # 应看到 SVG rw+（librsvg 委托）'
            % (MAGICK, MAGICK))

def tint(img, color):
    """把 RGB 全部刷成目标颜色，只保留 alpha（默认纯白）。

    两个作用：① 平台不能给 <image> 染色，图标什么颜色就得生成什么颜色；
    ② 抹平 librsvg 在边缘的预乘舍入（如 (254,254,254,254)），否则设备上描边会发灰。
    注意：刷色之后 Image.getbbox() 会返回整幅图（RGB 处处非零），量外沿必须用 alpha 通道。"""
    r, g, b = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    a = img.split()[3]
    return Image.merge('RGBA', (Image.new('L', img.size, r),
                                Image.new('L', img.size, g),
                                Image.new('L', img.size, b), a))

def svg_path(name):
    return os.path.join(VENDOR_DIR, name + '.svg')

def fetch(name):
    url = LUCIDE_URL % name
    print('  拉取 %s' % url)
    req = urllib.request.Request(url, headers={'User-Agent': 'betterpenncm-gen-icons'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode('utf-8')
    except Exception as e:
        die('下载 %s 失败：%s' % (url, e))
    if 'lucide-static v' not in text:
        die('%s 的内容不像 lucide-static 的图标（被重定向到别处了？）' % url)
    os.makedirs(VENDOR_DIR, exist_ok=True)
    with open(svg_path(name), 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    return text

def load_vendor(name, mode):
    path = svg_path(name)
    if mode == 'force' or not os.path.exists(path):
        if mode == 'never':
            die('缺少 %s（去掉 --no-fetch 会自动拉取）' % path)
        fetch(name)
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    if 'viewBox="0 0 24 24"' not in raw:
        die('%s 不是 24 栅格的 Lucide 图标（viewBox 变了？）' % path)
    return raw

def generate(out_px, fetch_mode):
    os.makedirs(ICON_DIR, exist_ok=True)
    magick_check()
    total = 0
    n_files = 0
    for key, name, style, open_paths in ICONS:
        raw = load_vendor(name, fetch_mode)

        if key in ACCENT_ICONS:
            variants = [('-' + ak, c) for ak, c in ACCENTS]
        elif key in DARK_ICONS:

            variants = [('', COLORS.get(key, WHITE)), ('-dark', DARK_FG)]
        else:
            variants = [('', COLORS.get(key, WHITE))]
        for suffix, color in variants:
            svg, n_fill, n_stroke = build_svg(raw, key, name, style, open_paths, out_px, color)
            img = tint(rasterize(svg), color)
            if img.size != (out_px, out_px):
                die('%s 渲染出 %dx%d，预期 %dx%d' % (key + suffix, img.size[0], img.size[1], out_px, out_px))
            path = os.path.join(ICON_DIR, 'icon-%s%s.png' % (key, suffix))
            img.save(path, 'PNG', optimize=True)
            n = os.path.getsize(path)
            total += n
            n_files += 1
            tag = '' if style == 'stroke' else '   [%s：填充 %d / 描边 %d]' % (style, n_fill, n_stroke)
            if color != WHITE:
                tag += '   [着色 %s]' % color
            print('  %-26s %5d B%s' % (os.path.basename(path), n, tag))
    print('%d 个图标 / %d 个文件（Lucide %s，%dpx，线宽 %s），合计 %.1f KB → %s'
          % (len(ICONS), n_files, LUCIDE_VERSION, out_px, fmt(STROKE), total / 1024.0, ICON_DIR))
