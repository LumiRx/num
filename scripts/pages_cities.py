# Destination pages: the /destinations hub plus deep pages for the four
# markets NUM actually works in today.
#
# Every number on these pages came out of the live D1 database on 2026-07-31
# (SELECT COUNT(*) FROM places WHERE dest = ...). Do not round them up and do
# not invent counts for cities that do not have a page. A proof company that
# guesses at its own numbers has nothing left to sell.

CC = {
    "AE": "United Arab Emirates", "AT": "Austria", "BB": "Barbados",
    "BS": "Bahamas", "CH": "Switzerland", "CZ": "Czechia", "DE": "Germany",
    "DK": "Denmark", "ES": "Spain", "FR": "France", "GB": "United Kingdom",
    "GR": "Greece", "HK": "Hong Kong", "HR": "Croatia", "HU": "Hungary",
    "ID": "Indonesia", "IE": "Ireland", "IN": "India", "IS": "Iceland",
    "IT": "Italy", "JP": "Japan", "KH": "Cambodia", "KR": "South Korea",
    "LK": "Sri Lanka", "MU": "Mauritius", "MV": "Maldives", "MX": "Mexico",
    "MY": "Malaysia", "NL": "Netherlands", "PH": "Philippines",
    "PT": "Portugal", "SE": "Sweden", "SG": "Singapore", "TH": "Thailand",
    "TR": "Türkiye", "TW": "Taiwan", "US": "United States",
    "VN": "Vietnam",
}

# (slug, name, country_code, region, places)  — live counts, 31 July 2026
DESTS = [
    ("abu-dhabi", "Abu Dhabi", "AE", "Asia", 4574),
    ("ajman", "Ajman", "AE", "Asia", 1986),
    ("al-ain", "Al Ain", "AE", "Asia", 649),
    ("dubai", "Dubai", "AE", "Asia", 8468),
    ("fujairah", "Fujairah", "AE", "Asia", 326),
    ("ras-al-khaimah", "Ras Al Khaimah", "AE", "Asia", 206),
    ("sharjah", "Sharjah", "AE", "Asia", 4526),
    ("vienna", "Vienna", "AT", "Europe", 12619),
    ("bridgetown", "Barbados", "BB", "Islands", 912),
    ("nassau", "Nassau", "BS", "Islands", 642),
    ("zurich", "Zurich", "CH", "Europe", 5978),
    ("prague", "Prague", "CZ", "Europe", 9388),
    ("berlin", "Berlin", "DE", "Europe", 19351),
    ("munich", "Munich", "DE", "Europe", 8711),
    ("copenhagen", "Copenhagen", "DK", "Europe", 6451),
    ("barcelona", "Barcelona", "ES", "Europe", 16444),
    ("ibiza", "Ibiza", "ES", "Islands", 1481),
    ("madrid", "Madrid", "ES", "Europe", 16586),
    ("mallorca", "Mallorca", "ES", "Islands", 3413),
    ("seville", "Seville", "ES", "Europe", 4443),
    ("nice", "Nice", "FR", "Europe", 3306),
    ("paris", "Paris", "FR", "Europe", 19991),
    ("bath", "Bath", "GB", "UK", 4192),
    ("edinburgh", "Edinburgh", "GB", "UK", 6318),
    ("liverpool", "Liverpool", "GB", "UK", 6539),
    ("london", "London", "GB", "UK", 52451),
    ("manchester", "Manchester", "GB", "UK", 10506),
    ("athens", "Athens", "GR", "Europe", 10619),
    ("mykonos", "Mykonos", "GR", "Islands", 381),
    ("santorini", "Santorini", "GR", "Islands", 1078),
    ("hong-kong", "Hong Kong", "HK", "Asia", 7536),
    ("dubrovnik", "Dubrovnik", "HR", "Europe", 630),
    ("budapest", "Budapest", "HU", "Europe", 9401),
    ("bali", "Bali", "ID", "Islands", 10664),
    ("dublin", "Dublin", "IE", "UK", 4830),
    ("goa", "Goa", "IN", "Asia", 3532),
    ("reykjavik", "Reykjavik", "IS", "Europe", 1316),
    ("florence", "Florence", "IT", "Europe", 4281),
    ("milan", "Milan", "IT", "Europe", 12143),
    ("rome", "Rome", "IT", "Europe", 10200),
    ("venice", "Venice", "IT", "Europe", 2167),
    ("kyoto", "Kyoto", "JP", "Asia", 6367),
    ("osaka", "Osaka", "JP", "Asia", 16195),
    ("tokyo", "Tokyo", "JP", "Asia", 19979),
    ("siem-reap", "Siem Reap", "KH", "Asia", 1344),
    ("seoul", "Seoul", "KR", "Asia", 19953),
    ("colombo", "Colombo", "LK", "Asia", 1986),
    ("mauritius", "Mauritius", "MU", "Islands", 2116),
    ("maldives", "Maldives (Malé)", "MV", "Islands", 527),
    ("cancun", "Cancún", "MX", "Islands", 1047),
    ("tulum", "Tulum", "MX", "Islands", 560),
    ("kuala-lumpur", "Kuala Lumpur", "MY", "Asia", 7517),
    ("langkawi", "Langkawi", "MY", "Islands", 771),
    ("amsterdam", "Amsterdam", "NL", "Europe", 8015),
    ("boracay", "Boracay", "PH", "Islands", 850),
    ("manila", "Manila", "PH", "Asia", 17380),
    ("lisbon", "Lisbon", "PT", "Europe", 9187),
    ("porto", "Porto", "PT", "Europe", 4797),
    ("stockholm", "Stockholm", "SE", "Europe", 6051),
    ("singapore", "Singapore", "SG", "Asia", 11276),
    ("bangkok", "Bangkok", "TH", "Asia", 9912),
    ("chiang-mai", "Chiang Mai", "TH", "Asia", 5085),
    ("phi-phi", "Koh Phi Phi", "TH", "Islands", 369),
    ("koh-samui", "Koh Samui", "TH", "Asia", 1331),
    ("krabi", "Krabi", "TH", "Asia", 936),
    ("pattaya", "Pattaya", "TH", "Asia", 5539),
    ("phuket", "Phuket", "TH", "Asia", 5399),
    ("istanbul", "Istanbul", "TR", "Europe", 15714),
    ("taipei", "Taipei", "TW", "Asia", 19986),
    ("honolulu", "Honolulu", "US", "Islands", 1747),
    ("los-angeles", "Los Angeles", "US", "Americas", 11869),
    ("miami", "Miami", "US", "Americas", 3139),
    ("new-york", "New York", "US", "Americas", 19992),
    ("orange-county", "Orange County", "US", "Americas", 7375),
    ("da-nang", "Da Nang", "VN", "Asia", 2936),
    ("hanoi", "Hanoi", "VN", "Asia", 5332),
    ("ho-chi-minh", "Ho Chi Minh City", "VN", "Asia", 5979),
]

