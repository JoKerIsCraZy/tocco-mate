# -*- coding: utf-8 -*-
"""
Generiert PWA / Favicon / Apple-Touch-Icons aus web/assets/logo.png.
Apple-Touch (180x180) braucht einen blickdichten Hintergrund (sonst zeigt iOS Schwarz).
Maskable-Icon (512) braucht "Safe-Zone": Logo nur in inneren ~80%.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, "web", "assets", "logo.png")
OUT  = os.path.join(ROOT, "web", "assets")

BG_COLOR = (15, 17, 21, 255)  # --bg aus Dashboard (#0f1115)

def fit_into(canvas_size, scale=0.78):
    """Skaliert das Original so, dass es in canvas_size mit scale-Faktor passt."""
    src = Image.open(SRC).convert("RGBA")
    target = int(canvas_size * scale)
    src.thumbnail((target, target), Image.LANCZOS)
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    x = (canvas_size - src.width) // 2
    y = (canvas_size - src.height) // 2
    canvas.paste(src, (x, y), src)
    return canvas

def with_bg(img, bg=BG_COLOR):
    bg_img = Image.new("RGBA", img.size, bg)
    bg_img.alpha_composite(img)
    return bg_img.convert("RGB")

def write_png(img, name):
    path = os.path.join(OUT, name)
    img.save(path, "PNG", optimize=True)
    print("OK", name, img.size, os.path.getsize(path), "bytes")

def write_ico(name):
    src = Image.open(SRC).convert("RGBA")
    sizes = [(16,16), (32,32), (48,48), (64,64)]
    src.save(os.path.join(OUT, name), format="ICO", sizes=sizes)
    print("OK", name)

# Standard PWA icons (transparent backgrounds OK)
write_png(fit_into(192, scale=1.0), "icon-192.png")
write_png(fit_into(512, scale=1.0), "icon-512.png")

# Maskable icon (safe-zone) — Android adaptive icons
write_png(fit_into(512, scale=0.72), "icon-maskable-512.png")

# Apple Touch Icon — needs solid background (iOS won't honor transparency)
write_png(with_bg(fit_into(180, scale=0.82)), "apple-touch-icon.png")

# Favicons
write_png(fit_into(32, scale=1.0), "favicon-32.png")
write_png(fit_into(16, scale=1.0), "favicon-16.png")
write_ico("favicon.ico")
