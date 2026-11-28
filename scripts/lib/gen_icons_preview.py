# -*- coding: utf-8 -*-
import os

from PIL import Image, ImageDraw, ImageFont

from gen_icons_spec import ICONS, ICON_DIR, SHEET, default_icon

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PAGE_BG = (15, 15, 17)        
BTN_BG = (35, 36, 40)         
ACCENT = (229, 66, 60)        

def blend(fg, bg, k):
    return tuple(int(round(f * k + b * (1 - k))) for f, b in zip(fg, bg))

def preview(out_px):
    """1 图像像素 = 1 设备像素。三列按钮底取自 NavRail：默认 / 选中态 / danger。"""
    on_bg = blend(ACCENT, BTN_BG, 0.18)     
    cw, ch, pad, top = 128, 96, 14, 46

    # 表头只用 ASCII：PIL 自带字体没有中文字形
    cols = ['key', 'old 24px', 'new 24px', 'new on-state', 'new danger', 'new 24px x3', 'new 13px']
    W = pad * 2 + cw * len(cols)
    H = top + ch * len(ICONS) + pad
    sheet = Image.new('RGB', (W, H), PAGE_BG)
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=15)
    except TypeError:                       
        # 老 Pillow 没有 size 参数
        font = ImageFont.load_default()
    for i, c in enumerate(cols):
        d.text((pad + cw * i + 8, 16), c, fill=(200, 200, 208), font=font)

    for row, (key, name, style, open_paths) in enumerate(ICONS):
        y = top + row * ch
        new = Image.open(os.path.join(ICON_DIR, default_icon(key))).convert('RGBA')
        d.text((pad + 8, y + ch // 2 - 8), key, fill=(185, 185, 192), font=font)
        x = pad + cw

        def btn(w, ox, oy, bg, outline=None):
            d.rounded_rectangle([x + ox, y + oy, x + ox + w, y + oy + w],
                                radius=int(w * 0.3), fill=bg,
                                outline=outline, width=1 if outline else 0)

        old_p = os.path.join(HERE, '_backup', 'handdrawn_png', 'icon-%s.png' % key)
        if os.path.exists(old_p):
            old = Image.open(old_p).convert('RGBA').resize((24, 24), Image.LANCZOS)
            btn(53, 16, 21, BTN_BG)
            sheet.paste(old, (x + 30, y + 35), old)
        x += cw
        for bg, outline in ((BTN_BG, None), (on_bg, ACCENT), (ACCENT, None)):
            btn(53, 16, 21, bg, outline)
            ic = new.resize((24, 24), Image.LANCZOS)
            sheet.paste(ic, (x + 30, y + 35), ic)
            x += cw

        # 24px 渲染结果放大 3 倍（NEAREST）：看真实显示尺寸下的抗锯齿与笔画粗细
        d.rectangle([x, y + 12, x + 72, y + 12 + 72], fill=BTN_BG)
        big = new.resize((24, 24), Image.LANCZOS).resize((72, 72), Image.NEAREST)
        sheet.paste(big, (x, y + 12), big)
        x += cw
        btn(34, 26, 31, BTN_BG)
        sm = new.resize((13, 13), Image.LANCZOS)
        sheet.paste(sm, (x + 36, y + 41), sm)

    os.makedirs(os.path.dirname(SHEET), exist_ok=True)
    sheet.save(SHEET)
    print('对照图 → %s（%dx%d，1 像素 = 1 设备像素）' % (SHEET, W, H))
