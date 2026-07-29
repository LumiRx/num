# A2P 10DLC Rejection — Diagnosis & Resubmission Pack

**Rejection:** *"The campaign submission has been reviewed and rejected because a compliant privacy policy can not be verified."*
**Verified live 2026-07-24:** `itsnum.com/privacy` ✅ reachable · `itsnum.com/whatsapp` ✅ reachable · `itsnum.com/terms` ✅ linked.

**So the URL isn't the problem. The content is.**

---

## 1 · Root cause

Your privacy policy is genuinely good — PDPA-aware, well-written, better than most. But the A2P reviewer (TCR + carrier) isn't reading it for quality. They run a **mechanical checklist for SMS-specific language**, and your policy fails three of its checks:

| What the reviewer looks for | Your policy today | Verdict |
|---|---|---|
| The mobile-data carve-out sentence — *"no mobile information will be shared with third parties or affiliates for marketing"* | Absent | ❌ **This alone causes the rejection** |
| An SMS/text-messaging program described in the policy | Policy covers LINE + WhatsApp chat only; "SMS" never appears | ❌ |
| Message frequency + data-rates + HELP/STOP disclosure | Absent | ❌ |
| Publicly reachable, no login | Yes | ✅ |
| Opt-in flow page reachable | Yes | ✅ |

**The specific trap:** §4 "When we share information" lists platform providers, service providers, and legal disclosures. A reviewer scanning for *"do they share mobile data?"* reads that section, finds sharing language, finds **no carve-out for SMS opt-in data**, and rejects. The fix is not to remove §4 — it's to add the explicit exclusion the carriers require.

**Second issue that will fail you on the next pass even after the policy is fixed:** the campaign says users opt in at `itsnum.com/whatsapp`, but that page is a **WhatsApp** signup. A2P 10DLC governs **US SMS**. The reviewer needs to see an opt-in flow that collects consent *for text messages*, with the required disclosures next to the checkbox. Right now the consent line reads *"We use your number to recognise you and to reply. We do not sell it…"* — true and honest, but missing every element the carriers mandate.

---

## 🚀 Fastest path — two files, two publishes

If you only read one section, read this. These two files are complete and verified — no fragments to place, no sections to renumber:

| File | What to do |
|---|---|
| **`privacy_REPLACE_FROM_SECTION_5.html`** | On `/privacy`, delete everything from the "5 · The business directory" heading down to (not including) the Thai summary — paste this in its place. New §5 SMS is included and §6–§12 are already renumbered. Update the "Effective" date. |
| **`sms_page_COMPLETE.html`** | Publish as-is at **`itsnum.com/sms`**. Point the form at your real endpoint, and make the server store phone + consent text + timestamp + IP. |

Then update the campaign with the §4 description below, change the opt-in URL to `/sms`, and resubmit.

