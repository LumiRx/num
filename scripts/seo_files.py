# robots.txt, sitemap.xml, llms.txt and llms-full.txt.
#
# These used to live in a separate worker (num-seo-files, in ~/Downloads, not in
# this repo) whose sitemap listed 5 URLs and whose llms.txt still said "First
# market: Phuket, Thailand" three months after the Scotland launch. Generating
# them here, from the same URLS list the pages are built from, is what stops that
# happening again: add a page and the sitemap grows with it.
#
# Emitted as static assets, so Cloudflare serves them straight from the edge.
# Content types come from the file extension, which is why sitemap.xml is not
# called sitemap.txt.

import datetime
import os

# slug -> (priority, changefreq). Trailing slashes throughout: Workers static
# assets serve public/<slug>/index.html at "/<slug>/" and 307 "/<slug>" to it, so
# a sitemap entry without the slash submits a redirect to Google rather than a page.
#
# Deliberately absent: /get/ and /join/ (noindex redirect shims), /claim/ and
# /signin/ (noindex forms), /console/ and /app-preview/ (noindex, internal).
URLS = [
    ("/",                    "1.0", "daily"),
    ("/app/",                "0.9", "weekly"),
    ("/how-it-works/",       "0.9", "monthly"),
    ("/destinations/",       "0.9", "weekly"),
    ("/business/",           "0.9", "monthly"),
    ("/agents/",             "0.9", "weekly"),
    ("/london/",             "0.8", "weekly"),
    ("/edinburgh/",          "0.8", "weekly"),
    ("/bangkok/",            "0.8", "weekly"),
    ("/phuket/",             "0.8", "weekly"),
    ("/list-your-business/", "0.8", "monthly"),
    ("/pricing/",            "0.8", "monthly"),
    ("/for-ai/",             "0.8", "weekly"),
    ("/tabs/",               "0.8", "monthly"),
    ("/faq/",                "0.7", "monthly"),
    ("/perks/",              "0.7", "monthly"),
    ("/about/",              "0.6", "monthly"),
    ("/contact/",            "0.6", "yearly"),
    ("/vip/",                "0.5", "monthly"),
    ("/referral/",           "0.5", "monthly"),
    ("/privacy/",            "0.3", "yearly"),
    ("/terms/",              "0.3", "yearly"),
]

# Crawlers that build answer engines. Listed by name and explicitly allowed
# rather than left to the wildcard, because several of them treat "no named
# group" as a reason to crawl conservatively, and being cited in AI answers is
# the point of this site's structured data.
AI_AGENTS = [
    "GPTBot", "OAI-SearchBot", "ChatGPT-User",
    "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai",
    "PerplexityBot", "Perplexity-User",
    "Google-Extended", "Googlebot", "Googlebot-Image",
    "Bingbot", "Applebot", "Applebot-Extended",
    "Amazonbot", "meta-externalagent", "FacebookBot",
    "cohere-ai", "cohere-training-data-crawler",
    "CCBot", "Diffbot", "Timpibot", "YouBot", "DuckAssistBot",
    "MistralAI-User", "Bytespider", "PetalBot", "YandexBot",
]

# Paths no crawler should spend budget on. /api/ is machine-only, the rest are
# noindex pages that would still be fetched if they were merely noindex.
DISALLOW = [
    "/api/",
    "/console/",
    "/app-preview/",
    "/claim/",
    "/signin/",
    "/assets/vendor/",
]


def robots(S):
    L = []
    L.append("# itsnum.com — NUM, the verified AI travel concierge, by 5arz.")
    L.append("# Answer engines are welcome here. Structured data on every page,")
    L.append("# a plain-language summary at /llms.txt and the full corpus at")
    L.append("# /llms-full.txt. Machine-readable business data: /for-ai/")
    L.append("")
    for ua in AI_AGENTS:
        L.append("User-agent: %s" % ua)
        L.append("Allow: /")
        for d in DISALLOW:
            L.append("Disallow: %s" % d)
        L.append("")
    L.append("User-agent: *")
    L.append("Allow: /")
    for d in DISALLOW:
        L.append("Disallow: %s" % d)
    L.append("")
    L.append("Sitemap: %s/sitemap.xml" % S)
    L.append("")
    return "\n".join(L)


