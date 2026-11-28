# -*- coding: utf-8 -*-
"""
生成界面图标 PNG（src/assets/icon-*.png）—— 图标来源 Lucide 1.52.0（ISC 许可）。

为什么是「SVG 在 PC 端栅格化成 PNG」而不是运行时直接用 SVG：
  设备端唯一**已实证**的图标通道是 PNG data URI（`xxx.png?base64` 被 aiot-vue-cli 的
  rollup-plugins/image.js 内联成 `data:image/png;base64,…` 喂给 <image>；PenMusic、doge-reader
  与本项目三方印证）。`libfalcon.so` 里虽然带着 lunasvg，但从 <image> 到它的路由**没有任何证据**，
  且 aiot-cli 给 .svg 生成的 MIME 是非标准的 `image/svg`（缺 `+xml`）——所以 SVG 只是**设计来源**，
  不是运行时格式。

为什么用 magick 栅格化：
  本机 ImageMagick 7.1.2 的 SVG 委托是 librsvg 2.40.20，形状/圆头线帽/圆角实测全部正确，
  不必装任何新依赖。SVG 源已 vendor 到 scripts/lucide-svg/，**构建期不联网**。

三个坑（都踩过，别再踩）：
  1. `-background none` 必须写在输入 `svg:-` **之前**：写在后面会被当成「对已读入图像的操作」，
     结果是整张图变成不透明白底（图标全白块，且毫无报错）。
  2. `-depth 8` + `-define png:color-type=6` 必须成对：IM 是 Q16-HDRI，默认输出 16 位/通道，
     PIL 读出来会误判成全不透明。
  3. 实心样式**必须区分闭合形状与开放路径**：skip-forward 的竖条 `M21 4v16` 是开放路径，
      一刀切 `stroke="none"` 会把竖条**弄没**（实心三角还在，肉眼容易漏看）。所以每条开放路径
      都要在下面的 ICONS 表里显式列出（`open_paths`）。

主题色图标：
  平台不能给 <image> 染色，所以**跟着主题色变**的那几个图标（见 ACCENT_ICONS：
  首页三张文字卡的裸图标 + 播放页收藏态红心）要**每个预设色各出一份** PNG，
  文件名 icon-<key>-<accentKey>.png，运行时由 assets/icons.js 的 aIcon(key, accentKey) 取。
  色表 ACCENTS 必须与 src/ui/theme.js 的 ACCENTS 逐项对齐（key + c）；加/减主题色要**两处同时改**。

用法：
  python scripts/gen_icons.py                 # 生成（默认 72px，缺的 vendor SVG 自动拉取）
  python scripts/gen_icons.py --size 48       # 换源图尺寸（真机 A/B 用）
  python scripts/gen_icons.py --preview       # 生成 + PC 对照图 shots/icon-sheet.png
  python scripts/gen_icons.py --check         # 只自检、不写文件
  python scripts/gen_icons.py --fetch         # 强制重拉所有 vendor SVG（联网）
  python scripts/gen_icons.py --no-fetch      # 断网模式：缺文件直接报错
  python scripts/gen_icons.py --emit-js       # 按表重写 src/assets/icons.js（注册表唯一来源，
                                              #   该文件是纯生成物；--check 逐字节校验）

表与链在 scripts/lib/gen_icons_{spec,render,js,check,preview}.py。
"""
import argparse
import os
import sys

# Windows 控制台默认 GBK，打印 ✓/✗ 会 UnicodeEncodeError；统一成 UTF-8 输出
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))

from gen_icons_check import check      # noqa: E402
from gen_icons_js import emit_js       # noqa: E402
from gen_icons_preview import preview  # noqa: E402
from gen_icons_render import generate  # noqa: E402
from gen_icons_spec import ICON_DIR, OUT  # noqa: E402

def main():
    ap = argparse.ArgumentParser(description='Lucide SVG → 图标 PNG')
    ap.add_argument('--size', type=int, default=OUT, help='输出像素（默认 %d）' % OUT)
    ap.add_argument('--preview', action='store_true', help='生成 PC 对照图 shots/icon-sheet.png')
    ap.add_argument('--check', action='store_true', help='只自检，不写文件')
    ap.add_argument('--fetch', action='store_true', help='强制重拉所有 vendor SVG（联网）')
    ap.add_argument('--no-fetch', action='store_true', help='断网：缺 vendor 文件直接报错')
    ap.add_argument('--emit-js', action='store_true', help='按表重写 src/assets/icons.js 后自检')
    args = ap.parse_args()

    if args.check:
        sys.exit(0 if check(args.size) else 1)
    if args.emit_js:
        js = os.path.join(ICON_DIR, 'icons.js')
        with open(js, 'w', encoding='utf-8', newline='\n') as f:
            f.write(emit_js())
        print('✓ 已按表重写 %s' % js)
        sys.exit(0 if check(args.size) else 1)
    generate(args.size, 'never' if args.no_fetch else ('force' if args.fetch else 'missing'))
    check(args.size)
    if args.preview:
        preview(args.size)

if __name__ == '__main__':
    main()
