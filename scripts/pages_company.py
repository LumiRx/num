# Company pages: /about, /faq, /contact, plus public/404.html.
# Imported by scripts/build.py, which passes the build_pages module in as M.

import os
import re

FAQS = [
    ("What is NUM?",
     "NUM is an AI travel concierge you talk to in ordinary language. You tell it what you want "
     "— dinner tonight, a massage near the beach, a driver at 6am — and it answers with real, "
     "verified local places and books one for you. It works in 77 destinations across 38 countries."),
    ("How much does NUM cost a traveller?",
     "Nothing. NUM is free for travellers. Businesses pay NUM 10% of a booking it completes, and "
     "that comes out of the business's side, not added to your bill."),
    ("How do I get NUM?",
     "Add Num on LINE at line.me/R/ti/p/@799pyrus, or open itsnum.com/get on your phone and add it "
     "to your home screen. WhatsApp and WeChat are in progress."),
    ("What does 'verified' mean?",
     "Every business NUM recommends has been checked by 5arz, the proof-of-human company, which "
     "confirms a real, unique, live person is behind the account. It is not a review score and it is "
     "not a paid badge. It means someone real is answerable for the place."),
    ("What languages does NUM speak?",
     "NUM answers in the language you write in. The business does not have to speak it — NUM "
     "handles the booking on both sides."),
    ("Which countries does NUM cover?",
     "77 destinations across 38 countries, with more than half a million places in the directory. "
     "Thailand and the United Kingdom are the deepest coverage today, and Edinburgh and London are "
     "live."),
    ("Does NUM sell my data?",
     "No. NUM does not sell personal data. The privacy policy sets out what is collected and why."),
    ("How does a business get listed?",
     "Claim your place at itsnum.com/claim, verify with 5arz, and fill in your hours, photos and "
     "what you offer. Listing is free."),
    ("Can an AI assistant manage a listing for a business?",
     "Yes. NUM has a public API and an MCP server for AI agents. Anything an agent submits is held "
     "for review by a person at 5arz before travellers see it. Details are at itsnum.com/agents."),
    ("Who is behind NUM?",
     "NUM is built by 5arz, the proof-of-human company. 5arz verifies that a real, unique, live "
     "person is behind an account or an action — which is what makes a verified listing mean "
     "anything."),
]


