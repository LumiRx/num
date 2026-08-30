# A2P — the link, the steps, and the faster road that runs beside it

**2026-08-21.** Two tracks. They are independent and should both start today.

| | Unblocks | Time | Blocked on |
|---|---|---|---|
| **Track A — Twilio Verify** | **Sign-in for everybody** | **~1 hour** | nothing |
| **Track B — A2P 10DLC** | Concierge SMS thread, venue booking texts | 3–4 weeks | 8 values from Andre |

---

# Track A — Verify. Sign-in works today.

## The finding

Twilio's own A2P page says it plainly:

> *"If you're only using 10DLC numbers to send user verification text messages, you can
> use Twilio Verify rather than registering for A2P 10DLC."*

**Verify traffic is exempt from A2P 10DLC.** Num sends its sign-in codes through the
Programmable **Messaging** API (`claim/verify.mjs` → `Messages.json`), which is exactly
the traffic carriers are rejecting with `30034`. Move that one call to Verify and the
codes start arriving — with no brand, no campaign, and no three-week wait.

This is not a workaround. It is the product Twilio built for this job, and it deletes
code we currently maintain: code generation, the code/expiry columns, resend throttling,
attempt counting, and SMS-pumping defence all become Twilio's problem.

## Why it matters here

Right now `num_sms_delivery` says every real send has failed `30034` — Andre's own
number included. Sign-in is closed for all 129 members. Track B fixes that in 3–4 weeks.
Track A fixes it this afternoon.

## Steps

