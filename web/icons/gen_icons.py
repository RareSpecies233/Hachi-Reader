#!/usr/bin/env python3
"""Hachi Reader — PWA 图标生成脚本

设计：暖纸色（#f6f1e7）底 + 朱红（#b4552d）的「蜜蜂 + 摊开的书页」极简符号。
Hachi 在日语里是「蜂」，所以主体画一只三段纹的蜜蜂，下面用一笔书页弧线呼应「阅读」。

生成：
  icon-180.png             iOS apple-touch-icon（iOS 会自己加圆角，不要预裁）
  icon-192.png / 512.png   manifest 的 purpose=any
  icon-192-maskable.png    manifest 的 purpose=maskable（四周留安全边距）
  icon-512-maskable.png

用法：
  python3 web/icons/gen_icons.py            # 输出到脚本所在目录
  python3 web/icons/gen_icons.py --out DIR  # 输出到指定目录

依赖：Pillow（pip3 install Pillow），macOS 也可用 brew install pillow 或系统 python3 -m pip。
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：python3 -m pip install Pillow")

# ---- 配色（与 web/css/base.css 的 --paper / --accent 保持一致）----
PAPER = (0xF6, 0xF1, 0xE7)
PAPER_DEEP = (0xEF, 0xE7, 0xD8)
VERMILION = (0xB4, 0x55, 0x2D)
VERMILION_DEEP = (0x8E, 0x3F, 0x20)
WING = (0xDF, 0xA0, 0x84)
WING_EDGE = (0xC4, 0x6B, 0x41)

SS = 4  # 超采样倍数：先按 4 倍画，再 LANCZOS 缩小，得到干净的边缘

# (文件名, 像素尺寸, 内容缩放, 是否 maskable)
TARGETS = [
    ("icon-180.png", 180, 0.92, False),
    ("icon-192.png", 192, 0.92, False),
    ("icon-512.png", 512, 0.92, False),
    ("icon-192-maskable.png", 192, 0.72, True),
    ("icon-512-maskable.png", 512, 0.72, True),
]


def bezier(p0, p1, p2, p3, steps=48):
    """三次贝塞尔采样。"""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def ellipse_points(cx, cy, rx, ry, angle_deg, steps=96):
    """旋转椭圆的轮廓点。"""
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        x = rx * math.cos(t)
        y = ry * math.sin(t)
        pts.append((cx + x * ca - y * sa, cy + x * sa + y * ca))
    return pts


class Mark:
    """把 0..1 的归一化坐标映射到超采样画布，方便用一个坐标系描述整套图形。"""

    def __init__(self, size: int, content_scale: float, y_offset: float = 0.0):
        self.size = size * SS
        self.k = content_scale
        self.dy = y_offset
        self.img = Image.new("RGB", (self.size, self.size), PAPER)
        self.d = ImageDraw.Draw(self.img)

    def p(self, x, y):
        s = self.size
        return ((x - 0.5) * self.k * s + s / 2,
                (y + self.dy - 0.5) * self.k * s + s / 2)

    def scale(self, v):
        return v * self.k * self.size

    def poly(self, pts, fill):
        self.d.polygon([self.p(x, y) for x, y in pts], fill=fill)

    def ellipse(self, cx, cy, rx, ry, fill, outline=None, width=0.0):
        x0, y0 = self.p(cx - rx, cy - ry)
        x1, y1 = self.p(cx + rx, cy + ry)
        w = max(1, round(self.scale(width))) if outline and width else 0
        self.d.ellipse([x0, y0, x1, y1], fill=fill, outline=outline, width=w)

    def stroke(self, pts, color, width, round_caps=True):
        """折线描边；Pillow 没有圆角端点，用两端补圆模拟。"""
        px = [self.p(x, y) for x, y in pts]
        w = max(1, round(self.scale(width)))
        self.d.line(px, fill=color, width=w, joint="curve")
        if round_caps:
            r = w / 2
            for (x, y) in (px[0], px[-1]):
                self.d.ellipse([x - r, y - r, x + r, y + r], fill=color)

    def paste_through(self, color, mask):
        """用 L 通道蒙版把颜色贴回去（画条纹用）。"""
        layer = Image.new("RGB", self.img.size, color)
        self.img.paste(layer, (0, 0), mask)
        self.d = ImageDraw.Draw(self.img)


def draw_mark(size: int, content_scale: float) -> Image.Image:
    # y_offset 把整体视觉重心微微上提：下方有书页"基线"，几何居中会显得偏沉
    m = Mark(size, content_scale, y_offset=-0.045)

    # ---- 书页弧线（先画，压在蜜蜂下方）----
    left_page = bezier((0.272, 0.750), (0.352, 0.786), (0.442, 0.795), (0.5, 0.826))
    right_page = bezier((0.728, 0.750), (0.648, 0.786), (0.558, 0.795), (0.5, 0.826))
    m.stroke(left_page, VERMILION, 0.0215)
    m.stroke(right_page, VERMILION, 0.0215)

    # ---- 翅膀（左右各一片，先画，让身体盖住内侧接缝）----
    left_wing = ellipse_points(0.383, 0.438, 0.094, 0.046, -148)
    right_wing = ellipse_points(0.617, 0.438, 0.094, 0.046, -32)
    m.poly(left_wing, WING)
    m.poly(right_wing, WING)
    # 翅膀外缘描一道深一点的边，缩小后仍有轮廓
    m.stroke(left_wing + [left_wing[0]], WING_EDGE, 0.009, round_caps=False)
    m.stroke(right_wing + [right_wing[0]], WING_EDGE, 0.009, round_caps=False)

    # ---- 身体 ----
    cx, cy, rx, ry = 0.5, 0.566, 0.082, 0.118
    m.ellipse(cx, cy, rx, ry, VERMILION)

    # ---- 两道纸色条纹：用身体椭圆与横条求交，避免条纹溢出轮廓 ----
    body_mask = Image.new("L", (m.size, m.size), 0)
    bd = ImageDraw.Draw(body_mask)
    bx0, by0 = m.p(cx - rx, cy - ry)
    bx1, by1 = m.p(cx + rx, cy + ry)
    bd.ellipse([bx0, by0, bx1, by1], fill=255)

    band_mask = Image.new("L", (m.size, m.size), 0)
    band_d = ImageDraw.Draw(band_mask)
    for band_y in (0.532, 0.604):
        h = 0.024 / 2
        x0, y0 = m.p(cx - rx - 0.02, band_y - h)
        x1, y1 = m.p(cx + rx + 0.02, band_y + h)
        band_d.rounded_rectangle([x0, y0, x1, y1], radius=round(m.scale(h)), fill=255)

    m.paste_through(PAPER, ImageChops.multiply(body_mask, band_mask))

    # ---- 头 + 触角 ----
    m.ellipse(0.5, 0.418, 0.052, 0.05, VERMILION)
    m.stroke(bezier((0.483, 0.379), (0.464, 0.352), (0.452, 0.339), (0.441, 0.324)),
             VERMILION_DEEP, 0.0145)
    m.stroke(bezier((0.517, 0.379), (0.536, 0.352), (0.548, 0.339), (0.559, 0.324)),
             VERMILION_DEEP, 0.0145)

    # ---- 收尾：书页内侧留一点高光，避免中间糊成一坨 ----
    m.poly([(0.493, 0.805), (0.5, 0.826), (0.507, 0.805)], PAPER_DEEP)

    return m.img


def main():
    ap = argparse.ArgumentParser(description="生成 Hachi Reader PWA 图标")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent), help="输出目录")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    for name, px, scale, maskable in TARGETS:
        big = draw_mark(px, scale)
        small = big.resize((px, px), Image.LANCZOS)
        path = out / name
        small.save(path, format="PNG", optimize=True)
        tag = " maskable" if maskable else ""
        print(f"  {path.name:<24} {px}x{px}{tag}  {path.stat().st_size / 1024:.1f} KB")

    print(f"完成，共 {len(TARGETS)} 个 PNG → {out}")


if __name__ == "__main__":
    main()