*(The two smaller files — `privacy_sms_section.html` and `optin_consent_block.html` — are the same content as isolated fragments if you'd rather integrate by hand.)*

---

## 2 · Fix #1 — Add this section to the privacy policy

**Paste-ready HTML:** `privacy_sms_section.html` (matches your existing page structure — drop it in as a new §, ideally numbered **§5** right after "When we share information", then renumber the rest).

The non-negotiable sentence is the bolded one. Carriers grep for this almost verbatim — do not paraphrase it:

> **No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.** Information sharing with subcontractors who provide support services for the program — such as our cloud, AI, and messaging infrastructure — is permitted. All other use-case categories exclude text-messaging originator opt-in data and consent; this information will not be shared with any third parties.

Plain-English translation of why this works: you *are* allowed to use vendors (Twilio, Anthropic, Cloudflare). What you must promise is that the **phone number and the consent behind it** never get resold, rented, or handed to a marketing partner. Your business already works that way — this just says so in the words the reviewer is trained to find.

## 3 · Fix #2 — Rebuild the opt-in consent block

**Paste-ready HTML:** `optin_consent_block.html`.

Every element below is required. Missing any one is a rejection:

| Element | Required text |
|---|---|
| Brand/program name | "NUM travel concierge" |
| **Unchecked** checkbox | Never pre-ticked, never bundled with Terms acceptance |
| Consent purpose | "text messages about my requests and bookings" |
| Frequency | "Message frequency varies" |
| Cost | "Message and data rates may apply" |
| HELP | "Reply HELP for help" |
| STOP | "Reply STOP to opt out" |
| Links | Privacy Policy + Terms of Service, both clickable |
| Not-a-condition | "Consent is not a condition of purchase" |

Add a **`/sms` (or `/text`) page** using this block, and cite *that* URL in the campaign — not `/whatsapp`. A reviewer checking an SMS campaign should land on an SMS opt-in. Keep `/whatsapp` as-is for the WhatsApp flow; they're different channels with different rules.

## 4 · Fix #3 — Revised campaign description

Your original was decent but buried the compliance facts. Reviewers skim for consent mechanics. Use this:

> NUM is an AI travel concierge operated by 5arz (itsnum.com). Travelers text their concierge and receive replies and updates about arrangements they have asked us to make. This is customer care and transactional service messaging only — no marketing, no promotions, no third-party content, and we never message a number we did not receive direct consent from.
>
> **Opt-in:** A traveler visits itsnum.com/sms, enters their own mobile number, and ticks an unchecked consent box that reads: "Text me about my NUM requests and bookings. Message frequency varies. Message and data rates may apply. Reply HELP for help, STOP to opt out." The page displays our Privacy Policy and Terms links beside the box. Consent is never pre-checked, never bundled, and never a condition of purchase. Opt-in is also accepted when a traveler texts our number first.
>
> **Opt-out:** STOP, END, CANCEL, UNSUBSCRIBE, or QUIT stops all messages immediately and permanently; we confirm once and send nothing further. HELP returns support contact details. Both are honored automatically.
>
> **Privacy:** Our policy at itsnum.com/privacy states that no mobile information is shared with third parties or affiliates for marketing or promotional purposes, and that text-messaging opt-in data and consent are never shared with third parties.

**Sample messages** — yours were close; these tighten the required elements:

1. `NUM: Hi [First Name] — you're set up with your travel concierge. Text me for a table, a driver, or a plan for the day. Msg frequency varies. Msg&data rates may apply. Reply HELP for help, STOP to opt out.`
2. `NUM: Your table at [Business Name] is confirmed for [Day] [Time], [Party Size] people. Details: itsnum.com/b/[Booking Code]. Reply CHANGE to move it, STOP to opt out.`
3. `NUM: Your driver [Driver Name] arrives at [Time] in a [Car]. Plate [Plate]. Reply HELP for help, STOP to opt out.`

Put the full opt-out language in message #1 (the confirmation) — that's the one carriers weight most.

---

## 5 · Resubmit checklist

- [ ] Privacy policy §SMS added, **with the carve-out sentence verbatim** — publish and confirm it renders publicly
- [ ] `itsnum.com/sms` live with the compliant consent block, checkbox unchecked by default
- [ ] Privacy + Terms links visible on the opt-in page itself
- [ ] Terms of Service mentions the messaging program (one paragraph is enough)
- [ ] Campaign description replaced with §4 text, opt-in URL updated to `/sms`
- [ ] Sample messages updated — all include STOP, first one includes frequency + rates
- [ ] Confirm the number/brand registration details match your legal entity exactly (5arz), including EIN/registration number and address — mismatches here get blamed on the privacy policy
- [ ] Resubmit; typical re-review is 1–3 business days

## 6 · Worth deciding before you resubmit

**Do you actually need US A2P right now?** A2P 10DLC governs SMS sent **to US phone numbers**. Your pilot is Phuket — Chinese, Russian, Thai, and European travelers, reached primarily on **LINE, WhatsApp, and WeChat**, none of which touch this system. US A2P matters for American travelers you want to reach by plain SMS.

If SMS-to-US is a small slice of the pilot, the pragmatic sequencing is: **launch on LINE + WhatsApp now** (no A2P dependency, and LINE is already live at @799pyrus), and resubmit A2P in parallel without it blocking anything. If US SMS is core, fix and resubmit today — the fixes above are a couple of hours of work.

Either way, do the privacy-policy fix regardless: WhatsApp Business review looks for substantially similar language, and you'll want it in place before that submission.

---

*Not legal advice — this is compliance-operations guidance based on carrier/TCR review criteria. Have counsel review the final policy text before publishing if you want belt-and-braces.*
