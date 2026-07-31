# Traveller-facing and business-facing pages. Imported by build-pages.py.


def register(M):
    """M is the build-pages module (gives us page/hero/graph/webpage/faq/ORG/WEBSITE)."""
    out = []
    P, H, G, W, F = M.page, M.hero, M.graph, M.webpage, M.faq
    ORG, WEBSITE, SITE = M.ORG, M.WEBSITE, M.SITE

    # ---------------------------------------------------------------- how it works
    steps = {
        "@type": "HowTo",
        "name": "How to use the NUM travel concierge",
        "description": "Chat with NUM, get verified local recommendations, and book — in any language.",
        "totalTime": "PT2M",
        "step": [
            {"@type": "HowToStep", "position": 1, "name": "Start a chat",
             "text": "Add Num on LINE or put the web app on your home screen from itsnum.com/get. There is nothing to download from an app store."},
            {"@type": "HowToStep", "position": 2, "name": "Say what you want",
             "text": "Type in your own language. “Dinner tonight, somewhere walkable” is enough. NUM knows where you are and what is open."},
            {"@type": "HowToStep", "position": 3, "name": "Get verified picks",
             "text": "NUM only suggests businesses that have been confirmed real and approved by a human first. Every recommendation carries a verified mark."},
            {"@type": "HowToStep", "position": 4, "name": "Book it",
             "text": "NUM books the table, the tour or the ride for you and holds the booking reference in the chat."},
        ],
    }
    out.append(P('/how-it-works/',
        'How NUM works — chat, get verified picks, book | NUM',
        'NUM plans your trip in a chat, in any language, and books real local places that a human verified first. Live in 77 destinations across 38 countries. Free for travellers.',
        G(ORG, WEBSITE, W('/how-it-works/', 'How NUM works', 'How the NUM travel concierge works, step by step.',
                          [('Home', '/'), ('How it works', '/how-it-works/')]), steps),
        H('&#10022; Four steps, about two minutes',
          'You chat. NUM checks. Then it books.',
          'NUM is a travel concierge you talk to like a person. The difference is what happens behind the message: every place it can recommend has been confirmed real and approved by a human before the AI is ever allowed to suggest it.',
          '<a class="btn pri lg" href="/get">Get the app</a><a class="btn ghost lg" href="https://line.me/R/ti/p/@799pyrus">Message Num on LINE</a>') +
        """<section class="wrap prose">
<h2>1. Start a chat</h2>
<p>Add Num on LINE, or open <a href="/get">itsnum.com/get</a> and put the web app on your home screen. There is no app store download and no account to create before you can ask something.</p>
<h2>2. Say what you want, in your language</h2>
<p>&ldquo;Dinner tonight, somewhere walkable.&rdquo; &ldquo;A driver for tomorrow morning.&rdquo; &ldquo;Somewhere my kids will actually eat.&rdquo; NUM reads any language and answers in the same one. It knows where you are, what time it is, and what is actually open.</p>
<h2>3. Get picks that were checked by a person</h2>
<p>This is the part that makes NUM different from asking a general chatbot. A general model will confidently recommend a restaurant that closed in 2023, or one that never existed. NUM can only recommend from a directory of businesses that were confirmed real and approved by a human reviewer first &mdash; a check run by <a href="https://5arz.com">5arz</a>, the proof-of-human company that builds NUM.</p>
<p>If NUM has nothing verified to offer you in a category, it tells you that instead of inventing something.</p>
<h2>4. Book it in the chat</h2>
<p>NUM makes the booking &mdash; the table, the tour, the transfer &mdash; and keeps the reference in your conversation so you can find it later without digging through email.</p>
<h2>What it costs you</h2>
<p>Nothing. NUM is free for travellers. There is no subscription and no booking fee added to your bill. Businesses pay NUM a success fee only when a booking actually completes, which is why NUM has no reason to push you somewhere you did not ask for.</p>
<h2>Where it works</h2>
<p>77 destinations across 38 countries today, live on LINE, with WhatsApp and WeChat in progress. New cities are added as their local directories finish verification rather than all at once.</p>
</section>"""))

    # ---------------------------------------------------------------- perks
    out.append(P('/perks/',
        'Member perks at verified places | NUM',
        'NUM members get perks at verified local businesses — a welcome drink, a table held past cut-off, a room upgrade when one is free. Free to join, nothing to download.',
        G(ORG, WEBSITE, W('/perks/', 'NUM member perks', 'Perks NUM members get at verified local businesses.',
                          [('Home', '/'), ('Perks', '/perks/')])),
        H('&#10022; Free with every NUM account',
          'Small things, at places that are actually good.',
          'A perk is only worth having if the place is worth going to. Every business offering a NUM perk has been verified as real and approved by a human first.',
          '<a class="btn pri lg" href="/get">Get the app</a>') +
        """<section class="wrap prose">
<h2>What a perk looks like</h2>
<p>Perks are set by each business, so they vary. The common ones are a welcome drink, a table held fifteen minutes past the cut-off, a complimentary starter or dessert, a room upgrade when one is free, and priority on a fully booked tour.</p>
<p>You do not need a code or a card. When NUM books for you, the business already knows you came through NUM.</p>
<h2>How to get them</h2>
<ul>
<li>Add Num on LINE or install the web app from <a href="/get">itsnum.com/get</a>.</li>
<li>Ask for what you want. NUM flags which verified options carry a perk.</li>
<li>Book through the chat. The perk is attached to the booking.</li>
</ul>
<h2>Why businesses offer them</h2>
<p>Because a NUM booking is a real, verified person who asked for exactly what that business sells, and the business pays nothing until the booking completes. A perk is a cheap way to win that guest &mdash; and much cheaper than an ad shown to people who were never going to come.</p>
<p>If you run a business and want to offer one, <a href="/claim/">list your business</a>. Listing is free.</p>
</section>"""))

    # ---------------------------------------------------------------- business
    biz_faq = F([
        ("How much does it cost to list my business on NUM?",
         "Listing is free. There is no subscription and no setup fee. NUM takes a 10% success fee only on bookings it actually delivers and that actually complete. If NUM sends you nothing, you pay nothing."),
        ("How does NUM decide what to recommend?",
         "NUM can only recommend businesses that have been confirmed real and approved by a human reviewer. Within that verified set, it matches on what the traveller actually asked for — cuisine, distance, time, budget, language, dietary needs."),
        ("What is the optional dashboard?",
         "Listing and receiving bookings is free forever. If you want analytics, promotions, multi-location management and API access, there are three paid tiers: Small Business at $9.99 a month, Pro at $19.99 a month, and Full at $50 a month, which includes beta features."),
        ("Who verifies my business?",
         "5arz, the proof-of-human company that builds NUM. Verification confirms the business exists, is trading, and that a real person controls the listing."),
        ("Can an AI agent manage my listing for me?",
         "Yes. NUM has an agent platform with a REST API and an MCP server, so an AI assistant can create your profile, keep your hours current and post promotions on your behalf. Every agent submission is reviewed by a human at 5arz before travellers see it."),
    ])
    out.append(P('/business/',
        'NUM for Business — verified bookings, pay only on results',
        'List your business on NUM free and get bookings from travellers who asked for exactly what you sell. No subscription. A 10% success fee only on completed bookings.',
        G(ORG, WEBSITE, W('/business/', 'NUM for Business', 'How businesses get verified bookings through NUM.',
                          [('Home', '/'), ('For business', '/business/')]), biz_faq),
        H('&#10022; Free to list &middot; pay only when a booking completes',
          'Get found by travellers who are already asking.',
          'When a visitor asks NUM for dinner, a driver or a day trip, NUM answers from a directory of businesses a human has verified. Being in that directory is free. You pay a 10% success fee only on bookings NUM delivers that actually complete.',
          '<a class="btn pri lg" href="/claim/">List your business</a><a class="btn ghost lg" href="/pricing">See pricing</a>') +
        """<section class="wrap">
<div class="grid3">
  <div class="card2"><h3>No subscription to start</h3><p>Listing costs nothing and there is no setup fee. You are not buying impressions or clicks &mdash; there is nothing to spend before a booking exists.</p></div>
  <div class="card2"><h3>Pay only on completed bookings</h3><p>10% of the booking value, charged only when the booking actually completes. A no-show costs you nothing.</p></div>
  <div class="card2"><h3>Verified means checked</h3><p>Your listing is confirmed real by 5arz before it goes live. That is why travellers trust what NUM recommends &mdash; and why a fake competitor cannot outrank you.</p></div>
</div>
</section>
<section class="wrap prose">
<h2>Why this is different from a listings site</h2>
<p>Directory sites sell you visibility and hope. NUM does not show a traveller a page of options to scroll &mdash; it answers a specific question. Somebody types &ldquo;a quiet dinner near the harbour, no seafood&rdquo; and NUM returns the verified places that actually match. There is no auction, and paying more does not move you up.</p>
<h2>What you need to get listed</h2>
<ul>
<li>Your business name, address and contact details.</li>
<li>What you sell and roughly what it costs.</li>
<li>Your opening hours, and how you want bookings to reach you.</li>
<li>A person we can confirm is really connected to the business.</li>
</ul>
<p>That last one is the whole point. <a href="https://5arz.com">5arz</a> exists to prove a real, unique, live person is behind an account or an action, and NUM is that check applied to local businesses.</p>
<h2>The optional dashboard</h2>
<p>Bookings, your listing and your perk are free forever. If you want to see how travellers are finding you, run promotions, manage several locations or connect NUM to your own systems, there are three paid tiers &mdash; $9.99, $19.99 and $50 a month. <a href="/pricing">Full breakdown here.</a></p>
<h2>If you use an AI assistant</h2>
<p>You do not have to fill in forms. NUM has an <a href="/agents">agent platform</a>: give your AI assistant a NUM API key and it can build your profile, keep your hours accurate and post your specials for you. Everything an agent submits is queued for a human at 5arz to approve before a traveller can see it.</p>
<h2>Common questions</h2>
<div class="qa"><h3>How much does it cost?</h3><p>Listing is free. 10% success fee on completed bookings only.</p></div>
<div class="qa"><h3>How fast can I be live?</h3><p>As soon as verification clears. That is a human check, so it is not instant, but it is what makes the verified mark mean something.</p></div>
<div class="qa"><h3>Can I set my own perk?</h3><p>Yes, and you can change or remove it whenever you like.</p></div>
<div class="qa"><h3>What if I get a booking I cannot take?</h3><p>Decline it in the dashboard or by replying to the booking notification. NUM re-routes the traveller and you are not charged.</p></div>
<div style="margin-top:36px"><a class="btn pri lg" href="/claim/">List your business &mdash; free</a></div>
</section>"""))
    return out