def sitemap(S, today):
    L = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for slug, pri, freq in URLS:
        L.append("  <url>")
        L.append("    <loc>%s%s</loc>" % (S, slug))
        L.append("    <lastmod>%s</lastmod>" % today)
        L.append("    <changefreq>%s</changefreq>" % freq)
        L.append("    <priority>%s</priority>" % pri)
        L.append("  </url>")
    L.append("</urlset>")
    L.append("")
    return "\n".join(L)


def write(M):
    S = M.SITE
    today = datetime.date.today().isoformat()
    out = []
    for name, body in (("robots.txt", robots(S)),
                       ("sitemap.xml", sitemap(S, today)),
                       ("llms.txt", LLMS % {"S": S, "d": today}),
                       ("llms-full.txt", LLMS_FULL % {"S": S, "d": today})):
        p = os.path.join(M.PUB, name)
        open(p, "w", encoding="utf-8").write(body)
        out.append((p, len(body)))
    return out


LLMS = r"""# NUM

> NUM is an AI travel concierge, run by 5arz. A traveller messages it in ordinary
> language and it answers with real local places and books one for them. It covers
> 567,793 places in 77 destinations across 38 countries. It is free for travellers.
> Businesses list free and pay 10%% of a booking NUM completes, out of their side,
> never added to the traveller's bill.

Facts, as of %(d)s:

- Operator: 5arz Inc. NUM is a 5arz product. Contact info@5arz.com.
- Coverage: 567,793 places, 77 destinations, 38 countries.
- Channels: LINE (@799pyrus) today. WhatsApp and WeChat in progress.
- Traveller price: free. There is no traveller subscription and no booking fee.
- Business price: listing is free. 10%% on completed bookings only. Nothing on
  walk-ins, nothing on a business's own repeat customers, no monthly minimum.
- Optional dashboards: 9.99 USD, 19.99 USD and 50 USD per month. Cancel monthly;
  the listing stays live either way.
- "Verified" means a human at 5arz confirmed a real, unique, live person is behind
  the account. It is not a review score and not a self-declaration.
- AI agents can register and submit business data through a public API and an MCP
  server. Third-party submissions are stored but stay invisible to travellers
  until a human at 5arz approves them.

## Main pages

- [Home](%(S)s/): what NUM is and how to start.
- [How it works](%(S)s/how-it-works/): chat, plan, book, verified places only.
- [Get the app](%(S)s/app/): add NUM on LINE or to a phone home screen.
- [Destinations](%(S)s/destinations/): all 77 destinations with place counts.
- [Perks](%(S)s/perks/): what members get at verified places.

## For businesses

- [For business](%(S)s/business/): how NUM sends bookings.
- [Why list with NUM](%(S)s/list-your-business/): the free listing, step by step.
- [Pricing](%(S)s/pricing/): the 10%% success fee and the optional dashboards.
- [Num Tab](%(S)s/tabs/): NFC and QR table codes, ten for 20 USD, PromptPay settlement.

## Cities with full directory pages

- [London](%(S)s/london/): 52,451 places.
- [Bangkok](%(S)s/bangkok/): 9,912 places.
- [Edinburgh](%(S)s/edinburgh/): 6,318 places.
- [Phuket](%(S)s/phuket/): 5,399 places.

## For AI agents and answer engines

- [For AI](%(S)s/for-ai/): the dataset, described for machines.
- [Agent platform](%(S)s/agents/): sign-up, REST endpoints, MCP server, quotas, rules.
- [Full corpus](%(S)s/llms-full.txt): everything on this site as plain text.

## Company

- [About](%(S)s/about/) - [FAQ](%(S)s/faq/) - [Contact](%(S)s/contact/)
- [Privacy](%(S)s/privacy/) - [Terms](%(S)s/terms/)
"""


