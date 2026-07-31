# AiR — the calendar, contacts and tasks brain

Code: `worker/air.mjs`. Status: `GET /api/air`.

## The split, and why it is clean

| | Handled by |
|---|---|
| Tables, cars, food, wellness, nightlife, the trip itself | **Num** |
| Availability, scheduling across attendees, contacts, reminders | **AiR** |

Num was faking the second half. The meetings specialist reasoned about free
time with no calendar behind it, and "send an invite to Dre" matched against
whatever the user happened to have typed in. AiR has the real data for both.

The model reaches it through one `air` action carrying `{tool, args}`. It is
instructed to **look a name up before acting on it** — guessing who "Dre" is and
being wrong is worse than asking.

## What we give them back — the trust envelope

Every AiR call carries `_num_trust`: what Num and 5arz can attest that AiR
cannot. That is the exchange — they hold the calendar, we hold the verification.

```json
{
  "identity":   { "verified": true, "basis": "id_check", "country": "US" },
  "uniqueness": { "attested": false, "level": null, "note": "no attestation issued" },
  "work":       { "sessions": 15, "passed": 6, "rejected": 8, "avg_score": 0.699 },
  "account":    { "age_days": 12, "phone_unique": true, "phone_verified": false }
}
```

AiR can also pull it directly: `GET /api/trust?member=<id>` with `X-Num-Key`.

**It is deliberately honest about what is proved and what is claimed**, because
a verification report that overstates itself is worth less than none — the
moment one field is wrong, nobody believes the rest.

- `identity` — **real.** 102 of 141 members carry a completed ID check.
- `work` — **real, and the interesting part.** Proof-of-human-work sessions
  scored on focus, input consistency and probe pass rate. **8 of 15 were
  rejected.** A screen that never rejects is not a screen.
- `uniqueness` — **the framework exists and has issued nothing.**
  `uniqueness_attestations` is empty: 0 rows, no levels, no JWTs. It reports
  `attested: false` and says so rather than implying a UHA exists.
- `account` — Num's own signals. `phone_unique` is true because one number means
  one account, enforced at write time (`worker/social.mjs`).

## Turning it on

```bash
npx wrangler secret put AIR_MCP_URL   --config wrangler.app.jsonc   # https://useair.net/api/v1/mcp
npx wrangler secret put AIR_API_KEY   --config wrangler.app.jsonc   # your AiR key
npx wrangler secret put AIR_SHARED_KEY --config wrangler.app.jsonc  # a key you invent, for /api/trust
```

Until those exist, `airReady()` is false and — this is the part that matters —
**the model is told so before it writes.** Actions execute after generation, so
a model told nothing will cheerfully say "I've asked AiR" about a call that
never happened. Verified: with AiR absent it now answers

> "Honest answer: I can't see your calendar yet — AiR isn't connected, so I'd
> only be guessing. What I can tell you is your Bangkok plan is empty on
> Thursday 6 August…"

## Audit

Every exchange is logged to `num_air_exchanges` — a table that already existed,
which is how you can tell somebody planned for this. Direction, the tool and
arguments, the result, elapsed ms, ok flag, and `custody_ref` set to the member.
Bearer tokens and phone numbers are redacted before anything is written.

## Two things to decide

1. **Two memories.** AiR has `memory_save`; Num has `remember` writing to
   `profile`. Two memories that do not know about each other will drift. Pick
   which is authoritative before both are live.
2. **UHA is empty.** If unique-human attestation is part of what we sell to AiR,
   it needs to start issuing. Right now the honest claim is "verified identity
   plus scored work sessions", not "attested unique humans".
