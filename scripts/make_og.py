"""Build public/assets/og.jpg — the 1200x630 card Facebook, LinkedIn, Slack,
iMessage, X and most LLM link-preview fetchers show when someone shares itsnum.com.

Every page declares twitter:card=summary_large_image, which without an image
renders as an empty grey box — worse than no card at all. One strong default
card beats twenty-two blanks.

The hero photo is portrait (900x1117), so it cannot be stretched across a
landscape card without upscaling. It runs down the right-hand third instead,
faded into the ink so it reads as part of the card rather than pasted on.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ASSETS = os.path.join(ROOT, "public", "assets")

W, H = 1200, 630
INK = (10, 26, 36)
PRI = (14, 164, 131)
MUTED = (159, 178, 188)
PALE = (231, 246, 241)

FONTS = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial Bold.ttf",
]


def font(bold, size):
    path = FONTS[0] if bold else FONTS[1]
    if not os.path.exists(path):
        path = FONTS[0] if os.path.exists(FONTS[0]) else FONTS[-1]
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def wrap(draw, text, f, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=f) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


img = Image.new("RGB", (W, H), INK)

# --- right-hand photo panel, cropped from the portrait hero without upscaling
panel_w = 430
hero_path = os.path.join(ASSETS, "hero.jpg")
if os.path.exists(hero_path):
    hero = Image.open(hero_path).convert("RGB")
    target = panel_w / float(H)                       # 430:630
    sw = int(hero.height * target)
    sw = min(sw, hero.width)
    left = (hero.width - sw) // 2
    hero = hero.crop((left, 0, left + sw, hero.height)).resize((panel_w, H), Image.LANCZOS)
    img.paste(hero, (W - panel_w, 0))

    # Fade the photo's left edge into the ink over 200px so there is no seam.
    fade = Image.new("L", (200, H), 0)
    fd = ImageDraw.Draw(fade)
    for x in range(200):
        fd.line([(x, 0), (x, H)], fill=int(255 * (1 - x / 199.0)))
    img.paste(Image.new("RGB", (200, H), INK), (W - panel_w, 0), fade)

    # And darken the whole panel slightly so white text stays dominant.
    shade = Image.new("RGB", (panel_w, H), INK)
    img.paste(Image.blend(img.crop((W - panel_w, 0, W, H)), shade, 0.28), (W - panel_w, 0))

# --- soft teal glow behind the wordmark
glow = Image.new("RGB", (W, H), INK)
gd = ImageDraw.Draw(glow)
gd.ellipse([-260, 250, 520, 900], fill=(14, 90, 78))
img = Image.blend(img, Image.blend(img, glow.filter(ImageFilter.GaussianBlur(120)), 0.55), 1.0)

# Keep a copy of the artwork before any text lands on it. Contrast has to be
# measured against what sits *behind* the glyphs; measuring the finished card
# just reads the white text back to you and always looks fine.
bg = img.copy()
BOXES = []

d = ImageDraw.Draw(img)
X = 76
MAXW = W - panel_w - X - 60

def put(label, xy, text, f, fill):
    d.text(xy, text, font=f, fill=fill)
    BOXES.append((label, d.textbbox(xy, text, font=f), fill))


# eyebrow
eb = font(True, 22)
put("eyebrow", (X, 74), "I T S N U M . C O M", eb, PRI)

# wordmark
wm = font(True, 104)
put("wordmark", (X, 116), "NUM", wm, (255, 255, 255))
wm_w = d.textlength("NUM", font=wm)
d.ellipse([X + wm_w + 16, 200, X + wm_w + 42, 226], fill=PRI)

# headline
hl = font(True, 52)
y = 256
for i, line in enumerate(wrap(d, "Your personal AI travel concierge", hl, MAXW)):
    put("headline-%d" % (i + 1), (X, y), line, hl, (255, 255, 255))
    y += 62

# supporting line
sb = font(False, 27)
y += 14
for i, line in enumerate(wrap(d, "Real places, verified by people — across 77 destinations in 38 countries.", sb, MAXW)):
    put("support-%d" % (i + 1), (X, y), line, sb, MUTED)
    y += 36

# footer rule + attribution
d.rectangle([X, H - 96, X + 68, H - 92], fill=PRI)
ft = font(True, 26)
put("attribution", (X, H - 74), "by 5arz", ft, PALE)

out = os.path.join(ASSETS, "og.jpg")
img.save(out, "JPEG", quality=88, optimize=True, progressive=True)
print("%s  %dx%d  %d bytes" % (out.replace(ROOT + "/", ""), W, H, os.path.getsize(out)))


# --- verification ------------------------------------------------------------
def lum(c):
    r, g, b = [v / 255.0 for v in c[:3]]
    r, g, b = [(v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4) for v in (r, g, b)]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(fg, bg_):
    a, b = lum(fg), lum(bg_)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


print("\ncontrast of every text block against the art behind it (WCAG AA large text = 3.0):")
worst = 99.0
for label, box, colour in BOXES:
    x0, y0, x1, y1 = box
    x1 = min(x1, W)
    y1 = min(y1, H)
    crop = bg.crop((int(x0), int(y0), int(x1), int(y1)))
    px = list(crop.getdata())
    mean = tuple(sum(p[i] for p in px) // len(px) for i in range(3))
    # The darkest and lightest patches matter more than the average — text can
    # sit on a gradient that averages fine and still vanishes at one end.
    lums = sorted(lum(p) for p in px)
    lo_bg, hi_bg = lums[int(len(lums) * 0.02)], lums[int(len(lums) * 0.98)]
    fg = lum(colour)

    def r(bg_lum):
        hi, lo = max(fg, bg_lum), min(fg, bg_lum)
        return (hi + 0.05) / (lo + 0.05)

    r_mean = ratio(colour, mean)
    r_worst = min(r_mean, r(lo_bg), r(hi_bg))
    worst = min(worst, r_worst)
    print("  %-22s box=%-22s mean_bg=%-16s ratio=%.1f  worst=%.1f  %s" % (
        label, "%d,%d %dx%d" % (x0, y0, x1 - x0, y1 - y0), str(mean), r_mean, r_worst,
        "ok" if r_worst >= 3.0 else "LOW CONTRAST"))

overflow = [l for l, b, _ in BOXES if b[2] > W - panel_w + 40]
print("\n  text overflowing into the photo panel: %s" % (", ".join(overflow) if overflow else "none"))
print("  worst contrast ratio on the card: %.1f  (%s)" % (
    worst, "passes" if worst >= 3.0 else "FAILS — text will be hard to read"))
