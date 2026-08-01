# QA + polish sprint — plan of record (written 2026-08-01, end of Dre's session)

Execute in order. Everything here was scoped against live probes from that day;
statuses cited are verified, not assumed. Read AGENTS.md first.

## 1. Push notifications — verify, don't trust `push: true`
The known landmine: `src/lib/push.ts` hardcodes VAPID_PUBLIC; if it doesn't
match the worker's VAPID_PRIVATE_KEY/VAPID_PUBLIC_KEY secrets, every push
fails silently. Compare the hardcoded value against the secret pair, send a
real test push (plan comment from a second account), confirm it lands on a
phone. Fix = single source the public key from /api/version.

## 2. Re-run the write-button checklist
docs/STRESS_TEST_2026-08-01.md "write column" — it was blocked by the D1 cap,
which is lifted (Workers Paid since 08-01 ~17:05 UTC). Signup, connect,
invites, plans, stars, tabs, DMs, QR — each should now pass. Anything failing
is a real bug now, not the cap.

## 3. Contacts toggle — DECIDED: remove on iOS
Apple does not expose contacts to web apps, full stop. On iOS: remove the
toggle row entirely; replace with "SEND & SHARE" row that opens the invite
sheet (share-sheet + sms links + on-Num lookup, all shipped 0.8.81–83). Keep
the toggle on Android (navigator.contacts works — contactsSupported() already
gates it). A switch that cannot deliver poisons trust in the other five.

## 4. Feature-tour coach marks
Small dismissible popovers, first visit per surface, stored in localStorage
(fine in the PWA): PLAN tab ("plans live here — tap one for the group chat"),
group chat composer, votes row, ASK NUM TO BOOK, invite sheet on-Num badge,
wallet. One component, content-driven; respect reduced-motion; never block a
tap. ~1 session.

## 5. Showtimes parser — finish (10 min)
Agent live, key valid, calls firing. Production logs now print
`[showtimes] ... keys: <top-level fields>` on every movie ask. Read the line
via `npx wrangler tail num-app --config wrangler.app.jsonc`, adjust
formatShowtimes() in worker/showtimes.mjs to the actual field (likely
local_results or knowledge_graph for area queries; `showtimes` appears for
film-title queries — consider a second query shape "showtimes <top film>" or
q="showtimes" + city in q). Cache and prompt plumbing already done.

## 6. Pay connectors — do NOT wire until Duke's gates pass
payments:"none" is correct today. Preconditions in cto-handoff-duke.md:
ledger reconciled (Track A), webhook signatures verified (defect #4 — an
unauthenticated endpoint that can mark a payout paid), then ONE real payout.
Money never rests with us; every webhook verifies a signature. Nothing in the
app should claim pay works before then.

## 7. 5arz connection — blocked on Track A′ (Duke)
Verification ladder / liveness / proof chain are built + tested, not deployed
(migrations 0041–0044). Key registry mismatch + hmac-v0 must die first.
App-side: nothing to do yet except not claiming it.

Also open from earlier sessions: Railway Twilio token (ops/set_twilio_secrets.sh,
branch backend-fastapi) before its Anthropic key; num-core migration now
planned-work; workers_dev:false after reinstalls; Play via num-play-handoff §0
(check memory: a Play brief may already be ~80% shipped under other names).
