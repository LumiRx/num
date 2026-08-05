#!/usr/bin/env python3
"""
Split the lead list into what can defensibly be emailed and what cannot.

The raw file is ~24k business addresses scraped from OpenStreetMap and Overture.
Nobody on it opted in, and the list is overwhelmingly European — which means the
question "can we email this?" has a different answer in every country, and in
two of them the answer is a straightforward no.

This script does not decide whether to send. It sorts the list into buckets with
the reason attached to every row, so a send is always drawn from a filtered file
rather than from the raw one. The reason travels with the address because in six
months nobody will remember why Hungary was in the review pile.

    python3 leads/segment.py            # writes leads/segments/
    python3 leads/segment.py --summary  # counts only, writes nothing

NOT LEGAL ADVICE. The tiers below encode a cautious reading of published
regulator guidance; a lawyer should confirm before the first send, particularly
for TIER_B.
"""
import argparse, csv, os, re, sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'leads_email_validated.csv')
OUT = os.path.join(HERE, 'segments')

# ── Jurisdiction tiers ────────────────────────────────────────────────────
#
# BLOCKED — prior consent required for advertising email, business or not.
#   DE  UWG §7: unsolicited email advertising is an "unzumutbare Belästigung".
#       Enforced privately through Abmahnung, typically €500–2,000 a time, by
#       competitors and Wettbewerbsvereine who do this at industrial scale.
#   AT  TKG §174: same shape, administrative fines.
#   CH  UWG Art. 3(1)(o): mass advertising without consent is unfair competition.
# These are not "risky", they are prohibited without consent. No filter on
# address type rescues them.
BLOCKED = {'DE', 'AT', 'CH'}

# PERMITTED_WITH_OPT_OUT — B2B email to a corporate subscriber is lawful
# provided the recipient can opt out and the sender is identified.
#   GB  PECR reg. 22 applies to individual subscribers; corporate subscribers
#       (limited companies, LLPs) sit outside it. Sole traders and unincorporated
#       partnerships count as individuals — which is precisely why the
#       role-vs-personal split below matters more than the country does.
#   IE  SI 336/2011 reg. 13, same corporate-subscriber distinction.
PERMITTED_WITH_OPT_OUT = {'GB', 'IE'}

# REVIEW — a professional B2B message with a clear opt-out is broadly tolerated,
# but the details differ per country and several read closer to opt-in. Not sent
# until someone has actually checked the specific market.
#   FR  CNIL: B2B allowed where the message relates to the person's profession.
#   ES LSSI · IT Garante · NL · SE · PT · GR · DK · CZ · HU: mixed regimes.
REVIEW = {
    # EU/EEA — professional B2B tolerated to varying degrees, all need a check.
    'FR', 'ES', 'IT', 'NL', 'SE', 'PT', 'GR', 'DK', 'CZ', 'HU', 'HR', 'IS',
    'BE', 'PL', 'FI', 'NO', 'SK', 'SI', 'EE', 'LV', 'LT', 'LU', 'MT', 'CY', 'BG', 'RO',
    # Rest of world where Num has destinations. Each has its own regime and
    # none has been assessed — listing them here is not approval, it is a
    # reminder that "not in BLOCKED" must never be read as "safe to send".
    #   TH PDPA · SG PDPA (strict, opt-in) · AE · JP APPI · KR PIPA (strict)
    #   HK PDPO · MY PDPA · VN · ID · PH · IN DPDP · LK · MU · MV · TR KVKK
    #   US CAN-SPAM (opt-out, most permissive) · CA CASL (strict, opt-in)
    #   MX · BB · BS · JM
    'TH', 'SG', 'AE', 'JP', 'KR', 'HK', 'MY', 'VN', 'ID', 'PH', 'IN', 'LK',
    'MU', 'MV', 'TR', 'US', 'CA', 'MX', 'BB', 'BS', 'JM',
}

# ── Address shape ─────────────────────────────────────────────────────────
#
# A role address (info@, reservations@) belongs to the business. A named address
# (maria@, j.schmidt@) is personal data under GDPR whatever it is used for, and
# the softer B2B carve-outs mostly do not reach it. Splitting on this is the
# single highest-value filter in the file: it is 13,363 of 24,291 rows.
ROLE = re.compile(
    r'^(info|contact|hello|office|mail|e?mail|reservations?|booking|bookings|'
    r'kontakt|reception|enquir\w+|sales|admin|team|shop|store|restaurant|hotel|'
    r'welcome|hi|post|service|customer\w*|support|orders?|events?)@', re.I)