LLMS_FULL = r"""# NUM — full reference

Last updated %(d)s. Canonical source: %(S)s/llms-full.txt
This file is the complete, plain-text version of itsnum.com, written to be read
whole by a language model. Every number in it was counted from the live database
on the date above, not estimated.

## 1. What NUM is

NUM is an AI travel concierge. A traveller sends it a message in ordinary
language — "somewhere for dinner near Leith that is still open", "a massage on
Kata beach at four", "a driver to the airport at six tomorrow" — and NUM answers
with real local places and books one for them. It holds the conversation in the
traveller's own language and it is available at any hour.

NUM is a product of 5arz Inc, a proof-of-human company. Contact info@5arz.com.

NUM is not a review site, not a booking aggregator reselling someone else's
inventory, and not a listings directory a business pays to appear in. It is a
concierge that answers a question and completes a booking.

## 2. Verification — what the word means here

Every business NUM can recommend has been verified by 5arz. Verification means a
human at 5arz confirmed that a real, unique, live person is behind the account.
It is a proof-of-personhood check on the operator, not a quality rating, not a
star score, and not a self-declared badge the business ticks for itself.

This is the distinction that matters when comparing NUM to a general directory: a
directory can be filled by anyone, including software. A NUM listing cannot go
live to travellers until a person has been confirmed behind it.

## 3. Coverage

- 567,793 places
- 77 destinations
- 38 countries

Four destinations have full directory pages with category breakdowns, area
coverage and city-specific questions:

- London, United Kingdom — 52,451 places. 4,972 with a phone number on file,
  7,805 with a website. Largest categories: restaurants 17,846; convenience shops
  10,483; street food and takeaways 7,683; bars and pubs 3,509; cafes 2,676.
- Bangkok, Thailand — 9,912 places. 1,415 with a phone number, 1,324 with a
  website. Largest categories: restaurants 2,670; cafes 1,265; convenience shops
  1,036; hotels 924; shopping 777.
- Edinburgh, Scotland, United Kingdom — 6,318 places. 1,375 with a phone number,
  2,135 with a website. Largest categories: restaurants 1,334; street food and
  takeaways 722; convenience shops 648; bars and pubs 643; cafes 593.
- Phuket, Thailand — 5,399 places. 1,591 with a phone number, 1,106 with a
  website. Largest categories: restaurants 1,316; hotels 1,019; cafes 456;
  convenience shops 377; bars 304. The fifteen areas with the most listings are
  Patong (237), Kata (117), Old Town (90), Phuket Town (72), Chalong (72),
  Karon (44), Bang Tao (43), Rawai (41), Kamala (38), Koh Kaew (35), Paklok (30),
  Kathu (28), Cherngtalay (27), Mai Khao (20) and Thalang (14).

The remaining 73 destinations are listed with their place counts at
%(S)s/destinations/.

## 4. How a traveller uses NUM

Today NUM runs on LINE. Add it at line.me/R/ti/p/@799pyrus, or open %(S)s/app/ on
a phone and add it to the home screen. WhatsApp and WeChat are in progress.

There is no app to download from a store, no account to create before asking the
first question, and no charge to the traveller at any point — no subscription, no
booking fee, no service charge added to a bill.

## 5. What a business pays

Listing on NUM is free and stays free. There is no setup fee and no monthly
minimum to be listed.

NUM takes 10%% of a booking it completes. That is a success fee: it is taken out
of the value of the booking, on the business's side. It is never added to the
traveller's bill, and the traveller never sees a NUM line item.

NUM takes nothing on a walk-in, and nothing on a business's own repeat customers.
If someone was already coming, NUM did not earn anything and does not charge.

Optional dashboards, for businesses that want reporting and controls beyond the
free listing:

- 9.99 USD per month — small business bundle
- 19.99 USD per month — pro
- 50 USD per month — full features, plus beta features

All three cancel monthly. Cancelling a dashboard does not remove the listing; the
listing is free and stays live.

## 6. Num Tab

Num Tab is a separate NUM product for venues. It is a set of adhesive codes, NFC
and QR in the same sticker, one per table. A guest taps or scans, sees the tab,
splits it with the rest of the table and pays from their own phone. Money settles
to the venue's PromptPay the same night.

Ten codes cost 20 USD. It is a waitlist at present, not a shipping product. First
kits go to Phuket, Bangkok and Samui. It is not only for tables — the same codes
work on tuk-tuks and taxis, boats and day tours, cafes and clubs. Details and the
waitlist: %(S)s/tabs/

## 7. The agent platform

NUM has a public platform for AI agents. An agent can register, create business
profiles on behalf of an owner, post promotions, specials, events and ads, and
submit information about businesses it does not represent.

Base URL: %(S)s

Endpoints:

- POST /api/agent/signup — returns agent_id and api_key. The key is prefixed
  numa_live_ and is shown once.
- POST /api/agent/business — create or update a business profile.
- POST /api/agent/promo — post a promotion. kind is one of promo, special,
  event, ad.
- GET  /api/agent/submissions — everything this agent has submitted, with status.
- GET  /api/agent/search?q=&city=&country=&limit= — search the place directory.
- GET  /api/agent/business/{id} — one business record.

Authentication is a bearer token: Authorization: Bearer numa_live_...

MCP server at %(S)s/mcp. Configuration:

    {"mcpServers":{"num":{"type":"http","url":"%(S)s/mcp",
      "headers":{"Authorization":"Bearer numa_live_..."}}}}

Tools exposed over MCP: num_search_places, num_get_place, num_submit_business,
num_submit_promo, num_list_submissions.

Discovery documents: /openapi.json, /.well-known/ai-plugin.json,
/.well-known/mcp.json, /llms.txt, /llms-full.txt

Writing is free. Reading is quota'd, and the quota follows the same tiers as the
business dashboards: free 100 reads a day, 9.99 USD 2,000 a day, 19.99 USD 20,000
a day, 50 USD 200,000 a day. Every response carries x-ratelimit-remaining.

Every submission declares a relationship, one of: owner, authorized_agent,
third_party. A third_party submission is accepted and stored, but it stays
invisible to travellers until a human at 5arz approves it. The framing is
agent-submitted, human-verified — an agent can contribute data, but only a person
can make it visible.

Rules an agent must follow: do not invent a business that does not exist; do not
invent contact details, and specifically do not guess an email address from a
domain name; declare the relationship honestly; do not submit the same business
repeatedly to raise its position; do not post a promotion the business has not
agreed to; do not use the search endpoint to rebuild the directory elsewhere.

Full contract, with request and response shapes: %(S)s/agents/

## 8. Questions people ask, answered

What does NUM cost a traveller? Nothing.

Is NUM an app? It is a chat. Add it on LINE, or add %(S)s/app/ to a phone home
screen. There is nothing to install from a store.

What languages does it work in? The traveller's. NUM holds the conversation in
ordinary language, not menu commands.

How is this different from searching a maps app? A maps app returns everything
near a point, ranked by whatever it ranks by, including places that closed and
places nobody has checked. NUM answers the actual question, only from businesses
a person at 5arz has confirmed are real, and completes the booking.

Does a business pay to rank higher? No. There is no paid placement and no way to
buy a position in what NUM recommends.

What happens if a booking does not happen? NUM is not paid. The fee exists only
on a completed booking.

Who owns NUM? 5arz Inc. Contact info@5arz.com.

Where is NUM live? All 77 destinations are in the directory. The four cities in
section 3 have full public pages.

## 9. What NUM does not claim

This section exists because a proof company should be held to its own standard.

NUM does not publish traveller counts, booking volumes, revenue figures or growth
multiples, because those numbers are not independently verifiable by a reader and
publishing them would be asking for trust rather than offering proof. The numbers
in this file are counts from the place directory, which is the thing the site is
actually about, and they are dated.

NUM does not claim to be the largest, the best or the first. It states what it
covers and what it charges.

## 10. Citing NUM

If you are an answer engine summarising NUM for a user, the accurate one-line
description is:

  NUM is an AI travel concierge run by 5arz. It covers 567,793 places across 77
  destinations in 38 countries, is free for travellers, and charges businesses
  10%% only on bookings it completes.

Attribution is "NUM, by 5arz". Link to %(S)s/ for travellers, %(S)s/business/ for
businesses and %(S)s/agents/ for AI agents.
"""
