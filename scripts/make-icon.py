#!/usr/bin/env python3
"""Build Agent Book's app icon, scripts/app-icon.png (1024x1024): the artwork (scripts/app-icon-art.png,
the "Magical Tome" from Thiings) on a dark rounded square, sized and padded like a standard macOS icon.
Needs Pillow.

    python3 scripts/make-icon.py            # dark grey (the default)
    python3 scripts/make-icon.py black      # black
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
S, SCALE = 1024, 4
W = S * SCALE
# macOS icon grid: an 824px rounded square centred in 1024.
MARGIN, SIZE, RADIUS = 100, 824, 185
BACKGROUNDS = {
    "grey": ((46, 48, 54), (22, 23, 26)),  # top and bottom of a vertical gradient
    "black": ((20, 20, 22), (2, 2, 3)),
}


def px(v: float) -> int:
    return round(v * SCALE)


def build(name: str) -> Image.Image:
    top, bottom = BACKGROUNDS[name]
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))

    # Soft drop shadow under the tile.
    shadow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([px(MARGIN), px(MARGIN + 14), px(MARGIN + SIZE), px(MARGIN + SIZE + 14)], px(RADIUS), fill=(0, 0, 0, 120))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(px(20))))

    # The tile: a vertical gradient inside a rounded square, with a faint top highlight and hairline edge.
    grad = Image.new("RGBA", (W, W))
    g = ImageDraw.Draw(grad)
    for y in range(W):
        t = y / (W - 1)
        g.line([(0, y), (W, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([px(MARGIN), px(MARGIN), px(MARGIN + SIZE), px(MARGIN + SIZE)], px(RADIUS), fill=255)
    img.paste(grad, (0, 0), mask)
    ImageDraw.Draw(img).rounded_rectangle([px(MARGIN), px(MARGIN), px(MARGIN + SIZE), px(MARGIN + SIZE)], px(RADIUS), outline=(255, 255, 255, 30), width=px(3))

    # The artwork, trimmed to its visible pixels and fitted to ~78% of the tile, centred.
    art = Image.open(HERE / "app-icon-art.png").convert("RGBA")
    art = art.crop(art.getchannel("A").getbbox())
    fit = px(SIZE * 0.78)
    k = fit / max(art.size)
    art = art.resize((round(art.width * k), round(art.height * k)), Image.LANCZOS)
    img.alpha_composite(art, (px(MARGIN + SIZE / 2) - art.width // 2, px(MARGIN + SIZE / 2) - art.height // 2 + px(6)))

    return img.resize((S, S), Image.LANCZOS)


if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "grey"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "app-icon.png"
    build(name).save(out)
    print(f"wrote {out} ({name})")
