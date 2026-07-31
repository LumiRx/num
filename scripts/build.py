#!/usr/bin/env python3
"""Build every indexable page on itsnum.com.

    python3 scripts/build.py

Writes public/<slug>/index.html for each page, plus public/404.html.
Every page gets the same head: canonical, robots, OG, Twitter and JSON-LD,
so those can never drift between pages.
"""
import os
import sys

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