REGION_ORDER = ["UK", "Europe", "Asia", "Islands", "Americas"]
REGION_LABEL = {
    "UK": "United Kingdom and Ireland",
    "Europe": "Europe",
    "Asia": "Asia and the Gulf",
    "Islands": "Islands and beaches",
    "Americas": "The Americas",
}

# Cities with a page of their own. Everything else on the hub is text.
DEEP = ["edinburgh", "london", "phuket", "bangkok"]

TOTAL_PLACES = sum(d[4] for d in DESTS)          # 567,793 across the directory
TOTAL_DESTS = len(DESTS)                          # 77
TOTAL_COUNTRIES = len(set(d[2] for d in DESTS))   # 38

EXTRA_CSS = """
.dwrap{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 26px;margin-top:18px}
.dwrap a{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink)}
.dwrap a:hover{color:var(--pri)}
.dwrap span{color:var(--ink2);font-size:13px;font-variant-numeric:tabular-nums}
.dwrap b{font-weight:600;font-size:15px}
.ask{background:var(--pri-xl);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin:14px 0;font-size:16px;line-height:1.6}
.ask:before{content:"\\201c"}
.ask:after{content:"\\201d"}
.stat{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;margin:30px 0 6px}
.stat div{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px 20px;box-shadow:var(--shadow)}
.stat b{display:block;font-family:'Space Grotesk',sans-serif;font-size:26px;line-height:1.1}
.stat span{font-size:13px;color:var(--ink2)}
@media(max-width:860px){.dwrap{grid-template-columns:1fr}.stat{grid-template-columns:repeat(2,1fr)}}
"""


def fmt(n):
    return "{:,}".format(n)


# ------------------------------------------------------------------ the hub

