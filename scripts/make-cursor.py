"""Draws the smooth cursor (src/assets/cursor.png): a white arrow with a dark edge and a soft
shadow, its tip at the top-left corner of the image (TIP below). Used by the editor's preview and,
embedded in the app, by the export. Plain Python (zlib only): python scripts/make-cursor.py"""
import math
import os
import struct
import zlib

SCALE = 6  # pixels per unit of the outline below
PAD = 3  # units of room for the edge and the shadow
EDGE = 1.25  # dark edge width (units)
# The arrow, tip first (units).
ARROW = [(0, 0), (0, 17), (4.2, 13.2), (7.3, 19.8), (9.9, 18.7), (6.8, 12.2), (12.2, 12.2)]
W = int((13 + PAD * 2) * SCALE)
H = int((21 + PAD * 2) * SCALE)
SS = 4  # supersamples per pixel side


def inside(x, y):
    c = False
    n = len(ARROW)
    for i in range(n):
        (x1, y1), (x2, y2) = ARROW[i], ARROW[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def edge_dist(x, y):
    best = 1e9
    n = len(ARROW)
    for i in range(n):
        (x1, y1), (x2, y2) = ARROW[i], ARROW[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(x - x1 - t * dx, y - y1 - t * dy))
    return best


def sample(x, y):
    """(alpha, white share) of one point in units; the edge grows outwards and inwards."""
    d = edge_dist(x, y)
    if inside(x, y):
        return (1.0, 0.0) if d < EDGE / 2 else (1.0, 1.0)
    return (1.0, 0.0) if d < EDGE / 2 else (0.0, 0.0)


# Arrow coverage and colour, supersampled.
alpha = [[0.0] * W for _ in range(H)]
white = [[0.0] * W for _ in range(H)]
for py in range(H):
    for px in range(W):
        a = wsum = 0.0
        for sy in range(SS):
            for sx in range(SS):
                ux = (px + (sx + 0.5) / SS) / SCALE - PAD
                uy = (py + (sy + 0.5) / SS) / SCALE - PAD
                sa, sw = sample(ux, uy)
                a += sa
                wsum += sa * sw
        alpha[py][px] = a / (SS * SS)
        white[py][px] = wsum / a if a else 0.0

# Soft shadow: the arrow's coverage moved down and right, blurred (two box passes).
SH = [[0.0] * W for _ in range(H)]
ox, oy = int(0.6 * SCALE), int(1.0 * SCALE)
for y in range(H):
    for x in range(W):
        if 0 <= y - oy < H and 0 <= x - ox < W:
            SH[y][x] = alpha[y - oy][x - ox]
R = int(1.2 * SCALE)
for _ in range(2):
    SH = [[sum(row[max(0, x - R):x + R + 1]) / (2 * R + 1) for x in range(W)] for row in SH]
    cols = list(zip(*SH))
    cols = [[sum(c[max(0, y - R):y + R + 1]) / (2 * R + 1) for y in range(H)] for c in cols]
    SH = [list(r) for r in zip(*cols)]

rows = []
for y in range(H):
    row = bytearray([0])
    for x in range(W):
        a = alpha[y][x]
        s = SH[y][x] * 0.4 * (1 - a)
        out_a = a + s
        v = int(round(255 * white[y][x])) if a else 0
        row += bytes([v, v, v, int(round(255 * min(1.0, out_a)))])
    rows.append(bytes(row))


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
out = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "cursor.png")
with open(out, "wb") as f:
    f.write(png)
print(f"{out}: {W}x{H}, tip at ({PAD * SCALE}, {PAD * SCALE})")
