# Fixing the rejected campaign — paste-ready

Campaign `CMe79ec4b4fb42d1790e585495e87b27e0` · Brand `BN1431cc624e18b5df636e25e57a9c6a80`
Rejected: *"issues verifying the Call to Action (CTA) provided for the campaign."*

## Why it was rejected

The submission sent the reviewer to **`itsnum.com/whatsapp`**. That URL is a redirect
stub — 1,570 bytes reading "Taking you to Num…" that JavaScript-redirects to `/app`.
No form, no checkbox, no consent language. Verified live 21 Aug.

The real opt-in page is **`itsnum.com/sms`** (HTTP 200, 8,519 bytes, working form):

```html
<input type="checkbox" id="sms_consent" name="sms_consent" required>
```
> "Text me about my NUM travel concierge requests and bookings. Message frequency
> varies. Message and data rates may apply. Reply HELP for help, STOP to opt out.
> See our Privacy Policy and Terms of Service."

Not pre-checked. Carries opt-in language, frequency, rate disclosure and both keywords.

Two independent failures, either one fatal:
1. **Wrong URL** — nothing at `/whatsapp` for a reviewer to verify.
2. **Quoted consent text does not match the live page** — the submitted wording
   ("I agree that NUM may message me about my bookings…") drops frequency, drops
   rates, drops HELP. A reviewer comparing submission to page sees a mismatch.

Click **Fix Campaign** and replace these three fields.

---

## 1 · "How do end-users consent to receive messages?" — THE field that failed

```
End-users consent through a public web form at https://itsnum.com/sms

The traveller types their own mobile number into the form and ticks a consent checkbox
that is unchecked by default and reads, verbatim: "Text me about my NUM travel concierge
requests and bookings. Message frequency varies. Message and data rates may apply. Reply
HELP for help, STOP to opt out. See our Privacy Policy and Terms of Service."

The checkbox is required by the server, not only the browser: a submission without it is
rejected and no number is stored. Consent is not bundled with any other agreement, is not
a condition of creating a NUM account or of any purchase, and the mobile number field in
the NUM app is optional. We store the exact wording shown, its version, the timestamp and
the IP address against the number, so any individual consent can be produced on request.

A traveller may also opt in by texting our published number first, which is itself
consent for that conversation.

Message frequency varies. Message and data rates may apply. Reply STOP, END, CANCEL,
UNSUBSCRIBE or QUIT to stop. Reply HELP for help.

Privacy Policy: https://itsnum.com/privacy - section 7a states that no mobile information
will be shared with third parties or affiliates for marketing or promotional purposes.
Terms of Service: https://itsnum.com/terms - section 5 covers the text messaging program.
```

## 2 · Description

```
NUM is an AI travel concierge operated by 5arz (itsnum.com). This campaign lets a
traveller reach their concierge by text message and receive replies and updates about the
arrangements they have asked us to make: a restaurant table, a car, an itinerary for the
day. The purpose is customer care and transactional service updates. We send no marketing,
no promotions and no third-party content.

How the end-user opts in. A traveller visits https://itsnum.com/sms, enters their own
mobile number, and ticks a consent checkbox that is unchecked by default and reads: "Text
me about my NUM travel concierge requests and bookings. Message frequency varies. Message
and data rates may apply. Reply HELP for help, STOP to opt out. See our Privacy Policy and
Terms of Service." We store that exact wording, its version, the timestamp and the IP
address against the number. A traveller may also opt in by texting our published number
first, which is itself consent for that conversation.

Message frequency varies. Message and data rates may apply.

We never buy, rent or scrape numbers. Consent is never bundled with another agreement and
never pre-ticked, and opting in is not a condition of creating an account — the mobile
number field at sign-up is optional.
```

## 3 · "Sending messages with embedded phone numbers?" → change **Yes** to **No**

Neither sample contains a phone number to call, and neither does any message this campaign
sends. Declaring Yes invites a scrutiny tier the traffic does not warrant, and a declared
attribute the samples contradict is a mismatch a reviewer can see for themselves.

Leave **embedded links = Yes** — that one is true. Booking confirmations carry signed
`itsnum.com/b/...` links, and declaring No while sending links is a suspension, not a
rejection.

---

## Samples — keep, they already pass

Both name the brand and carry opt-out, which is the rule reviewers check:

> NUM: Hi [First Name] – you're set up with your travel concierge. Text me for a table, a
> driver, or a plan for the day and I'll sort it. More at itsnum.com. Reply HELP for help,
> STOP to unsubscribe.

> NUM: Your table at [Business Name] is confirmed for [Day] [Time], [Party Size] people.
> Details: itsnum.com/b/[Booking Code]. Reply CHANGE to move it, STOP to unsubscribe.

Do **not** switch to a public URL shortener in these. bit.ly and friends are forbidden;
`itsnum.com/b/...` is a branded domain and is correct.

---

## Worth doing while you are in there

**Help Message.** Twilio's default is *"Reply STOP to unsubscribe. Msg&Data Rates May
Apply."* — it does not name the brand or offer a route to a human. Messaging Service →
Opt-Out Management, replace with the reply now implemented in `worker/sms.mjs` (125
chars, one segment):

```
NUM travel concierge. Msg&data rates may apply. Msg freq varies. Reply STOP to opt out. Help: info@5arz.com or itsnum.com/sms
```

**Sub-use-cases.** If verification moves to Twilio Verify, drop `2FA` and keep
`ACCOUNT_NOTIFICATION` + `CUSTOMER_CARE`. Mixed needs two; declaring traffic that no
longer runs on this number is what an audit finds.

**Balance.** $27.12 at last look. Confirm whether resubmitting re-charges the $15 vetting
fee before you click — a declined charge mid-resubmission stalls the clock again.

**`/whatsapp` itself.** It is a redirect stub with no consent language, and it is now on
record with TCR as a claimed opt-in URL. Either give it a real opt-in form or stop citing
it anywhere. Do not delete it — inbound links may exist — but it must never appear in a
carrier filing again.

---

## Do not touch before approval

`itsnum.com/sms`, `/privacy` and `/terms` are all live and correct. Verified 21 Aug:
privacy carries the exact carrier-mandated mobile-information sentence, and terms already
contain HELP, STOP, message frequency, data rates and the "delayed or undelivered"
carrier-liability line. A reviewer will open all three. Changing them mid-review is how a
passing check becomes a failing one.
