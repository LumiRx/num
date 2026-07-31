#!/usr/bin/env python3
"""Add canonical / robots / OG / Twitter / JSON-LD to the hand-written pages,
and rewrite legacy .html links to clean URLs everywhere.

Idempotent: re-running changes nothing. Run after scripts/build.py.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_pages as M   # noqa: E402

PUB = M.PUB
S = M.SITE
INDEXABLE = "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"

# path -> (canonical, robots, og_title, og_desc, extra json-ld nodes or None)
PAGES = {
    "index.html": ("/", INDEXABLE, None, None, "home"),
    "app/index.html": ("/app/", INDEXABLE, None, None, "app"),
    "privacy/index.html": ("/privacy/", INDEXABLE, None, None, "legal"),
    "terms/index.html": ("/terms/", INDEXABLE, None, None, "legal"),
    "referral/index.html": ("/referral/", INDEXABLE, None, None, "plain"),
    "vip/index.html": ("/vip/", INDEXABLE, None, None, "plain"),
    "tabs/index.html": ("/tabs/", INDEXABLE, None, None, "tabs"),
    "claim/index.html": ("/claim/", "noindex, nofollow", None, None, None),
    "console/index.html": ("/console/", "noindex, nofollow", None, None, None),
    "app-preview/index.html": ("/app-preview/", "noindex, nofollow", None, None, None),
    "signin/index.html": ("/signin/", "noindex, follow", None, None, None),
    "get/index.html": ("/app/", "noindex, follow", None, None, None),
    "join/index.html": ("/vip/", "noindex, follow", None, None, None),
}

HOME_FAQ = [
    ("What is NUM?",
     "NUM is an AI travel concierge you message in ordinary language. It plans your trip and books "
     "real, verified local places across 77 destinations in 38 countries, in any language, at any "
     "hour. It is free for travellers."),
    ("How do I get NUM?",
     "Add Num on LINE at line.me/R/ti/p/@799pyrus, or open itsnum.com/get on your phone and add it "
     "to your home screen. WhatsApp and WeChat are in progress."),
    ("Does NUM cost anything?",
     "Not for travellers. Businesses pay NUM 10% of a booking it completes, out of their side."),
    ("What does verified mean?",
     "Every business NUM recommends has been checked by 5arz, the proof-of-human company, which "
     "confirms a real, unique, live person is behind the account."),
]

APP_SOFTWARE = {
    "@type": "SoftwareApplication",
    "@id": S + "/app#app",
    "name": "NUM",
    "alternateName": "NUM travel concierge",
    "applicationCategory": "TravelApplication",
    "operatingSystem": "iOS, Android, Web",
    "url": S + "/app/",
    "installUrl": S + "/get/",
    "publisher": {"@id": S + "/#organization"},
    "description": "An AI travel concierge that plans your trip in chat and books real, verified "
                   "local places in 77 destinations across 38 countries, in any language.",
    "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
    "featureList": [
        "Plans a trip in conversation, in any language",
        "Books verified local restaurants, hotels, spas, tours and clinics",
        "Works on LINE, or installs to a phone home screen",
        "Available 24 hours",
    ],
}


# Num Tab is a waitlist, not a shipping product, so availability is PreOrder.
# Saying InStock would be a claim we cannot currently honour.
TAB_PRODUCT = {
    "@type": "Product",
    "@id": S + "/tabs/#product",
    "name": "Num Tab Kit",
    "brand": {"@id": S + "/#organization"},
    "category": "Point of sale hardware",
    "url": S + "/tabs/",
    "description": "Ten adhesive NFC and QR codes, one per table. Guests tap or scan, split the "
                   "bill and pay from their own phone. Money settles to the venue's PromptPay the "
                   "same night.",
    "offers": {
        "@type": "Offer",
        "price": "20",
        "priceCurrency": "USD",
        "availability": "https://schema.org/PreOrder",
        "url": S + "/tabs/",
        "seller": {"@id": S + "/#organization"},
        "eligibleRegion": [
            {"@type": "Country", "name": "Thailand"},
        ],
    },
}


def ld_for(kind, slug, title, desc):
    nodes = [M.ORG, M.WEBSITE]
    if kind == "home":
        wp = M.webpage("/", title, desc)
        wp["@id"] = S + "/#webpage"
        nodes += [wp, APP_SOFTWARE, M.faq(HOME_FAQ)]
    elif kind == "app":
        nodes += [M.webpage("/app/", title, desc,
                            crumbs=[("Home", "/"), ("Get the app", "/app/")]), APP_SOFTWARE]
    elif kind == "legal":
        name = "Privacy Policy" if "privacy" in slug else "Terms of Service"
        nodes += [M.webpage(slug, title, desc, crumbs=[("Home", "/"), (name, slug)])]
    elif kind == "tabs":
        # no FAQPage here: FAQ mark-up has to match Q&A that is visible on the
        # page, and /tabs/ does not have a question-and-answer section.
        nodes += [M.webpage(slug, title, desc,
                            crumbs=[("Home", "/"), ("Num Tab", "/tabs/")]), TAB_PRODUCT]
    elif kind == "plain":
        nodes += [M.webpage(slug, title, desc)]
    else:
        return None
    return M.graph(*nodes)


def esc(s):
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def patch(rel, slug, robots, kind):
    p = os.path.join(PUB, rel)
    if not os.path.exists(p):
        return rel, "MISSING", 0
    h = open(p, encoding="utf-8").read()
    orig = h
    url = S + slug
    title = (re.search(r"<title>(.*?)</title>", h, re.S) or [None, ""])[1].strip()
    dm = re.search(r'<meta name="description" content="([^"]*)"', h)
    desc = dm.group(1) if dm else ""

    add = []
    # canonical, robots and og:url are rewritten rather than only added, because
    # an earlier run wrote them without the trailing slash and a canonical that
    # points at a 307 is worse than no canonical at all.
    if 'rel="canonical"' not in h:
        add.append('<link rel="canonical" href="%s">' % url)
    else:
        h = re.sub(r'<link rel="canonical" href="[^"]*">',
                   '<link rel="canonical" href="%s">' % url, h, count=1)
    if 'name="robots"' not in h:
        add.append('<meta name="robots" content="%s">' % robots)
    else:
        h = re.sub(r'<meta name="robots" content="[^"]*">',
                   '<meta name="robots" content="%s">' % robots, h, count=1)
    if 'property="og:url"' in h:
        h = re.sub(r'<meta property="og:url" content="[^"]*">',
                   '<meta property="og:url" content="%s">' % url, h, count=1)
    # the JSON-LD this script owns is regenerated every run so slugs cannot drift
    h = re.sub(r'\s*<script type="application/ld\+json">.*?</script>', "", h, flags=re.S)
    if 'property="og:title"' not in h:
        add += [
            '<meta property="og:type" content="website">',
            '<meta property="og:site_name" content="NUM">',
            '<meta property="og:title" content="%s">' % esc(title),
            '<meta property="og:description" content="%s">' % esc(desc),
            '<meta property="og:url" content="%s">' % url,
            '<meta property="og:locale" content="en_GB">',
            '<meta name="twitter:card" content="summary_large_image">',
            '<meta name="twitter:title" content="%s">' % esc(title),
            '<meta name="twitter:description" content="%s">' % esc(desc),
        ]
    # The image tags get their own guards rather than riding along in the block
    # above. That block only runs when og:title is missing, so a page patched
    # before og:image existed would skip it forever and never gain an image.
    if 'property="og:image"' not in h:
        add += [
            '<meta property="og:image" content="%s/assets/og.jpg">' % S,
            '<meta property="og:image:width" content="1200">',
            '<meta property="og:image:height" content="630">',
            '<meta property="og:image:alt" content="NUM &mdash; your personal AI travel '
            'concierge, by 5arz">',
        ]
    # twitter:image is its own guard rather than a branch of the one above.
    # A page that already carries a hand-picked og:image (tabs uses the hero
    # shot) should keep it and get the matching twitter tag, not be skipped.
    if 'name="twitter:image"' not in h:
        own = re.search(r'<meta property="og:image" content="([^"]+)">', h)
        add.append('<meta name="twitter:image" content="%s">'
                   % (own.group(1) if own else S + "/assets/og.jpg"))
    if "application/ld+json" not in h:
        ld = ld_for(kind, slug, title, desc)
        if ld:
            add.append('<script type="application/ld+json">%s</script>'
                       % json.dumps(ld, separators=(",", ":"), ensure_ascii=False))

    if add:
        h = h.replace("</head>", "\n".join(add) + "\n</head>", 1)

    if h != orig:
        open(p, "w", encoding="utf-8").write(h)
        return rel, "patched", len(h)
    return rel, "unchanged", len(h)


# ------------------------------------------------------------------ link rewrite
LINKS = [
    ('href="index.html"', 'href="/"'),
    ('href="how.html"', 'href="/how-it-works"'),
    ('href="perks.html"', 'href="/perks"'),
    ('href="business.html#pricing"', 'href="/pricing"'),
    ('href="business.html"', 'href="/business"'),
    ('href="/business.html"', 'href="/business"'),
    ('href="dashboard.html"', 'href="/signin/"'),
    ('href="start.html"', 'href="/get"'),
    ('href="login.html"', 'href="/signin/"'),
    ('href="signup.html"', 'href="/claim/"'),
    ('href="whatsapp.html"', 'href="/get"'),
    ('href="assets/', 'href="/assets/'),
    ('src="assets/', 'src="/assets/'),
]


def rewrite_links():
    changed = []
    for root, _dirs, files in os.walk(PUB):
        for f in files:
            if not f.endswith(".html"):
                continue
            p = os.path.join(root, f)
            h = open(p, encoding="utf-8").read()
            o = h
            for a, b in LINKS:
                h = h.replace(a, b)
            # drop the <base> tag: it makes every relative URL absolute to the
            # legacy site and breaks nothing only by luck.
            h = re.sub(r'\s*<base href="[^"]*">', "", h)
            # normalise every internal link to the trailing-slash form Cloudflare
            # actually serves, so no internal click costs a 307
            h = M.fix_links(h)
            if h != o:
                open(p, "w", encoding="utf-8").write(h)
                changed.append(os.path.relpath(p, PUB))
    return changed


def main():
    print("--- heads")
    for rel, (slug, robots, _a, _b, kind) in sorted(PAGES.items()):
        print("%-30s %-10s %s" % patch(rel, slug, robots, kind))
    print("--- links rewritten in")
    for c in sorted(rewrite_links()):
        print("   ", c)


if __name__ == "__main__":
    main()
