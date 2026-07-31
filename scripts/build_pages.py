#!/usr/bin/env python3
"""Build every indexable page on itsnum.com from one template.

Run:  python3 scripts/build-pages.py
Writes into public/<slug>/index.html plus public/404.html.

Design notes
------------
* One head builder so canonical / robots / OG / Twitter / JSON-LD can never
  drift between pages. Every page gets Organization + WebSite + WebPage.
* Nav and footer are shared constants. Links are clean URLs (no .html) because
  the legacy Cloudflare Pages site that served /how.html etc. is being retired.
* Attribution is "by 5arz" everywhere. Never Lumi.
"""
import json, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PUB = os.path.join(ROOT, 'public')
SITE = "https://itsnum.com"
TODAY = "2026-07-31"

# ---------------------------------------------------------------- shared JSON-LD

ORG = {
    "@type": "Organization",
    "@id": SITE + "/#organization",
    "name": "NUM",
    "alternateName": "NUM travel concierge",
    "url": SITE + "/",
    "email": "info@5arz.com",
    "description": "NUM is an AI travel concierge you chat with. It plans your trip in any language and books real, verified local places across 77 destinations in 38 countries.",
    "parentOrganization": {
        "@type": "Organization",
        "name": "5arz",
        "url": "https://5arz.com/",
        "description": "5arz is the proof-of-human company. It verifies that a real, unique, live person is behind an account or an action.",
    },
    "sameAs": ["https://5arz.com/"],
    "contactPoint": [{
        "@type": "ContactPoint",
        "email": "info@5arz.com",
        "contactType": "customer support",
        "availableLanguage": ["en"],
    }],
}

WEBSITE = {
    "@type": "WebSite",
    "@id": SITE + "/#website",
    "url": SITE + "/",
    "name": "NUM",
    "publisher": {"@id": SITE + "/#organization"},
    "inLanguage": "en",
}


def graph(*nodes):
    return {"@context": "https://schema.org", "@graph": [n for n in nodes if n]}


def webpage(slug, title, desc, crumbs=None):
    url = SITE + slug
    node = {
        "@type": "WebPage",
        "@id": url + "#webpage",
        "url": url,
        "name": title,
        "description": desc,
        "isPartOf": {"@id": SITE + "/#website"},
        "about": {"@id": SITE + "/#organization"},
        "inLanguage": "en",
        "datePublished": "2026-07-31",
        "dateModified": TODAY,
    }
    if crumbs:
        items = [{"@type": "ListItem", "position": i + 1, "name": n,
                  "item": SITE + u} for i, (n, u) in enumerate(crumbs)]
        node["breadcrumb"] = {"@type": "BreadcrumbList", "itemListElement": items}
    return node


def faq(pairs):
    return {
        "@type": "FAQPage",
        "mainEntity": [{
            "@type": "Question", "name": q,
            "acceptedAnswer": {"@type": "Answer", "text": a},
        } for q, a in pairs],
    }


# ---------------------------------------------------------------- head / chrome

def head(slug, title, desc, ld, noindex=False, extra_css=""):
    url = SITE + slug
    robots = ("noindex, nofollow" if noindex else
              "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1")
    ldjson = json.dumps(ld, indent=None, separators=(',', ':'), ensure_ascii=False)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{url}">
