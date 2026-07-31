# Company + commercial pages: /pricing, /list-your-business, /about, /faq, /contact.
# Imported by scripts/build.py, which passes the build_pages module in as M.


def offer(M, name, price, desc, url):
    o = {
        "@type": "Offer",
        "name": name,
        "price": price,
        "priceCurrency": "USD",
        "description": desc,
        "url": M.SITE + url,
        "availability": "https://schema.org/InStock",
    }
    if price != "0":
        o["priceSpecification"] = {
            "@type": "UnitPriceSpecification",
            "price": price,
            "priceCurrency": "USD",
            "unitText": "month",
        }
    return o


def register(M):
    S = M.SITE
    out = []

    # ------------------------------------------------------------------ pricing
    t = "NUM pricing — free to list, 10% only on completed bookings"
    d = ("Listing a business on NUM is free. NUM takes 10% only on bookings it completes for you. "
         "The optional dashboard is $9.99, $19.99 or $50 a month.")
    ld = M.graph(
        M.ORG, M.WEBSITE,
        M.webpage("/pricing/", t, d, crumbs=[("Home", "/"), ("Pricing", "/pricing/")]),
        {
            "@type": "Product",
            "@id": S + "/pricing/#product",
            "name": "NUM business listing and dashboard",
            "description": "A verified listing in the NUM travel concierge, plus an optional business dashboard.",
            "brand": {"@id": S + "/#organization"},
            "offers": [
                offer(M, "Verified listing", "0",
                      "A verified listing the concierge can recommend and book. No monthly fee. "
                      "NUM takes 10% of the value of a booking it completes, and nothing otherwise.",
                      "/claim/"),
                offer(M, "Small business dashboard", "9.99",
                      "Bookings, your listing, and basic performance numbers.", "/pricing/"),
                offer(M, "Pro dashboard", "19.99",
                      "Everything in Small business, plus promotions, specials and multi-location.",
                      "/pricing/"),
                offer(M, "Full dashboard", "50.00",
                      "Everything in Pro, plus API and agent access, and beta features.", "/pricing/"),
            ],
        },
        M.faq([
            ("How much does it cost to list a business on NUM?",
             "Nothing. A verified listing is free and stays free. NUM only earns when it completes a "
             "booking for you, and then it is 10% of that booking."),
            ("What is the 10%?",
             "It is a success fee on completed bookings that NUM made. If a traveller finds you some "
             "other way, or the booking does not happen, there is no fee. There is no fee on walk-ins, "
             "and no fee on your own repeat customers."),
            ("Do I have to pay for the dashboard?",
             "No. The free listing works without it. The dashboard is for businesses that want to see "
             "and change things themselves: $9.99 a month for a single small business, $19.99 a month "
             "for promotions and multiple locations, $50 a month for API and agent access plus beta "
             "features."),
            ("Can I cancel the dashboard?",
             "Yes, monthly, and your listing stays live. Cancelling the dashboard does not remove you "
             "from the concierge."),
        ]),
    )
    body = M.hero(
        "&#10022; Free to list",
        "Free to list. 10% only when we complete a booking.",
        "There is no listing fee, no setup fee and no monthly minimum. NUM earns when it sends you a "
        "booking that actually happens &mdash; and not otherwise.",
        '<a class="btn pri lg" href="/claim/">List your business</a>'
        '<a class="btn ghost lg" href="/business">How it works for business</a>',
    ) + """
<section class="wrap" style="padding-top:8px">
<table class="tbl">
<tr><th style="width:26%">What</th><th style="width:20%">Price</th><th>What you get</th></tr>
<tr>
  <td><b>Verified listing</b></td>
  <td><b>Free</b>, always</td>
  <td>A verified place the concierge can recommend, describe and book. Your hours, photos, menu or
      service list, and the languages you speak. Verification is done by 5arz, so a traveller is
      being sent to a real business, not a scraped record.</td>
</tr>
<tr>
  <td><b>Completed booking</b></td>
  <td><b>10%</b> of the booking</td>
  <td>Charged only when NUM makes a booking and that booking happens. No fee on walk-ins, no fee on
      your own repeat customers, no fee if the traveller cancels.</td>
</tr>
<tr>
  <td>Small business dashboard</td>
  <td>$9.99 / month</td>
  <td>See your bookings, edit your listing, see how many travellers were shown your place and how
      many booked. One location.</td>
</tr>
<tr>
  <td>Pro dashboard</td>
  <td>$19.99 / month</td>
  <td>Everything above, plus promotions and specials the concierge can offer, multiple locations
      under one login, and export.</td>
</tr>
<tr>
  <td>Full dashboard</td>
  <td>$50 / month</td>
  <td>Everything above, plus API keys and AI agent access, so your own assistant &mdash; or an agency's
      &mdash; can keep the listing current. Beta features first.</td>
</tr>
</table>
<p class="sub" style="margin-top:24px;max-width:70ch">Prices are in US dollars. The success fee is
taken from the booking value, not added to the traveller's bill.</p>
</section>

<section class="wrap" style="padding-top:36px">
<h2>Questions about the money</h2>
<div class="qa"><h3>How much does it cost to list a business on NUM?</h3>
<p>Nothing. A verified listing is free and stays free. NUM only earns when it completes a booking for
you, and then it is 10% of that booking.</p></div>
<div class="qa"><h3>What exactly is the 10%?</h3>
<p>A success fee on completed bookings that NUM made. If a traveller finds you some other way, or the
booking does not happen, there is no fee. No fee on walk-ins, and no fee on your own repeat
customers.</p></div>
<div class="qa"><h3>Do I have to pay for the dashboard?</h3>
<p>No. The free listing works without it. The dashboard is for businesses that want to see and change
things themselves.</p></div>
<div class="qa"><h3>Can I cancel?</h3>
<p>Yes, monthly, and your listing stays live. Cancelling the dashboard does not remove you from the
concierge.</p></div>
<div class="cta" style="margin-top:32px">
  <a class="btn pri lg" href="/claim/">List your business &mdash; free</a>
  <a class="btn ghost lg" href="/contact">Ask a question</a>
</div>
</section>
"""
    out.append(M.page("/pricing/", t, d, ld, body))

    # ------------------------------------------------- list-your-business
    t = "List your business on NUM — get found by verified travellers"
    d = ("Add your restaurant, hotel, spa, cafe, tour or shop to NUM and the AI concierge can "
         "recommend and book it for travellers in your city. Free to list, verified by 5arz.")
    ld = M.graph(
        M.ORG, M.WEBSITE,
        M.webpage("/list-your-business/", t, d,
                  crumbs=[("Home", "/"), ("List your business", "/list-your-business/")]),
        {
            "@type": "HowTo",
            "@id": S + "/list-your-business/#howto",
            "name": "How to list your business on NUM",
            "totalTime": "PT10M",
            "estimatedCost": {"@type": "MonetaryAmount", "currency": "USD", "value": "0"},
            "step": [
                {"@type": "HowToStep", "position": 1, "name": "Claim your place",
                 "text": "Search for your business at itsnum.com/claim. Most places are already in "
                         "NUM's directory, so claiming is faster than adding from scratch.",
                 "url": S + "/claim/"},
                {"@type": "HowToStep", "position": 2, "name": "Verify you are real",
                 "text": "5arz checks that a real, unique person is behind the account. This is what "
                         "lets the concierge say a place is verified.",
                 "url": S + "/how-it-works/"},
                {"@type": "HowToStep", "position": 3, "name": "Fill in what a traveller needs",
                 "text": "Hours, photos, what you serve or sell, price range, and the languages you "
                         "speak. The concierge answers questions from this."},
                {"@type": "HowToStep", "position": 4, "name": "Take bookings",
                 "text": "NUM books travellers into your place in their own language, at any hour. "
                         "You pay 10% only when a booking it made actually happens.",
                 "url": S + "/pricing/"},
            ],
        },
    )
    body = M.hero(
        "&#10022; Free, and verified",
        "Get found by travellers who are already deciding.",
        "A traveller asks NUM where to eat tonight, or where to get a massage, or who can fix a "
        "surfboard. NUM answers with real, verified places &mdash; and books one. Being listed is how "
        "you are in that answer.",
        '<a class="btn pri lg" href="/claim/">List your business</a>'
        '<a class="btn ghost lg" href="/pricing">See pricing</a>',
    ) + """
<section class="wrap" style="padding-top:8px">
<div class="grid3">
  <div class="card2"><h3>1. Claim your place</h3><p>Most businesses are already in NUM's directory of
    more than half a million places. Search for yours and claim it &mdash; that is quicker than adding
    one from scratch.</p></div>
  <div class="card2"><h3>2. Verify you are real</h3><p>5arz confirms a real, unique person is behind
    the account. That check is the reason the concierge can tell a traveller a place is verified.</p></div>
  <div class="card2"><h3>3. Say what you offer</h3><p>Hours, photos, what you serve, price range,
    languages spoken. The concierge answers travellers' questions out of this, in their language.</p></div>
</div>
</section>

<section class="wrap" style="padding-top:44px">
<div class="prose">
<h2>Why a listing here is different</h2>
<p>Most directories will list anyone who fills in a form. NUM will not. Every business is checked by
5arz, the proof-of-human company, before the concierge will recommend it. That is slower for us and
slightly slower for you, and it is the entire point: a traveller in a city they do not know is
trusting a recommendation. We would rather have fewer places and mean it.</p>
<p>The second difference is that NUM does not hand a traveller a list of ten links and leave. It is a
conversation. Someone types <i>&ldquo;somewhere quiet for dinner, near the old town, not too
expensive&rdquo;</i> and gets an answer, in any language, at any hour &mdash; and then a booking.
Being listed means being answerable in that conversation.</p>

<h2>Who lists with NUM</h2>
<ul>
  <li>Restaurants, cafes and bars that want covers on quiet nights rather than more reviews.</li>
  <li>Hotels and guesthouses with rooms left this week.</li>
  <li>Spas, salons and massage shops, where a traveller almost never knows which one is real.</li>
  <li>Tour operators, dive shops, guides and drivers.</li>
  <li>Clinics, dentists and pharmacies &mdash; where being verified matters most of all.</li>
  <li>Shops and markets that tourists reach only by accident.</li>
</ul>

<h2>What it costs</h2>
<p>The listing is free. NUM takes 10% of a booking it completes, and nothing on anything else. There
is an optional dashboard from $9.99 a month if you want to manage things yourself. The full
breakdown is on the <a href="/pricing">pricing page</a>.</p>

<h2>If someone else manages your listings</h2>
<p>Agencies, marketing companies and AI assistants can submit and maintain listings on your behalf.
Anything submitted that way is held and reviewed by a person at 5arz before a traveller ever sees it.
See <a href="/agents">NUM for AI agents</a>.</p>
</div>
<div class="cta" style="margin-top:36px">
  <a class="btn pri lg" href="/claim/">List your business &mdash; free</a>
  <a class="btn ghost lg" href="/how-it-works">How the concierge works</a>
</div>
</section>
"""
    out.append(M.page("/list-your-business/", t, d, ld, body))

    return out
