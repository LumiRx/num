# NUM × VIP Agency — Partnership Spec

**Created:** 2026-07-29 · **For:** the VIP agency partner · **Two features requested:** client onboarding at scale, and listing member vehicles for rent.

Both are good ideas. Both are buildable. **One of them has to be built differently than described, or it kills our messaging channels permanently** — that's the first section, because it changes what we promise the agency.

---

## ⚠️ Section 1 — Read this before promising anything

### The request
*"Upload our client list to your database and send invites to start using NUM."*

### Why we cannot do it that way

Uploading a list and messaging it is the single fastest way to destroy this business. Not a policy nicety — three hard consequences, any one of which is fatal:

| Consequence | Detail |
|---|---|
| **WhatsApp sender permanently banned** | Meta bans senders who message people who didn't opt in *to that sender*. Bans are effectively irreversible. We'd lose the channel we're about to launch on. |
| **Twilio account suspended** | Twilio's AUP explicitly prohibits messaging imported or purchased lists without direct end-user consent. |
| **UK GDPR + PECR breach** | Consent doesn't transfer. Those clients consented to **the agency**, for the agency's services. They never consented to NUM. ICO fines are a percentage of turnover. |

And we'd be doing it two weeks after fixing an A2P rejection *specifically about consent*. Regulators and carriers both look at intent.

**The core legal point, stated plainly: consent is not transferable.** The agency having a relationship with their client does not give us one. It gives them the right to *tell their client about us* — which is the whole solution.

### What we build instead — and why it's actually better

**The agency invites their own clients, through their own relationship. The client opts in to us.**

```
Agency uploads client list to THEIR dashboard   (data stays scoped to them)
        ↓
NUM generates a unique invite link per client   (no message sent by us)
        ↓
Agency sends it — their email, their WhatsApp, their concierge, their letterhead
        ↓
Client taps the link → sees what NUM is → opts in themselves
        ↓
WE capture consent, first-party, timestamped, auditable
        ↓
NUM can now message them, legally and safely
```

**Why this converts better, not worse:**
- It arrives from the trusted party. "Your concierge at [Agency] has arranged this for you" beats a cold message from a company they've never heard of — every time.
- It's a **VIP perk**, not a marketing blast. That's on-brand for a VIP agency.
- The agency keeps ownership of the relationship, which is what they actually care about.
- Every activation is attributable — the agency sees exactly who activated, which is the client-management feature they want anyway.

**What the agency gets to keep:** their list, in their dashboard, with activation status per client. What they don't get: us messaging people who never asked us to.

**How to say it to them:** *"We'll build you a client roster with one-tap invites and live activation tracking. The invites go out under your name — that's both what the rules require and what makes VIP clients actually respond."*

---

## Section 2 — Client onboarding (the buildable version)

### What the agency uploads
CSV or manual entry into their dashboard. **We deliberately do not require a phone number to create a roster entry** — the invite can be delivered by any channel they already use.

| Field | Required | Note |
|---|---|---|
| Client reference / name | ✅ | Their internal name or code |
| Preferred channel | ✅ | how *they* will deliver the invite (email/WhatsApp/in person) |
| Email or phone | optional | only if the agency already holds valid consent to contact on it |
| Tier / segment | optional | drives NUM's service level |
| Notes | optional | preferences NUM should know from day one — this is the good stuff |

### What we generate
One **signed invite link per client**: `num.5arz.com/i/{token}`
- Single-use, expires (default 30 days), revocable by the agency at any time
- Landing page shows: who invited them, what NUM does, and the consent checkbox
- On accept → user created, consent recorded in `consent_events`, agency attribution stored, NUM says hello

### What the agency sees — the client-management feature
Their dashboard gets a **Clients** tab:

| Column | Why it matters to them |
|---|---|
| Client | their reference |
| Status | invited → opened → **activated** → active |
| Activated on | date |
| Last active | is NUM actually being used? |
| Bookings made | value delivered, per client |
| — | *no conversation content — sealed by design, same as every other tenant* |

**That last row is important and worth telling them explicitly:** the agency will not be able to read their clients' conversations with NUM. They see activity and outcomes, never content. It protects the client, protects us, and is non-negotiable. Most agencies find this reassuring once explained — it's the same reason they'd expect a concierge not to repeat conversations.