<meta name="robots" content="{robots}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="NUM">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{url}">
<meta property="og:locale" content="en_GB">
<meta property="og:image" content="{SITE}/assets/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="NUM — your personal AI travel concierge, by 5arz">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{SITE}/assets/og.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
<script type="application/ld+json">{ldjson}</script>
<script src="/num-capture.js" data-page="{slug.strip('/') or 'landing'}" defer></script>
<style>
.prose{{max-width:72ch}}
.prose h2{{margin-top:44px}}
.prose h3{{margin-top:30px}}
.prose p,.prose li{{color:var(--ink2);line-height:1.72}}
.prose ul{{padding-left:20px}}
.prose li{{margin:8px 0}}
.grid3{{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:28px}}
.card2{{background:#fff;border:1px solid var(--line);border-radius:20px;padding:26px;box-shadow:var(--shadow)}}
.card2 h3{{margin:0 0 8px}}
.card2 p{{margin:0;font-size:15px;color:var(--ink2)}}
.qa{{border-top:1px solid var(--line);padding:22px 0}}
.qa h3{{margin:0 0 8px;font-size:18px}}
.qa p{{margin:0}}
pre.code{{background:#0d1b24;color:#d8e6ee;border-radius:16px;padding:20px;overflow-x:auto;font-size:13px;line-height:1.65;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}
code.inl{{background:var(--pri-xl);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:.92em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}
table.tbl{{width:100%;border-collapse:collapse;margin-top:24px;font-size:15px}}
table.tbl th,table.tbl td{{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}}
table.tbl th{{font-weight:700;color:var(--ink)}}
table.tbl td{{color:var(--ink2)}}
@media(max-width:860px){{.grid3{{grid-template-columns:1fr}}}}
{extra_css}
</style>
</head>"""


NAV = """<nav class="nav"><div class="wrap row">
  <a class="brand" href="/"><span class="dot"></span>NUM <small>travel concierge</small></a>
  <div class="navlinks">
    <a href="/get">Get the app</a>
    <a href="/how-it-works">How it works</a>
    <a href="/perks">Perks</a>
    <a href="/business">For business</a>
    <a href="/agents">For AI agents</a>
    <span id="signin-slot"><a href="/signin/">Sign in</a></span>
    <a class="btn pri" href="/claim/" style="padding:10px 18px;font-size:14px">List your business</a>
  </div>
  <button class="menu-btn" aria-label="Menu">&#9776;</button>
</div>
<div class="mobile">
  <a href="/get">Get the app</a><a href="/how-it-works">How it works</a><a href="/perks">Perks</a>
  <a href="/business">For business</a><a href="/agents">For AI agents</a>
  <a href="/claim/">List your business</a>
  <a href="/signin/" id="signin-slot-m">Sign in</a>
</div>
</nav>"""

FOOTER = """<footer><div class="wrap">
  <div class="frow">
    <div>
      <a class="brand" href="/" style="font-size:18px"><span class="dot"></span>NUM</a>
      <p style="margin-top:12px;max-width:32ch">The verified AI travel concierge &mdash; connecting visitors with the best real local places in 77 destinations across 38 countries. By 5arz.</p>
    </div>
    <div><h4>Product</h4><a href="/get">Get the app</a><a href="/how-it-works">How it works</a><a href="/perks">Perks</a><a href="/business">For business</a><a href="/agents">For AI agents</a><a href="/tabs">Num Tab</a></div>
    <div><h4>Get started</h4><a href="/claim/">List your business</a><a href="/pricing">Pricing</a><a href="/list-your-business">Why list with NUM</a></div>
    <div><h4>Company</h4><a href="/about">About</a><a href="/faq">FAQ</a><a href="/contact">Contact</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a></div>
    <div><h4>Contact</h4><a href="mailto:info@5arz.com">info@5arz.com</a><a href="https://line.me/R/ti/p/@799pyrus">LINE @799pyrus</a><a href="https://5arz.com">5arz.com</a></div>
  </div>
  <div class="fbot"><span>&copy; 2026 NUM &middot; by 5arz</span><span>Verified humans, real places.</span></div>
</div></footer>
<script src="/assets/site.js" defer></script>"""


def hero(pill, h1, sub, ctas=""):
    return f"""<header class="wrap" style="padding-top:56px;padding-bottom:12px">
  <span class="pill">{pill}</span>
  <h1 class="h1" style="margin-top:18px;max-width:20ch">{h1}</h1>
  <p class="sub" style="max-width:62ch">{sub}</p>
  {f'<div class="cta">{ctas}</div>' if ctas else ''}
</header>"""


# Cloudflare Workers static assets serve public/<slug>/index.html at "/<slug>/"
# and 307 "/<slug>" to it. Linking without the trailing slash therefore costs a
# redirect on every internal click and makes a canonical point at a redirect, so
# every internal link is normalised here rather than at 40 call sites.
LINK_SLUGS = [
    "list-your-business", "how-it-works", "destinations", "edinburgh", "referral",
    "bangkok", "business", "contact", "privacy", "pricing", "for-ai", "agents",
    "london", "phuket", "perks", "about", "claim", "terms", "faq", "app", "get",
    "join", "vip", "signin", "tabs",
]
_LINK_RE = re.compile(r'href="/(' + "|".join(LINK_SLUGS) + r')"')


def fix_links(html):
    """Add the trailing slash to every internal link to a directory page."""
    return _LINK_RE.sub(lambda m: 'href="/%s/"' % m.group(1), html)


def page(slug, title, desc, ld, body, noindex=False, extra_css=""):
    """slug is like '/business/' — written to public/business/index.html"""
    canon = slug if slug.endswith('/') else slug + '/'
    html = head(canon, title, desc, ld, noindex, extra_css) + "\n<body>\n" + NAV + "\n" + body + "\n" + FOOTER + "\n</body>\n</html>\n"
    html = fix_links(html)
    rel = canon.strip('/')
    d = os.path.join(PUB, rel) if rel else PUB
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, 'index.html')
    open(p, 'w', encoding='utf-8').write(html)
    return p, len(html)