def build_hub(M):
    S = M.SITE
    title = "Destinations — %d cities in %d countries | NUM" % (TOTAL_DESTS, TOTAL_COUNTRIES)
    desc = ("NUM covers %d destinations across %d countries, with %s places in the "
            "directory. See every city NUM books in, and how many places it knows in each."
            % (TOTAL_DESTS, TOTAL_COUNTRIES, fmt(TOTAL_PLACES)))

    items = []
    for i, (slug, name, cc, region, n) in enumerate(DESTS):
        entry = {
            "@type": "ListItem",
            "position": i + 1,
            "name": "%s, %s" % (name, CC.get(cc, cc)),
        }
        if slug in DEEP:
            entry["url"] = S + "/" + slug + "/"
        items.append(entry)

    ld = M.graph(
        M.ORG, M.WEBSITE,
        M.webpage("/destinations/", title, desc,
                  crumbs=[("NUM", "/"), ("Destinations", "/destinations/")]),
        {
            "@type": "ItemList",
            "@id": S + "/destinations/#list",
            "name": "NUM destinations",
            "description": desc,
            "numberOfItems": TOTAL_DESTS,
            "itemListOrder": "https://schema.org/ItemListOrderAscending",
            "itemListElement": items,
        },
    )

    body = [M.hero(
        "%d destinations · %d countries" % (TOTAL_DESTS, TOTAL_COUNTRIES),
        "Everywhere NUM books",
        "NUM knows %s real places across %d destinations in %d countries. Ask it in any "
        "language, from anywhere, and it books the ones it can stand behind."
        % (fmt(TOTAL_PLACES), TOTAL_DESTS, TOTAL_COUNTRIES),
        '<a class="btn pri" href="/get">Get NUM free</a>'
        '<a class="btn ghost" href="/how-it-works">How it works</a>')]

    body.append("""<section class="wrap">
<div class="stat">
  <div><b>%s</b><span>places in the directory</span></div>
  <div><b>%d</b><span>destinations</span></div>
  <div><b>%d</b><span>countries</span></div>
  <div><b>&pound;0</b><span>cost to travellers</span></div>
</div>
<div class="prose" style="margin-top:34px">
<p>These counts are live, taken from the NUM directory on 31 July 2026 — not estimates.
A place being in the directory means NUM knows it exists, where it is and what it does.
It does not mean NUM will recommend it: businesses claim their listing and verify with 5arz
before NUM will put a traveller in front of them. That gap is deliberate, and it is the
whole product.</p>
<p>Four cities have a page of their own below, because they are where NUM is working hardest
right now. The rest are live in the app today.</p>
</div>
</section>""" % (fmt(TOTAL_PLACES), TOTAL_DESTS, TOTAL_COUNTRIES))

    body.append('<section class="wrap" style="padding-top:26px"><h2>Cities with a guide</h2><div class="grid3">')
    for slug in DEEP:
        row = [d for d in DESTS if d[0] == slug][0]
        body.append(
            '<a class="card2" href="/%s/" style="text-decoration:none;display:block">'
            '<h3>%s</h3><p>%s, %s &middot; %s places</p></a>'
            % (slug, row[1], CC.get(row[2], row[2]), row[3] if row[3] != "UK" else "United Kingdom",
               fmt(row[4])))
    body.append("</div></section>")

    for region in REGION_ORDER:
        rows = [d for d in DESTS if d[3] == region]
        if not rows:
            continue
        rows.sort(key=lambda r: (CC.get(r[2], r[2]), r[1]))
        body.append('<section class="wrap" style="padding-top:38px"><h2>%s</h2><div class="dwrap">'
                    % REGION_LABEL[region])
        for slug, name, cc, _r, n in rows:
            label = "<b>%s</b> <span>%s</span>" % (name, CC.get(cc, cc))
            cell = '<b>%s</b> <span>%s places</span>' % (name, fmt(n))
            if slug in DEEP:
                body.append('<a href="/%s/">%s</a>' % (slug, cell))
            else:
                body.append('<a href="/get" title="%s, %s">%s</a>'
                            % (name, CC.get(cc, cc), cell))
        body.append("</div></section>")

    body.append("""<section class="wrap" style="padding-top:44px">
<div class="prose">
<h2>Not on the list?</h2>
<p>NUM adds destinations when there is real demand and enough verified places to answer with.
If you are travelling somewhere that is not here, tell NUM anyway — the requests it cannot
answer are exactly how the next destination gets chosen.</p>
<p>If you run a business in a city on this list,
<a href="/claim/">claim your listing</a> — it is free, and stays free.</p>
</div>
</section>""")

    return M.page("/destinations/", title, desc, ld, "\n".join(body), extra_css=EXTRA_CSS)


# --------------------------------------------------------------- city pages

# Every count below came from a live D1 query on 31 July 2026 against the
# `places` table. Do not round them, do not refresh them by guessing, and do
# not add a city here until the same queries have been run for it.