# ── Is this even our audience? ────────────────────────────────────────────
#
# The list came from OpenStreetMap, which does not know what a travel concierge
# is for. The GB slice alone contains Bath Abbey, two hospitals, a university,
# seven dentists, a pawn shop and a pet groomer. Writing to them is wasted send,
# and worse: someone who obviously is not the audience is far likelier to mark
# it as spam, which costs the sending domain for everyone else.
#
# A denylist rather than an allowlist, because the useful tail is genuinely
# long — "Camera Obscura" and "Hot Air Balloons Tour" are exactly the kind of
# thing a guest asks Num about, and enumerating every good category would miss
# them. Places of worship survive only where the category marks them as a
# visitor attraction ("Attraction · church"), which is a real thing a traveller
# asks about; a congregation's parish office is not.
NOT_AUDIENCE = re.compile(
    r'(?<!attraction · )(church|mosque|synagogue|temple|place of worship)'
    r'|hospital|dentist|pharmac|doctor|medical|clinic|hearing aid|optician|eyewear'
    r'|weight loss|nutrition|life coach|vitamin|supplement'
    r'|university|school(?! of )|nursery'
    r'|pawn|appliance|office equipment|computer store|audio visual|wholesale'
    r'|pet (sitting|services|groomer)|automotive dealer|ev charging'
    r'|carpet|home goods|thrift|party supply|hobby shop|toy store', re.I)


def classify(row):
    """Return (bucket, reason). One row, one verdict, always with a why."""
    country = (row.get('country') or '').upper()
    email = (row.get('email') or '').strip()
    category = (row.get('category') or '').strip()

    if row.get('email_status') != 'ok':
        return 'excluded_undeliverable', f"validation: {row.get('email_status') or 'unknown'}"
    if not email or '@' not in email:
        return 'excluded_undeliverable', 'no address'

    if NOT_AUDIENCE.search(category):
        return 'excluded_not_audience', (
            f'category "{category}" is not a travel-concierge listing — '
            f'a recipient who was never the audience is the likeliest to report spam')

    if country in BLOCKED:
        return 'excluded_consent_required', (
            f'{country}: prior consent required for advertising email (DE UWG §7 / '
            f'AT TKG §174 / CH UWG 3(1)(o)) — private enforcement via Abmahnung')

    is_role = bool(ROLE.match(email))
    if not is_role:
        return 'excluded_personal_address', (
            f'{country}: named individual mailbox — personal data under GDPR; '
            f'B2B corporate-subscriber carve-outs do not reach it')

    if country in PERMITTED_WITH_OPT_OUT:
        return 'send_ready', (
            f'{country}: role address at a business — corporate subscriber, '
            f'lawful with sender identity + working opt-out (PECR reg.22 / SI 336/2011 reg.13)')
    if country in REVIEW:
        return 'review_per_country', (
            f'{country}: role address, professional B2B — permitted in some readings, '
            f'opt-in in others. Confirm this market before sending.')
    return 'review_per_country', f'{country}: jurisdiction not yet assessed'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--summary', action='store_true', help='counts only, write nothing')
    args = ap.parse_args()

    if not os.path.exists(SRC):
        sys.exit(f'missing {SRC}')

    with open(SRC, newline='', encoding='utf-8') as fh:
        rows = list(csv.DictReader(fh))

    buckets, reasons = {}, Counter()
    for r in rows:
        bucket, why = classify(r)
        r['segment_reason'] = why
        buckets.setdefault(bucket, []).append(r)
        reasons[bucket] += 1

    order = ['send_ready', 'review_per_country', 'excluded_consent_required',
             'excluded_personal_address', 'excluded_not_audience', 'excluded_undeliverable']
    total = len(rows)
    print(f'{"segment":<28}{"rows":>8}{"share":>9}')
    print('-' * 45)
    for b in order:
        n = reasons.get(b, 0)
        print(f'{b:<28}{n:>8}{n / total * 100:>8.1f}%')
    print('-' * 45)
    print(f'{"TOTAL":<28}{total:>8}')

    if args.summary:
        return

    os.makedirs(OUT, exist_ok=True)
    fields = list(rows[0].keys())
    for bucket, items in buckets.items():
        path = os.path.join(OUT, f'{bucket}.csv')
        with open(path, 'w', newline='', encoding='utf-8') as fh:
            w = csv.DictWriter(fh, fieldnames=fields)
            w.writeheader()
            w.writerows(items)
        print(f'  wrote {path}  ({len(items)} rows)')

    # Country × bucket, so the marketing team can see where the volume actually
    # is rather than asking for "the list" and getting a number with no shape.
    with open(os.path.join(OUT, 'by_country.csv'), 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['country', 'segment', 'rows'])
        pair = Counter((r.get('country', ''), classify(r)[0]) for r in rows)
        for (c, b), n in sorted(pair.items(), key=lambda kv: -kv[1]):
            w.writerow([c, b, n])
    print(f'  wrote {os.path.join(OUT, "by_country.csv")}')


if __name__ == '__main__':
    main()
