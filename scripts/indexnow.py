#!/usr/bin/env python3
"""Push every sitemap URL to IndexNow after a deploy.

IndexNow is the only "we changed, come look" channel that still exists and is
honoured. Google retired its sitemap ping in 2023 and now only discovers via
the Sitemap: line in robots.txt on its own schedule; Bing, Yandex, Seznam and
Naver all read IndexNow and act on it in minutes. Submitting is the difference
between a new page being seen today and being seen whenever a crawler next
wanders past.

Run AFTER `npx wrangler deploy`, never before — IndexNow fetches the URLs it is
told about, and pointing it at pages that are not live yet spends the
submission on a 404.

    python3 scripts/build.py && npx wrangler deploy && python3 scripts/indexnow.py
"""
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

HOST = "itsnum.com"
SITE = "https://" + HOST
UA = "NUM-indexnow/1.0 (+https://itsnum.com)"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Derived from the hostname, not random. A random key would be a new key on
# every run, and each new key orphans the one search engines have already
# verified — so submissions would start failing silently the second time.
KEY = hashlib.sha256((HOST + "/indexnow/v1").encode()).hexdigest()[:32]
KEY_URL = "%s/%s.txt" % (SITE, KEY)


def get(url):
    r = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(r, timeout=30) as f:
        return f.status, f.read().decode("utf-8", "replace")


def main():
    # The key file lives in public/ so it ships with the site like any other
    # asset. Written on every run so a fresh clone or a wiped public/ recovers
    # it without anyone having to remember it exists.
    path = os.path.join(ROOT, "public", KEY + ".txt")
    if not os.path.exists(path) or open(path).read().strip() != KEY:
        open(path, "w").write(KEY)
        print("wrote public/%s.txt — deploy before submitting" % KEY)

    try:
        st, body = get(KEY_URL)
    except urllib.error.HTTPError as e:
        print("key file %s -> %s. Deploy first, then re-run." % (KEY_URL, e.code))
        return 1
    if body.strip() != KEY:
        print("key file at %s does not contain its own key — every submission "
              "would be rejected" % KEY_URL)
        return 1

    _, sm = get(SITE + "/sitemap.xml")
    urls = [e.text.strip() for e in
            ET.fromstring(sm).iter("{http://www.sitemaps.org/schemas/sitemap/0.9}loc")]
    if not urls:
        print("sitemap.xml has no <loc> entries — nothing to submit")
        return 1

    payload = {"host": HOST, "key": KEY, "keyLocation": KEY_URL, "urlList": urls}
    req = urllib.request.Request(
        "https://api.indexnow.org/indexnow", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": UA},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as f:
            code, body = f.status, f.read()[:300]
    except urllib.error.HTTPError as e:
        code, body = e.code, e.read()[:300]

    # 200 and 202 both mean accepted; 202 is "accepted, key still being checked".
    ok = code in (200, 202)
    print("submitted %d urls -> %s %s%s" % (
        len(urls), code, body.decode("utf-8", "replace"),
        "" if ok else "  <-- NOT ACCEPTED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