CITIES = {

"edinburgh": {
    "name": "Edinburgh", "country": "United Kingdom", "cc": "GB",
    "lat": 55.9533, "lng": -3.1883, "cur": "GBP", "cursym": "&pound;",
    "places": 6318, "phone": 1375, "site": 2135,
    "cats": [("Restaurants", 1334), ("Street food and takeaways", 722),
             ("Convenience shops", 648), ("Bars and pubs", 643), ("Cafes", 593),
             ("Beauty and spa", 579), ("Shopping", 407), ("Hotels", 257),
             ("Guesthouses and B&amp;Bs", 167), ("Souvenirs and gifts", 128)],
    "areas": ["Old Town", "New Town", "Leith", "Stockbridge", "Bruntsfield",
              "Marchmont", "Morningside", "Haymarket", "Tollcross", "Southside",
              "Grassmarket", "Dean Village", "Portobello"],
    "areas_note": ("Edinburgh listings are held at street level rather than by district, "
                   "so this is the ground NUM searches, not a count per area."),
    "title": "NUM in Edinburgh — travel concierge for 6,318 places",
    "desc": ("NUM knows 6,318 places in Edinburgh — 1,334 restaurants, 643 bars and pubs, "
             "593 cafes and 257 hotels. Ask in any language, book in one message. "
             "Free for travellers."),
    "pill": "Scotland &middot; live now",
    "h1": "A concierge that already knows Edinburgh",
    "sub": ("6,318 places in the directory, 1,375 with a phone number on file. Tell NUM what "
            "you want and when, and it does the asking."),
    "intro": [
        "Edinburgh is a small city that behaves like a large one for four weeks of the year. "
        "The places worth eating in are booked out, the ones with a table free at 9pm are the "
        "ones nobody has heard of, and the difference between those two groups is not "
        "something a map app can tell you.",
        "NUM holds 6,318 Edinburgh places. 1,375 of them have a phone number on file and "
        "2,135 have a website, which is what lets NUM actually get an answer rather than "
        "hand you a pin and wish you luck. Everything below is counted from the live "
        "directory on 31 July 2026.",
        "It is free. There is no booking fee, no service charge and nothing added to your "
        "bill. Businesses pay NUM 10% of a booking it completes for them, taken out of what "
        "they already charge — which is why NUM has no reason to push you anywhere you did "
        "not ask to go.",
    ],
    "asks": [
        "We land at Waverley at six on Friday. Two people, somewhere in the Old Town that "
        "will still seat us at half nine, not a chain.",
        "My mum uses a walking stick. Find a coffee place near the Botanics with a flat "
        "entrance and a table we can actually get to.",
        "It is raining, we have three hours and a seven year old. What is open and indoors "
        "within twenty minutes of Haymarket?",
    ],
    "faqs": [
        ("How many places does NUM know in Edinburgh?",
         "6,318 as of 31 July 2026. 1,375 have a phone number on file and 2,135 have a "
         "website. Those are counts from the live directory, not estimates — if the number "
         "moves, it is because the directory moved."),
        ("Is NUM free to use in Edinburgh?",
         "Yes, and it stays free. Travellers never pay NUM anything and nothing is added to "
         "your bill. A business pays 10% of a booking NUM completes for it, out of what it "
         "already charges."),
        ("Does NUM actually book, or just recommend?",
         "It books where the business has given it a way to book — a claimed listing, a "
         "phone number or a booking link. Where it has not, NUM gives you the number, the "
         "address and the hours so you can do it in one tap, and tells you which of the two "
         "it is doing."),
        ("Is every Edinburgh listing verified?",
         "No, and we will not pretend otherwise. The 6,318 are a directory: NUM knows the "
         "place exists, where it is and what it does. A listing becomes verified when the "
         "owner claims it and passes a 5arz check. NUM tells you which kind you are looking "
         "at."),
        ("What about the Fringe and pop-up venues?",
         "Temporary venues only appear once someone lists them, because they are not in any "
         "standing dataset. If you are running a pop-up, list it free, and take it down when "
         "the run ends. Permanent places are in already."),
        ("How do I get my Edinburgh business into NUM?",
         "Claim it. It is free, it stays free, and the only money that ever changes hands is "
         "10% of a booking NUM sends you and you complete. No listing fee, no monthly "
         "minimum, nothing on walk-ins or your own repeat customers."),
    ],
    "nearby": [("London", "/london/"), ("All 77 destinations", "/destinations/"),
               ("How NUM works", "/how-it-works/"), ("List your business", "/list-your-business/")],
},

"london": {
    "name": "London", "country": "United Kingdom", "cc": "GB",
    "lat": 51.5074, "lng": -0.1278, "cur": "GBP", "cursym": "&pound;",
    "places": 52451, "phone": 4972, "site": 7805,
    "cats": [("Restaurants", 17846), ("Convenience shops", 10483),
             ("Street food and takeaways", 7683), ("Bars and pubs", 3509), ("Cafes", 2676),
             ("Beauty and spa", 1959), ("Shopping", 1956), ("Supermarkets", 1413),
             ("Hotels", 1016), ("Vehicle rental", 815)],
    "areas": ["Soho", "Covent Garden", "Shoreditch", "Mayfair", "Camden", "King's Cross",
              "South Bank", "Borough", "Notting Hill", "Islington", "Peckham", "Hackney",
              "Westminster", "Kensington", "Canary Wharf"],
    "areas_note": ("London listings are held at street level rather than by borough, so this "
                   "is the ground NUM searches, not a count per area."),
    "title": "NUM in London — travel concierge for 52,451 places",
    "desc": ("NUM knows 52,451 places in London — 17,846 restaurants, 3,509 bars and pubs, "
             "2,676 cafes and 1,016 hotels. Ask in any language, book in one message. "
             "Free for travellers."),
    "pill": "England &middot; live now",
    "h1": "52,451 London places, one message",
    "sub": ("The largest directory NUM holds anywhere. Tell it the street, the hour and the "
            "budget, and it narrows 52,451 down to the one you wanted."),
    "intro": [
        "London does not have a discovery problem. It has a filtering problem. There are "
        "17,846 restaurants in the NUM directory for this city alone, and on any given "
        "Thursday roughly all of them are findable and roughly none of them are the answer.",
        "NUM holds 52,451 London places — the biggest single-city directory it has. 4,972 "
        "carry a phone number and 7,805 carry a website, which is how NUM turns a shortlist "
        "into a table rather than a list of pins. Every figure on this page was counted from "
        "the live directory on 31 July 2026.",
        "It costs travellers nothing, and nothing is added to your bill. A business pays 10% "
        "of a booking NUM completes for it, out of the price it already charges. NUM is paid "
        "when you actually turn up somewhere you liked, which is a narrower incentive than "
        "most of what you are used to.",
    ],
    "asks": [
        "Four of us, Thursday, somewhere between London Bridge and Borough, under thirty a "
        "head, and one of us does not eat gluten.",
        "I have a two hour layover turned into eight. Left luggage near St Pancras, then "
        "something to do that is not a museum.",
        "Book me a barber near Old Street that can take me before ten tomorrow, and tell me "
        "what it costs before you book it.",
    ],
    "faqs": [
        ("How many places does NUM know in London?",
         "52,451 as of 31 July 2026 — the largest city directory NUM holds. 4,972 have a "
         "phone number on file and 7,805 have a website. Counted from the live directory, "
         "not estimated."),
        ("Does NUM cover all of London or just the centre?",
         "The directory is city-wide and held at street level, not by borough, so outer "
         "London is in it. Coverage is thickest where there is most to list, which in "
         "practice means the centre and the inner east, and thinner in residential outskirts."),
        ("Is NUM free in London?",
         "Yes. Travellers pay nothing and nothing is added to the bill. A business pays 10% "
         "of a booking NUM completes for it, out of what it already charges."),
        ("Is every London listing verified?",
         "No. 52,451 is a directory count — NUM knows the place exists, where it is and what "
         "it does. Verified means the owner has claimed the listing and passed a 5arz check. "
         "NUM says which one it is showing you every time."),
        ("Can NUM handle a group booking?",
         "It will try, and it will tell you when it cannot. Large groups usually need the "
         "venue to confirm, so NUM asks, waits, and comes back with a yes, a no or an "
         "alternative rather than a maybe."),
        ("How do I get my London business into NUM?",
         "Claim your listing. Free to list, free to stay listed, 10% only on a booking NUM "
         "sends you and you complete. Nothing on walk-ins, nothing on your own repeat "
         "customers, no monthly minimum."),
    ],
    "nearby": [("Edinburgh", "/edinburgh/"), ("All 77 destinations", "/destinations/"),
               ("How NUM works", "/how-it-works/"), ("List your business", "/list-your-business/")],
},

"phuket": {
    "name": "Phuket", "country": "Thailand", "cc": "TH",
    "lat": 7.8804, "lng": 98.3923, "cur": "THB", "cursym": "&#3647;",
    "places": 5399, "phone": 1591, "site": 1106,
    "cats": [("Restaurants", 1316), ("Hotels", 1019), ("Cafes", 456),
             ("Convenience shops", 377), ("Bars", 304), ("Massage and spa", 167),
             ("Guesthouses", 148), ("Shopping", 113), ("Street food and takeaways", 111),
             ("Beauty and spa", 92)],
    "areas": ["Patong (237)", "Kata (117)", "Old Town (90)", "Phuket Town (72)",
              "Chalong (72)", "Karon (44)", "Bang Tao (43)", "Rawai (41)", "Kamala (38)",
              "Koh Kaew (35)", "Paklok (30)", "Kathu (28)", "Cherngtalay (27)",
              "Mai Khao (20)", "Thalang (14)"],
    "areas_note": ("These are the fifteen Phuket areas with the most listings, with the "
                   "number of places NUM holds in each. Where a listing has no area on "
                   "record, NUM works from the street address instead."),
    "title": "NUM in Phuket — travel concierge for 5,399 places",
    "desc": ("NUM knows 5,399 places in Phuket — 1,316 restaurants, 1,019 hotels, 456 cafes "
             "and 167 massage and spa. Ask in any language, book in one message. Free for "
             "travellers."),
    "pill": "Thailand &middot; live now",
    "h1": "Phuket, without the tout in the middle",
    "sub": ("5,399 places on the island, 1,591 with a phone number on file. NUM asks in Thai "
            "or English, whichever gets the answer."),
    "intro": [
        "Phuket is the island NUM was built on. Almost everything a visitor does here goes "
        "through somebody — a driver who knows a place, a desk that knows a boat, a tout who "
        "knows nothing but is standing closer. The information is fine. The incentives are "
        "the problem.",
        "NUM holds 5,399 Phuket places, of which 1,591 have a phone number on file and 1,106 "
        "have a website. More hotels than anywhere else NUM covers relative to its size — "
        "1,019 of them — plus 1,316 restaurants and 148 guesthouses. Counted from the live "
        "directory on 31 July 2026.",
        "NUM is free to you and adds nothing to your bill. A business pays 10% of a booking "
        "NUM completes for it, from the price it already charges. Nobody pays to be "
        "recommended, which is the only reason a recommendation here is worth reading.",
    ],
    "asks": [
        "Longtail to Phi Phi tomorrow, two people, leaving from somewhere near Rawai. What "
        "does it actually cost and who is licensed?",
        "Kata, tonight, seafood, but not the tourist strip. Somewhere Thai families eat.",
        "My flight is at six in the morning from HKT. Who will drive me from Bang Tao at two "
        "and how much should I be paying?",
    ],
    "faqs": [
        ("How many places does NUM know in Phuket?",
         "5,399 as of 31 July 2026 — 1,316 restaurants, 1,019 hotels, 456 cafes. 1,591 have "
         "a phone number on file and 1,106 have a website. Counted from the live directory."),
        ("Which parts of the island are covered?",
         "The whole island. The heaviest coverage is Patong, Kata, Phuket Old Town, Chalong "
         "and Karon; Thalang, Mai Khao and the north-east are lighter. The area counts on "
         "this page show exactly how it is distributed."),
        ("Does NUM speak Thai?",
         "Yes. You can ask in any language, and NUM will contact a business in whichever "
         "language that business actually answers in. For most of Phuket that is Thai."),
        ("Does NUM take commission from drivers or tour desks?",
         "It takes 10% of a booking it completes, from the business, out of the price they "
         "already charge — and nothing at all from you. No business can pay to rank higher, "
         "because there is no ranking to buy."),
        ("Is every Phuket listing verified?",
         "No. 5,399 is a directory count. A listing becomes verified when the owner claims "
         "it and passes a 5arz check, and NUM tells you which of the two it is showing you."),
        ("How do I get my Phuket business into NUM?",
         "Claim your listing — free to list, free to stay. 10% only on a booking NUM sends "
         "you and you complete. Nothing on walk-ins, nothing on your own repeat customers."),
    ],
    "nearby": [("Bangkok", "/bangkok/"), ("All 77 destinations", "/destinations/"),
               ("How NUM works", "/how-it-works/"), ("List your business", "/list-your-business/")],
},

"bangkok": {
    "name": "Bangkok", "country": "Thailand", "cc": "TH",
    "lat": 13.7563, "lng": 100.5018, "cur": "THB", "cursym": "&#3647;",
    "places": 9912, "phone": 1415, "site": 1324,
    "cats": [("Restaurants", 2670), ("Cafes", 1265), ("Convenience shops", 1036),
             ("Hotels", 924), ("Shopping", 777), ("Bars", 475),
             ("Street food and takeaways", 405), ("Massage and spa", 256),
             ("Beauty and spa", 254), ("Hostels", 249)],
    "areas": ["Sukhumvit", "Silom", "Sathorn", "Siam", "Phrom Phong", "Thonglor", "Ekkamai",
              "Ari", "Chatuchak", "Ratchathewi", "Bang Rak", "Phra Nakhon", "Charoen Krung",
              "On Nut", "Ratchadaphisek"],
    "areas_note": ("Bangkok listings are held at street level rather than by khet, so this "
                   "is the ground NUM searches, not a count per area."),
    "title": "NUM in Bangkok — travel concierge for 9,912 places",
    "desc": ("NUM knows 9,912 places in Bangkok — 2,670 restaurants, 1,265 cafes, 924 hotels "
             "and 475 bars. Ask in any language, book in one message. Free for travellers."),
    "pill": "Thailand &middot; live now",
    "h1": "Bangkok is not searchable. Ask instead.",
    "sub": ("9,912 places in the directory, 1,415 with a phone number on file. Say what you "
            "want in your own language and NUM does the rest in Thai."),
    "intro": [
        "Bangkok defeats search. The good places have no website, the ones with a website "
        "are not the good places, and the reviews are six months out of date in a city that "
        "turns over faster than that. Asking someone who knows has always worked better than "
        "looking, and that is the whole shape of NUM.",
        "NUM holds 9,912 Bangkok places — 2,670 restaurants, 1,265 cafes, 924 hotels and 249 "
        "hostels. 1,415 have a phone number on file and 1,324 have a website. Counted from "
        "the live directory on 31 July 2026.",
        "Free to travellers, nothing added to your bill. A business pays 10% of a booking NUM "
        "completes for it, out of what it already charges. Nobody buys placement, because "
        "placement is not for sale.",
    ],
    "asks": [
        "Somewhere near Ari for dinner tonight, two people, Thai food, air conditioned, and "
        "under five hundred baht each.",
        "I need a tailor in Bang Rak who will finish a suit in four days and will not quote "
        "me the farang price. Ask them what they charge before you book.",
        "Sunday, no plan, staying near Phrom Phong. Where do people actually go that is not "
        "a mall?",
    ],
    "faqs": [
        ("How many places does NUM know in Bangkok?",
         "9,912 as of 31 July 2026 — 2,670 restaurants, 1,265 cafes, 924 hotels. 1,415 have "
         "a phone number on file and 1,324 have a website. Counted from the live directory, "
         "not estimated."),
        ("Can I ask in English if the business only speaks Thai?",
         "Yes — that is the point. You ask in your language, NUM talks to the business in "
         "Thai, and comes back to you in yours. The language gap is where most of Bangkok "
         "gets lost, so it is the first thing NUM removes."),
        ("Is NUM free in Bangkok?",
         "Yes, and nothing is added to your bill. A business pays 10% of a booking NUM "
         "completes for it, out of the price it already charges."),
        ("Does NUM cover street food?",
         "405 street food and takeaway listings are in the directory, but the best stalls in "
         "this city are in no dataset anywhere and never will be. NUM will tell you when it "
         "is guessing, which is more than a map will."),
        ("Is every Bangkok listing verified?",
         "No. 9,912 is a directory count. Verified means the owner claimed the listing and "
         "passed a 5arz check. NUM says which of the two it is showing you, every time."),
        ("How do I get my Bangkok business into NUM?",
         "Claim your listing. Free to list, free to stay listed, 10% only on a booking NUM "
         "sends you and you complete — nothing on walk-ins or your own repeat customers."),
    ],
    "nearby": [("Phuket", "/phuket/"), ("All 77 destinations", "/destinations/"),
               ("How NUM works", "/how-it-works/"), ("List your business", "/list-your-business/")],
},

}


