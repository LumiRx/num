#!/usr/bin/env python3
"""Build every indexable page on itsnum.com.

    python3 scripts/build.py

Writes public/<slug>/index.html for each page, plus public/404.html.
Every page gets the same head: canonical, robots, OG, Twitter and JSON-LD,
so those can never drift between pages.
"""
import os
import sys

# ---------------------------------------------------------------- STALE GUARD
#
# DO NOT RUN THIS WITHOUT READING THIS NOTE.
#
# These generators stopped being the source of truth. ./public has been
# hand-edited far past them, and a regeneration is not an update — it is a
# revert. Measured 13 Sep 2026 against the live tree:
#
#     public/business/index.html        321 lines would change
#     public/pricing/index.html         154
#     public/about/index.html           105
#     public/for-ai/index.html           93
#     each destination page              89
#     /what-we-do /works-with /terms /claim /business/pricing
#                                       not generated here at all
#
# Running it would have undone the 12 Sep walk-in sweep (36 corrections) and
# the 13 Sep rate sweep (92), putting two sets of false pricing claims back on
# a live site. The generators still contain "nothing on walk-ins, nothing on
# your own repeat customers", which has been false since the $2 bill fee
# shipped.
#
# Two honest ways forward, neither of them "just run it":
#   1. Treat ./public as the source. Delete these generators. Shared <head>
#      drift is then a lint problem, not a build problem.
#   2. Port the current ./public content back into the generators, page by
#      page, and diff to empty before trusting them again.
#
# Until one of those is done, this refuses to write.

import os as _os
if not _os.environ.get('BUILD_PAGES_I_READ_THE_STALE_GUARD'):
    print(__doc__)
    print('REFUSING TO RUN: scripts/build.py is stale and would revert ./public.')
    print('See the STALE GUARD note in this file. Nothing was written.')
    raise SystemExit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build_pages as M          # noqa: E402
import pages_travel              # noqa: E402
import pages_more                # noqa: E402
import pages_company             # noqa: E402
import pages_agents              # noqa: E402
import pages_cities              # noqa: E402
import seo_files                 # noqa: E402

MODULES = [pages_travel, pages_more, pages_company, pages_agents, pages_cities]


def main():
    written = []
    for mod in MODULES:
        got = mod.register(M)
        for item in got:
            written.append(item)

    # robots.txt, sitemap.xml, llms.txt, llms-full.txt — generated from the same
    # URL list the pages come from, so the sitemap cannot fall behind the site.
    seo = seo_files.write(M)
    written += seo

    written.sort(key=lambda x: x[0])
    total = 0
    for path, size in written:
        rel = os.path.relpath(path, os.path.join(HERE, '..'))
        print('%-46s %7d' % (rel, size))
        total += size
    print('%-46s %7d  (%d pages)' % ('TOTAL', total, len(written)))


if __name__ == '__main__':
    main()
