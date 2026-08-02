#!/usr/bin/env python3
"""Validate outreach email lists before sending — born from the 17.25% merchant
bounce (89/516) that Viv's 08-01 audit flagged as ~8x the throttling threshold.

Checks per address:
  bad_syntax  — not shaped like an email at all
  no_mx       — domain has neither MX nor A record: the mail CANNOT be
                delivered; these are the guaranteed hard bounces
  ok          — domain accepts mail somewhere (mailbox may still reject,
                but the domain-level guarantee of a bounce is gone)

DNS truth beats guessing: a domain without MX/A today will bounce today,
whatever any paid validator says. (Mailbox-level verification would need
SMTP callouts, which many hosts tar-pit — domain-level is the honest,
polite check we can run ourselves.)

Usage: python3 scripts/validate_email_list.py <csv> [<csv>...]
Writes <name>_validated.csv (adds email_status column) + prints a summary.
"""
import csv, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SYNTAX = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

def has_mail(domain: str) -> bool:
    for rr in ("MX", "A"):
        try:
            out = subprocess.run(
                ["dig", "+short", "+time=2", "+tries=1", rr, domain],
                capture_output=True, text=True, timeout=6,
            ).stdout.strip()
            if out:
                return True
        except Exception:
            pass
    return False

def main(paths):
    rows_by_file, domains = {}, set()
    for p in paths:
        with open(p, newline="", encoding="utf-8-sig") as f:
            r = list(csv.DictReader(f))
        rows_by_file[p] = r
        col = next((c for c in (r[0] or {}) if "email" in c.lower()), None)
        for row in r:
            e = (row.get(col) or "").strip().lower() if col else ""
            if SYNTAX.match(e):
                domains.add(e.split("@", 1)[1])

    print(f"{sum(len(v) for v in rows_by_file.values())} rows, {len(domains)} unique domains — resolving…", flush=True)
    with ThreadPoolExecutor(max_workers=60) as ex:
        alive = dict(zip(domains, ex.map(has_mail, domains)))

    for p, rows in rows_by_file.items():
        col = next((c for c in (rows[0] or {}) if "email" in c.lower()), None)
        counts = {"ok": 0, "no_mx": 0, "bad_syntax": 0}
        out = Path(p).with_name(Path(p).stem + "_validated.csv")
        with open(out, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) + ["email_status"])
            w.writeheader()
            for row in rows:
                e = (row.get(col) or "").strip().lower() if col else ""
                st = ("ok" if alive.get(e.split("@", 1)[1], False) else "no_mx") if SYNTAX.match(e) else "bad_syntax"
                counts[st] += 1
                w.writerow({**row, "email_status": st})
        total = sum(counts.values())
        print(f"{p}: {total} rows -> ok {counts['ok']} ({counts['ok']/total*100:.1f}%) · "
              f"no_mx {counts['no_mx']} ({counts['no_mx']/total*100:.1f}%) · bad_syntax {counts['bad_syntax']}"
              f"  => {out.name}", flush=True)

if __name__ == "__main__":
    main(sys.argv[1:])