def register(M):
    S = M.SITE
    out = []

    # ------------------------------------------------------------------- about
    t = "About NUM — the verified AI travel concierge, by 5arz"
    d = ("NUM is an AI travel concierge built by 5arz. It plans trips in any language and books real, "
         "verified local places in 77 destinations across 38 countries.")
    ld = M.graph(
        M.ORG, M.WEBSITE,
        M.webpage("/about/", t, d, crumbs=[("Home", "/"), ("About", "/about/")]),
        {
            "@type": "AboutPage",
            "@id": S + "/about/#aboutpage",
            "url": S + "/about/",
            "mainEntity": {"@id": S + "/#organization"},
        },
    )
    body = M.hero(
        "&#10022; By 5arz",
        "A concierge is only as good as the places it sends you to.",
        "NUM is an AI travel concierge. It plans your trip in a conversation and books real, verified "
        "local places — in any language, at any hour, in 77 destinations across 38 countries.",
    ) + """
<section class="wrap" style="padding-top:8px"><div class="prose">
<h2>The problem we started with</h2>
<p>Search a city you do not know and you get a page of places that paid to be there, a page of
reviews you cannot trust, and no way to tell which restaurant is a restaurant and which is a photo of
one. Travellers already know this. They ask the hotel desk instead, because a person who is
answerable is worth more than a ranked list.</p>
<p>NUM is that desk, in your pocket, in your language, at three in the morning.</p>

<h2>What makes it different</h2>
<p>Every business NUM recommends has been checked by <a href="https://5arz.com">5arz</a>, the
proof-of-human company. 5arz confirms that a real, unique, live person is behind the account. Not a
review average, not a paid badge, not a scraped listing that has been closed for two years — a
person who is answerable for the place.</p>
<p>That check is slow and it costs us listings. It is also the only thing that makes a recommendation
worth acting on when you are somewhere unfamiliar and have to decide in the next ten minutes.</p>

<h2>How it works, briefly</h2>
<p>You message NUM the way you would message a friend who lives there. It asks what it needs to know,
searches its directory of more than half a million verified places, explains the two or three that
actually fit, and books one. The business does not need to speak your language. NUM handles both
sides.</p>

<h2>Where we are</h2>
<p>77 destinations across 38 countries. Thailand and the United Kingdom have the deepest coverage
today; Edinburgh and London are live and Phuket was the first market. NUM runs on LINE now, with
WhatsApp and WeChat in progress, and installs to a phone home screen from
<a href="/get">itsnum.com/get</a>.</p>

<h2>For businesses</h2>
<p>Listing is free. NUM takes 10% of a booking it completes and nothing otherwise. There is an
optional dashboard from $9.99 a month. See <a href="/list-your-business">why list with NUM</a> and
the <a href="/pricing">pricing</a>.</p>

<h2>For AI agents</h2>
<p>NUM is built to be read and written by other AI systems as well as people. There is a public API,
an MCP server, and a review queue where a person at 5arz approves anything an agent submits before a
traveller sees it. See <a href="/agents">NUM for AI agents</a>.</p>

<h2>Contact</h2>
<p>Email <a href="mailto:info@5arz.com">info@5arz.com</a>, or message Num on
<a href="https://line.me/R/ti/p/@799pyrus">LINE @799pyrus</a>. More ways on the
<a href="/contact">contact page</a>.</p>
</div></section>
"""
    out.append(M.page("/about/", t, d, ld, body))

    # --------------------------------------------------------------------- faq
    t = "NUM FAQ — how the AI travel concierge works"
    d = ("Answers about NUM: what it costs, how to get it, what verified means, which countries it "
         "covers, how businesses list, and how AI agents can manage listings.")
    ld = M.graph(
        M.ORG, M.WEBSITE,
        M.webpage("/faq/", t, d, crumbs=[("Home", "/"), ("FAQ", "/faq/")]),
        M.faq(FAQS),
    )
    qa = "\n".join(
        '<div class="qa"><h3>%s</h3><p>%s</p></div>' % (q, a.replace("—", "&mdash;"))
        for q, a in FAQS
    )
    body = M.hero(
        "&#10022; Questions",
        "Questions about NUM.",
        "What it is, what it costs, how to get it, and what we mean when we say a place is verified.",
    ) + ('<section class="wrap" style="padding-top:8px"><div class="prose">%s'
         '<div class="cta" style="margin-top:36px">'
         '<a class="btn pri lg" href="/get">Get the app</a>'
         '<a class="btn ghost lg" href="/contact">Ask us something else</a></div>'
         '</div></section>' % qa)
    out.append(M.page("/faq/", t, d, ld, body))

    # ----------------------------------------------------------------- contact
    t = "Contact NUM — 5arz Inc"
    d = ("Get in touch with NUM by 5arz. Email info@5arz.com, message Num on LINE @799pyrus, or call "
         "+1 754 444 8885.")
    ld = M.graph(
        M.ORG, M.WEBSITE,
        M.webpage("/contact/", t, d, crumbs=[("Home", "/"), ("Contact", "/contact/")]),
        {
            "@type": "ContactPage",
            "@id": S + "/contact/#contactpage",
            "url": S + "/contact/",
            "mainEntity": {"@id": S + "/#organization"},
        },
    )
    body = M.hero(
        "&#10022; Talk to us",
        "Contact NUM.",
        "NUM is operated by 5arz Inc. Whichever way you get in touch, a person reads it.",
    ) + """
<section class="wrap" style="padding-top:8px">
<div class="grid3">
  <div class="card2"><h3>Email</h3><p><a href="mailto:info@5arz.com">info@5arz.com</a><br>
    Support, listings, billing and press. Usually answered the same working day.</p></div>
  <div class="card2"><h3>Message the concierge</h3><p>
    <a href="https://line.me/R/ti/p/@799pyrus">LINE @799pyrus</a><br>
    The fastest way to see what NUM actually does. It answers 24 hours.</p></div>
  <div class="card2"><h3>Phone</h3><p><a href="tel:+17544448885">+1 754 444 8885</a><br>
    5arz Inc. Voicemail outside working hours.</p></div>
</div>
</section>

<section class="wrap" style="padding-top:44px"><div class="prose">
<h2>Which one you want</h2>
<ul>
  <li><b>You run a business and want to be listed.</b> Start at <a href="/claim/">itsnum.com/claim</a>
    &mdash; it is faster than emailing, because most places are already in the directory and only need
    claiming.</li>
  <li><b>You are already listed and something is wrong.</b> Email
    <a href="mailto:info@5arz.com">info@5arz.com</a> with the business name and the city. Include the
    booking reference if it is about a booking.</li>
  <li><b>You are a traveller and a booking went wrong.</b> Message Num on LINE in the same thread as
    the booking &mdash; it has the context and can fix it faster.</li>
  <li><b>You build AI agents.</b> See <a href="/agents">itsnum.com/agents</a>. It has the API, the MCP
    endpoint and the keys, and you do not need to talk to anyone to start.</li>
  <li><b>Press, partnerships, or you want NUM in your city.</b>
    <a href="mailto:info@5arz.com">info@5arz.com</a>, and say which.</li>
</ul>

<h2>Removing a listing</h2>
<p>If a business has been listed and does not want to be, email
<a href="mailto:info@5arz.com">info@5arz.com</a> from an address at that business's domain, or call the
number above. It comes down; we do not make you argue for it.</p>

<h2>Legal</h2>
<p>NUM is a product of 5arz Inc. See the <a href="/privacy">privacy policy</a> and the
<a href="/terms">terms of service</a>.</p>
</div></section>
"""
    out.append(M.page("/contact/", t, d, ld, body))

    # --------------------------------------------------------------------- 404
    ld = M.graph(M.ORG, M.WEBSITE)
    html = M.head("/404", "Page not found — NUM", "That page does not exist on itsnum.com.",
                  ld, noindex=True)
    html += "\n<body>\n" + M.NAV + """
<header class="wrap" style="padding-top:80px;padding-bottom:40px">
  <span class="pill">404</span>
  <h1 class="h1" style="margin-top:18px;max-width:20ch">That page is not here.</h1>
  <p class="sub" style="max-width:58ch">The link may be old, or it may be a page we retired. Here is
  everything that does exist.</p>
</header>
<section class="wrap" style="padding-bottom:20px">
<div class="grid3">
  <div class="card2"><h3>For travellers</h3><p>
    <a href="/get">Get the app</a><br>
    <a href="/how-it-works">How it works</a><br>
    <a href="/perks">Perks</a><br>
    <a href="/faq">FAQ</a></p></div>
  <div class="card2"><h3>For business</h3><p>
    <a href="/claim/">List your business</a><br>
    <a href="/business">For business</a><br>
    <a href="/list-your-business">Why list with NUM</a><br>
    <a href="/pricing">Pricing</a></p></div>
  <div class="card2"><h3>Company</h3><p>
    <a href="/about">About</a><br>
    <a href="/agents">For AI agents</a><br>
    <a href="/contact">Contact</a><br>
    <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></p></div>
</div>
<div class="cta" style="margin-top:36px"><a class="btn pri lg" href="/">Back to the home page</a></div>
</section>
""" + M.FOOTER + "\n</body>\n</html>\n"
    html = M.fix_links(html)
    # A 404 is served at whatever URL the visitor mistyped, so a canonical and an
    # og:url pointing at "/404" are both false. The page is noindex anyway; the
    # honest thing is to declare no canonical URL at all.
    html = re.sub(r'\n<link rel="canonical" href="[^"]*">', "", html, count=1)
    html = re.sub(r'\n<meta property="og:url" content="[^"]*">', "", html, count=1)
    p = os.path.join(M.PUB, "404.html")
    open(p, "w", encoding="utf-8").write(html)
    out.append((p, len(html)))

    return out