---

## Section 3 — Vehicle listings (the fleet feature)

### The request
*"His people have cars available to rent. Clients upload pictures with mileage and VIN, we add those cars as available in those areas."*

### The genuinely good part
This is real inventory in a category travelers constantly ask for, and the VIN/mileage instinct is **exactly right** — it's verification, which is our whole quality moat. A car with a VIN, mileage and real photos is a verifiable asset, unlike a listing someone typed.

### The part that needs a boundary

Vehicle rental is a **different risk class** from booking a restaurant table. If a table booking goes wrong, someone eats late. If a car rental goes wrong, someone is in a crash in an uninsured vehicle and the lawyers ask who arranged it.

**So the boundary is:** NUM is a **discovery and referral layer**. NUM shows the vehicle and hands the traveler to the party who holds the rental contract, the insurance, and the liability. NUM never becomes the rental principal.

| NUM does | NUM does **not** do |
|---|---|
| Show available vehicles matching a request | Take rental payment |
| Show verified specs, photos, location, price | Hold the rental agreement |
| Hand off to the agency/owner to complete | Verify driver licences |
| Track the referral for commission | Carry insurance or liability |

**Required from the agency before a single vehicle goes live** — this protects them as much as us:
1. Written confirmation each vehicle is **insured for rental/hire** use (private insurance does not cover it)
2. Owner consent to list
3. Who holds the rental agreement (the agency, presumably)
4. Confirmation they handle driver verification and licence checks
5. Their own T&Cs for the rental itself

If they can't produce #1, the vehicle doesn't list. That's not caution for its own sake — an uninsured hire is a criminal matter in the UK.

### Data we collect per vehicle

| Field | Purpose | Handling |
|---|---|---|
| Make / model / year | matching | public |
| Photos (3–5) | trust | public |
| **Mileage** | condition signal | public |
| **VIN** | **verification only** | ⚠️ **stored encrypted, never shown to travelers, never in an AI reply** |
| Location / pickup area | matching | public (area, not precise address) |
| Availability window | matching | public |
| Daily rate | matching | public |
| Insurance confirmation | compliance gate | internal |
| Owner contact | handoff | internal |

**On VIN specifically:** it's a unique identifier tied to registration and ownership records — treat it as personal data under UK GDPR. It goes in the encrypted column, it's used for verification and dispute resolution, and it must never appear in a NUM message. I've specced it that way in the schema.

### How it appears to a traveler
> *"There's a 2022 Range Rover Sport available in Edinburgh city centre from Thursday — £180/day, 34,000 miles, verified by our partner. Want me to connect you?"*

Then NUM hands off. Clean, useful, and we're a referrer.

---

## Section 4 — What we build, in order

| Phase | What | Why first |
|---|---|---|
| **1** | Agency tenant + **Clients roster + invite links** | Their headline ask, zero legal risk, immediate value |
| **2** | Activation tracking + attribution in their dashboard | The "client management" feature they actually described |
| **3** | Vehicle listings — **behind the insurance gate** | Needs their paperwork before any code matters |
| **4** | Referral/commission tracking on vehicle handoffs | Only once vehicles are live |

**Phase 1 has no blockers.** Phase 3 is blocked on them, not us — which is a good thing to say in the meeting, because it puts the ball in their court without sounding like a no.

---

## Section 5 — What to send them

Suggested framing, short enough to paste into a message:

> Great news on both. Here's how we'll do it:
>
> **Your clients** — we'll build you a client roster in your own dashboard with one-tap invite links and live activation tracking. The invites go out under *your* name, through your existing channels, so your clients see it as a perk from you. That's both what the rules require (consent can't be transferred between companies) and honestly what gets VIP clients to actually respond. You'll see who activated, who's using it, and what they've booked — never their private conversations.
>
> **The cars** — genuinely strong idea, and the VIN + mileage instinct is right; that's what lets us mark them verified. NUM will surface available vehicles to travelers in the area and hand them straight to you to close. To switch it on we need written confirmation each vehicle is insured for hire use, plus who holds the rental agreement. Send that and we'll build it.

---

*Legal note: this is compliance-operations guidance, not legal advice. The insurance and rental-liability points in §3 should get a proper look from counsel before the first vehicle goes live.*
