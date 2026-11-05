"""Make the built-in wallpapers (src/assets/wallpapers/*.jpg): soft colour fields of a few large,
blurred light spots on a base colour. Run: python scripts/make-wallpapers.py (needs Pillow)."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

W, H = 1920, 1080
OUT = Path(__file__).resolve().parent.parent / "src" / "assets" / "wallpapers"

# id: base colour, then spots (x, y, radius as shares of the width; colour).
WALLPAPERS = {
    "aurora": ("#0b1026", [(0.2, 0.25, 0.45, "#1fd1b2"), (0.75, 0.2, 0.4, "#6d5dfc"), (0.55, 0.9, 0.5, "#0e7c86")]),
    "lagoon": ("#063047", [(0.15, 0.8, 0.5, "#0ea5e9"), (0.8, 0.3, 0.45, "#22d3ee"), (0.5, 0.1, 0.35, "#1e40af")]),
    "ember": ("#2a0a12", [(0.25, 0.3, 0.45, "#f97316"), (0.8, 0.75, 0.5, "#e11d48"), (0.6, 0.15, 0.3, "#facc15")]),
    "meadow": ("#0f2a1a", [(0.2, 0.7, 0.5, "#4ade80"), (0.7, 0.25, 0.45, "#a3e635"), (0.9, 0.9, 0.35, "#0d9488")]),
    "nebula": ("#120a24", [(0.3, 0.35, 0.45, "#a855f7"), (0.75, 0.6, 0.5, "#ec4899"), (0.5, 0.95, 0.35, "#3b82f6")]),
    "dune": ("#3b2412", [(0.2, 0.3, 0.5, "#f5d0a9"), (0.75, 0.8, 0.5, "#d97706"), (0.85, 0.15, 0.3, "#fde68a")]),
}


def make(base: str, spots: list) -> Image.Image:
    img = Image.new("RGB", (W, H), base)
    for x, y, r, colour in spots:
        layer = Image.new("RGB", (W, H), colour)
        mask = Image.new("L", (W, H), 0)
        rr = r * W
        ImageDraw.Draw(mask).ellipse((x * W - rr, y * H - rr, x * W + rr, y * H + rr), fill=200)
        img = Image.composite(layer, img, mask.filter(ImageFilter.GaussianBlur(rr * 0.55)))
    return img.filter(ImageFilter.GaussianBlur(6))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (base, spots) in WALLPAPERS.items():
        make(base, spots).save(OUT / f"{name}.jpg", quality=86, optimize=True, progressive=True)
        print(OUT / f"{name}.jpg")