# ------------------------------------------------------------- a city page

def build_city(M, key):
    S = M.SITE
    c = CITIES[key]
    name = c["name"]
    slug = "/" + key + "/"
    url = S + slug
    cat_sum = sum(n for _, n in c["cats"])
    other = c["places"] - cat_sum

    dest_node = {
        "@type": "TouristDestination",
        "@id": url + "#destination",
        "name": name,
        "alternateName": name + ", " + c["country"],
        "description": c["desc"],
        "url": url,
        "geo": {"@type": "GeoCoordinates", "latitude": c["lat"], "longitude": c["lng"]},
        "address": {"@type": "PostalAddress", "addressLocality": name,
                    "addressCountry": c["cc"]},
        "containedInPlace": {"@type": "Country", "name": c["country"]},
        "touristType": ["Leisure travellers", "Solo travellers", "Families",
                        "Business travellers"],
        "isPartOf": {"@id": S + "/#website"},
    }

    service_node = {
        "@type": "Service",
        "@id": url + "#service",
        "name": "NUM travel concierge in " + name,
        "serviceType": "AI travel concierge, recommendations and booking",
        "provider": {"@id": S + "/#organization"},
        "areaServed": {"@id": url + "#destination"},
        "audience": {"@type": "Audience", "audienceType": "Travellers"},
        "availableChannel": {"@type": "ServiceChannel", "name": "NUM chat",
                             "serviceUrl": S + "/get"},
        "offers": {
            "@type": "Offer", "price": "0", "priceCurrency": c["cur"],
            "description": ("Free for travellers. Businesses pay 10% on completed "
                            "bookings only."),
        },
    }

    ld = M.graph(
        M.ORG, M.WEBSITE,
        M.webpage(slug, c["title"], c["desc"],
                  crumbs=[("NUM", "/"), ("Destinations", "/destinations/"), (name, slug)]),
        dest_node, service_node, M.faq(c["faqs"]),
    )

    body = [M.hero(
        c["pill"], c["h1"], c["sub"],
        '<a class="btn pri" href="/get">Get NUM free</a>'
        f'<a class="btn ghost" href="/list-your-business">List your {name} business</a>')]

    body.append(f"""<section class="wrap">
<div class="stat">
  <div><b>{fmt(c["places"])}</b><span>places in {name}</span></div>
  <div><b>{fmt(c["phone"])}</b><span>with a phone number on file</span></div>
  <div><b>{fmt(c["site"])}</b><span>with a website on file</span></div>
  <div><b>{c["cursym"]}0</b><span>cost to travellers</span></div>
</div>
</section>""")

    intro = "\n".join("<p>" + p + "</p>" for p in c["intro"])
    body.append(f'<section class="wrap" style="padding-top:8px"><div class="prose">{intro}</div></section>')

    rows = "\n".join(
        f"<tr><td>{label}</td><td>{fmt(n)}</td></tr>" for label, n in c["cats"])
    body.append(f"""<section class="wrap" style="padding-top:26px">
<h2>What is in the {name} directory</h2>
<div class="prose">
<p>The ten largest categories NUM holds in {name}, counted from the live directory on
31 July 2026. Everything else — the categories with fewer than the ten below — is
grouped on the last row.</p>
<table class="tbl">
<thead><tr><th>Category</th><th>Places</th></tr></thead>
<tbody>
{rows}
<tr><td>Everything else</td><td>{fmt(other)}</td></tr>
<tr><td><b>Total</b></td><td><b>{fmt(c["places"])}</b></td></tr>
</tbody>
</table>
</div>
</section>""")

    areas = " &middot; ".join(c["areas"])
    body.append(f"""<section class="wrap" style="padding-top:26px">
<h2>Where NUM looks in {name}</h2>
<div class="prose">
<p>{areas}</p>
<p style="color:var(--ink2);font-size:14px">{c["areas_note"]}</p>
</div>
</section>""")

    asks = "\n".join(f'<div class="ask">{a}</div>' for a in c["asks"])
    body.append(f"""<section class="wrap" style="padding-top:26px">
<h2>Things people actually ask NUM in {name}</h2>
<div class="prose">
<p>Not keywords. Whole sentences, in any language, with the constraints that make the
answer useful — the time, the budget, the person who cannot manage stairs.</p>
{asks}
<p><a class="btn pri" href="/get">Ask NUM yourself</a></p>
</div>
</section>""")

    body.append(f"""<section class="wrap" style="padding-top:26px">
<h2>For businesses in {name}</h2>
<div class="prose">
<p>If you run one of the {fmt(c["places"])} places above, it is already in the directory.
Claiming it is free, and it stays free — there is no listing fee and no monthly minimum.
NUM takes 10% of a booking it sends you and you complete, out of the price you already
charge. Nothing on walk-ins. Nothing on your own repeat customers. Nothing if the booking
does not happen.</p>
<p>Claiming also fixes what the directory gets wrong: your hours, your phone number, what
you actually serve, and whether you can take a table of eight at nine on a Friday. NUM
cannot recommend what it cannot confirm, so a claimed listing is worth more than an
unclaimed one for reasons that have nothing to do with paying us.</p>
<p><a class="btn pri" href="/claim/">Claim your listing</a>
<a class="btn ghost" href="/list-your-business">How listing works</a></p>
</div>
</section>""")

    qa = "\n".join(f'<div class="qa"><h3>{q}</h3><p>{a}</p></div>' for q, a in c["faqs"])
    body.append(f"""<section class="wrap" style="padding-top:26px">
<h2>Questions about NUM in {name}</h2>
{qa}
</section>""")

    links = " &middot; ".join(f'<a href="{href}">{label}</a>' for label, href in c["nearby"])
    body.append(f"""<section class="wrap" style="padding-top:26px">
<h2>Elsewhere on NUM</h2>
<div class="prose"><p>{links}</p></div>
</section>""")

    return M.page(slug, c["title"], c["desc"], ld, "\n".join(body), extra_css=EXTRA_CSS)


def register(M):
    out = [build_hub(M)]
    for key in DEEP:
        out.append(build_city(M, key))
    return out