1. **Create a Verify Service** — Console → Verify → Services → Create.
   `friendlyName` = `NUM` (it appears in the message: *"Your NUM verification code is
   123456"*). Avoid 5+ digits in the name — triggers error 60200.
   Save the `VAxxxx…` SID.

2. **Set the secret** (note the config flag, as always):
   ```
   npx wrangler secret put VERIFY_SERVICE_SID --config wrangler.app.jsonc
   ```

3. **Swap the send.** `sendCode()` in `claim/verify.mjs` posts to
   `Verifications` instead of `Messages.json`; the check posts to
   `VerificationCheck`. Two calls replace generate + store + send + compare.

4. **Cut over safely** — stand Verify up in parallel, dual-run the check while any
   legacy code is still inside its 10-minute TTL, then ramp to 100% and drop the OTP
   columns.

**Gotchas that will bite:**
- Verify is **strict E.164**. Anything else is error 60200 — which is precisely the
  12 malformed rows in §7.4 of the submission pack. **Fix those first or those members
  cannot sign in even after this.**
- A wrong code does **not** throw. It returns `status: "pending"`. Test
  `status === "approved"` explicitly.
- The code is **never retrievable** by any API, by design.
- Approved verifications are single-use; re-checking returns 404.
- Built-in limits: 5 sends and 5 checks per number per 10 min, 10-minute TTL.

**Say the word and I'll write it.** It touches `claim/verify.mjs`, `worker/social.mjs`
and their tests, and it wants the E.164 backfill alongside it.

---

# Track B — A2P 10DLC. Still needed, still start now.

Verify covers verification codes **only**. Everything else Num sends over its own
number still needs a registered campaign:

- the concierge SMS thread (the whole "text NUM and it answers" product)
- venue booking requests from `worker/bookdesk.mjs`
- anything transactional to a member

## The link

**https://console.twilio.com/us1/develop/sms/regulatory-compliance/a2p-onboarding**

Or navigate: **Console → Messaging → Regulatory Compliance → Onboarding**.
Three tabs, in this order — you cannot skip ahead.

## The decision, already made

**Low-Volume Standard Brand** + **one Low-Volume Mixed campaign**.

5arz has an EIN, so Sole Proprietor is auto-rejected under error 30915. Full Standard
costs more in vetting for throughput Num cannot use at 129 members. Registering entity
is the **Delaware C-Corp** (D-012).

Venue traffic gets **no separate campaign**: A2P governs US-destined traffic only, and
Num's venues are in Thailand, the UK and Scotland.

## Cost and clock

$19.50 to submit ($4.50 TCR brand + $15 campaign vetting), then $1.50/month plus
~$0.003/segment. Customer Profile 72h+. Brand: minutes if automated, up to 7 business
days if manual. **Campaign: Twilio's current guidance is 10–15 days.** Realistic: submit
this week, sending in 3–4 weeks.

## Steps

**1 · Customer Profile** (Business details tab) — business identity in Trust Hub.

**2 · Register Brand** — §3.1 of `A2P_10DLC_SUBMISSION.md` has every field.
**TCR emails a verification OTP to `info@5arz.com` and registration halts until it is
entered — respond within 24 hours.**

**3 · Register Campaign** — §3.2–3.6 have the description, message flow, samples and
opt-in message, all written to paste verbatim.

**4 · Attach numbers** to the campaign via a Messaging Service.

## What Andre still has to supply — eight values

| # | Field | Where it comes from |
|---|---|---|
| 1 | Legal entity name, **exactly** as filed with the IRS | Delaware certificate of incorporation, or the IRS CP-575 letter |
| 2 | EIN (`XX-XXXXXXX`) | Same number as the Coinbase W-9 |
| 3 | Street | Registered business address |
| 4 | City | |
| 5 | State (2-letter) | |
| 6 | ZIP | |
| 7 | Authorised rep mobile, E.164 | **Must not be the sending number** — same number for rep and campaign is a reviewer flag |
| 8 | One live business social profile URL | A dead link lowers the TCR trust score |

Plus two confirmations: your corporate title, and that you can open `info@5arz.com`
today for the OTP.

Name and EIN must match IRS records **character for character**. A trailing "Inc." the
IRS does not have is a rejection.

## Product blockers

| | | Status |
|---|---|---|
| **B1** | Partner SMS sent with no consent, no STOP, no receipt | ✅ **Fixed 21 Aug.** Gated on `num_sms_consent`, fails closed, brand + STOP/HELP in every body, `StatusCallback` attached. 7 tests, mutation-verified. |
| **B2** | Nothing answered HELP, while every consent surface promised it | ✅ **Fixed 21 Aug.** Answered in the Worker, one segment (125 chars), single-word only so "help me find a table" still reaches the concierge. 7 tests, mutation-verified. |
| **B3** | `/privacy` and `/terms` say *"operated by 5arz, Thailand"* — no US address, while the brand registers a Delaware entity at a US one | ❌ **Blocked on values 1–6.** A reviewer opens `website_url` first and this is the first mismatch they meet. |
| — | Junk consent row from testing | ✅ Deleted. |

**Terms must also show HELP and STOP instructions in bold** and carry *"Carriers are not
liable for any delayed or undelivered messages"* — folding that into the same B3 edit.

## One refinement to the pack, given Track A

§3.2 declares sub-use-cases `2FA`, `ACCOUNT_NOTIFICATION`, `CUSTOMER_CARE`.

**If verification moves to Verify, drop `2FA`.** Declaring traffic to a carrier that no
longer runs on that number is the kind of mismatch an audit finds, and Mixed only needs
two sub-use cases — `ACCOUNT_NOTIFICATION` + `CUSTOMER_CARE` satisfies it. The sample
messages in §3.5 must then cover only those two.

## Two things that already pass — do not touch them

- The `/sms` opt-in flow: server-side enforcement, checkbox never pre-ticked, verbatim
  wording stored with version, IP and timestamp, and a test pinning the stored wording
  to the words on the page.
- `itsnum.com/privacy` §7a carries the exact carrier-mandated sentence about mobile
  information never being shared for marketing.

Both are better than most companies bring to a TCR audit. **Do not edit either page
between now and approval** — except the B3 footer, which is required.

Worth knowing: the mobile field at signup is **optional** ("Mobile (optional — for
friends and bookings)"). Twilio rejects registrations where opting in is a condition of
creating an account. Num is on the right side of that, and it is worth saying so in the
campaign description.
