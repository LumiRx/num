# Handoff → Duke

**From:** Dre's Claude Code session, 2026-07-31
**Repo:** `~/num-concierge` @ v0.8.76 (`git@github.com:LumiRx/num.git`)
**UPDATE 2026-08-01 00:5x UTC — the link fix is LIVE.** v0.8.78
(`4c137fb2-afe2-4cb5-9aae-eb65bfb4d410`) deployed to 100%. Verified in
production: `/c/<id>?ref=<code>` → `302 /?ref=<code>&c=<id>`, and the deployed
`sw.js` carries the fix at line 99. The rest of this document still stands.

**Everything else is working tree only — not committed.** `worker/capability.mjs`
shipped in that bundle but is imported by nothing, so it is inert; SEC-001 is
still open and still live.

---

## The two things that need you first

**1. There is a critical auth hole in production.** Member endpoints have no
authentication — identity is read straight out of the request. Details in
[`security/THREAT_MODEL.md`](../security/THREAT_MODEL.md) as SEC-001. Short
version: anyone who has shared a tab or plan with a member can act as that
member, and there is no way to revoke it. This is live right now.

**2. The QR/referral/invite links have been broken for installed users only**,
since whenever the service worker shipped. Root cause found and fixed in the
working tree — see below. Worth understanding because it explains a cluster of
"it doesn't work on my phone" reports that would look unrelated.

---

## SEC-001 — member endpoints are unauthenticated (CRITICAL, live)

`worker/social.mjs` and `worker/pay.mjs` establish who the caller is like this:

```js
const meId = clip(b.me, 40);                       // social.mjs:539, 653, 686, 778, 1032
const meId = clip(url.searchParams.get('me'), 40); // social.mjs:761, 872 — pay.mjs:224
```

No signature, no session, no proof of possession. The member ID **is** the
credential.

The reason this is not merely theoretical: member IDs are handed to other
members by design. `social.mjs:1146` and `1010` return every co-member's ID to
everyone on a tab; plan rosters and link rows do the same. So the exposure is
not "a remote attacker guesses an 80-bit UUID" — it is **anyone you have ever
shared a tab or plan with can, permanently:**

- read your payment history (`pay.mjs:224`)
- settle your tabs, which writes paired rows into `5arz-ledger` (`social.mjs:1121-1125`)
- send connection requests and invites as you
- patch your profile — `me()` at `social.mjs:241` accepts an existing `id` and
  updates name/avatar/bio ("Existing accounts may still patch freely")

And there is no revocation path, because the credential is also the primary key.

**A fix is written but wired to nothing:** `worker/capability.mjs` — HKDF-derived
per-compartment HMAC tokens (identity / social / money / travel / admin),
30-day auto-rotating epochs, per-member revocation. 24 tests pass
(`node worker/capability.test.mjs`). A `social` token cannot verify against
`money` — different derived key, not a policy check.

Migration is designed to avoid a flag day and is in
[`security/COMPARTMENTS.md`](../security/COMPARTMENTS.md). **Step 1 (dual-accept)
is safe to deploy today** — it accepts tokens *or* the legacy `?me=`, rejects
nothing, and counts legacy calls so we can watch them go to zero. Steps 4–5
(closing `money`/`travel`, then the rest) are the ones that can lock out a stale
client, and that is your call.

Second issue, HIGH: **SEC-002** — one static `ADMIN_KEY` opens Sabre booking,
earnings accrual, mail, push and the console across five workers, compared five
different ways (two constant-time, three not). One key from money to mail.

Full list — 6 findings, priority-ordered — in `security/THREAT_MODEL.md`.

---

## The link bug — root cause, fixed in tree

**Symptom cluster Dre reported:** scanning a QR doesn't add the friend; the
profile QR doesn't connect; a referral link "just doesn't load"; invites don't
land. All of it intermittent in the sense that it worked for some people.

**It is one bug, and the discriminator is whether the app is installed.**

Every short share link 302s (`worker/index.mjs:353`): `/c/ID` → `/?c=ID`,
`/r/CODE` → `/?ref=CODE`, `/i/TOKEN` → `/?i=TOKEN`. The service worker
intercepted those navigations and did `fetch(request.url)`, which defaults to
`redirect: 'follow'`, so it came back with `redirected === true`.

A navigation request's redirect mode is `manual` — the browser reserves
redirect handling for itself. `respondWith()` of a response you followed a
redirect to get, for a request whose redirect mode is not `follow`, is a
**network error**. See [whatwg/fetch#573](https://github.com/whatwg/fetch/issues/573).

So:

| | no service worker | app installed |
|---|---|---|
| scan QR / tap referral | browser follows 302, `?c=`/`?ref=` present, works | **navigation fails** |

And even where a page did render, `bootSocial()` reads `?c=` / `?ref=` off
`window.location.search` — which never exists, because the browser was never
allowed to perform the redirect that creates it. Hence "the QR doesn't add the
person as my friend."

**Fix** (`app-public/sw.js`): don't intercept those navigations at all. Return
without `respondWith()` and the browser follows the 302 natively.

```js
if (WORKER_PATHS.test(url.pathname)) return;   // /r/ /i/ /c/ /e/ /claim/confirm
```

`app-public/sw.test.mjs` had a test asserting the *broken* behaviour ("a
redirected response is passed through") — the mock harness doesn't model the
browser's rejection. Replaced with assertions that these paths are **not
intercepted**, plus a guard that normal launch URLs still are (so nobody
"fixes" it by disabling the handler). 22 tests pass:
`node app-public/sw.test.mjs`.

⚠️ **This fix is a prerequisite for the ShareSheet change another session made
in this same tree** (`ShareSheet.tsx` now hands out `connectLink` =
`/c/<id>?ref=<code>` instead of `/r/<code>`, so sharing actually connects
rather than only crediting a referral). That change does nothing for installed
users until the SW fix ships. **Ship them together.**

---

## Everything else from Dre's list

| # | Item | State |
|---|---|---|
| 1 | QR scan doesn't add friend | **Fixed** — SW root cause above |
| 2 | In-app camera scanner | **Module written** (`src/lib/scan.ts`), **not wired into UI yet** |
| 3 | Profile QR doesn't connect | **Fixed** — same root cause |
| 4 | Friend can't enable notifications | **Not a bug so far** — see below |
| 5 | Contact-request / connection flows | **Not verified** — see below |
| 6 | Dre's name out of examples | **Done** — 7 sites, now "Sam"/"Alex" |
| 7 | "Start the plan" does nothing | **Fixed** — silent failure, see below |
| 8 | Share link missing referral code | **Done by another session** (ShareSheet) |
| 9 | Referral + app installed → doesn't load | **Fixed** — same root cause |

### #7 — the dead button

`createPlan()` and `addPlanItem()` had no error handling. `api()` throws on any
non-2xx; the caller's `try/finally` only reset the spinner. So any backend
failure was **completely invisible** — button taps, nothing happens, no message.
Both now catch and narrate the actual error.

That is a robustness fix, **not necessarily the root cause of what Dre saw.**
Worth knowing: local dev proxies `/api` → `localhost:8787` (`vite.config.ts:24`)
and no `wrangler dev` was running, so in local dev *every* API-backed button
silently does nothing. If Dre was testing locally, that alone explains it. If he
saw it on production, the new error message will now say what actually failed.

### #4 — notifications

`src/lib/push.ts` looks correct. The likely explanation is not a bug:
**iOS only allows push for a PWA added to the home screen**, and only asks once.
`pushState()` returns `needs-install` and the app says "Add Num to your home
screen first" (`push.ts:40-41`). If Dre's friend is on iPhone in Safari, that is
correct behaviour and the fix is instructional, not code.

**One thing I could not verify and you should:** `VAPID_PUBLIC` is hardcoded at
`push.ts:11` and must match the `VAPID_PUBLIC_KEY` secret on `num-app`. If those
ever drifted, subscription succeeds and delivery silently fails.

### #2 — the scanner, and an honest limit

`src/lib/scan.ts` uses `BarcodeDetector` + `getUserMedia({facingMode:'environment'})`,
parses both `/c/<id>` and `?c=<id>`, connects on first hit, stops itself.

**It cannot work on iPhone.** Safari has no `BarcodeDetector`, and shipping a QR
*decoder* is a much larger problem than the encoder in `qr.ts` (binarisation,
perspective correction, error correction — versus laying out a matrix we already
know). The module detects support and tells iOS users to use the camera app,
which handles this perfectly *now that the SW fix lets those links open*.

So: valuable on Android, no-op on iOS. Worth deciding whether it earns the UI
space before I wire it into `QrCard`.

### #5 — not verified

I read the connect/invite/friends paths and they are logically sound
(`/connect` at `social.mjs:651`, `friends()` handles both link directions).
I did **not** exercise them end-to-end, because doing so writes real accounts
and links into production `num-db`. Wanted your call before polluting prod, and
there is no staging D1.

---

## Deploy notes

Nothing is committed. **Several sessions have been working this checkout
concurrently** — `git status` shows unrelated in-flight work (`sql/ovt_*.sql`
ingest files, `ai/`, `public/`, `scripts/`). Check `git log`/`git status` before
assuming tree state, and don't sweep other sessions' files into a commit.

Mine, and what to review:

```
app-public/sw.js              ← the fix. review this one closely
app-public/sw.test.mjs        ← was locking in the bug (untracked, another session's file)
src/lib/social.ts             ← error handling on createPlan/addPlanItem + name
src/lib/scan.ts               ← new, imported by nothing yet
src/components/app/{DashView,EventSheet,PartySheet}.tsx  ← name in examples
src/lib/{events,types}.ts     ← name in comments
worker/capability.mjs         ← new, imported by nothing yet
worker/capability.test.mjs    ← 24 tests
security/                     ← threat model, compartment design, 3 agent definitions
```

Tests, both pass, neither is in CI:

```bash
node app-public/sw.test.mjs
node worker/capability.test.mjs
```

Deploy is `wrangler deploy --config wrangler.app.jsonc` (num-app). The SW fix
only reaches an installed phone when it re-fetches `sw.js` on next launch —
byte change triggers update and `skipWaiting()` is already called, so no cache
bump needed.

**Unrelated but worth a look:** `wrangler.app.jsonc:76` has `"workers_dev": true`,
which publishes a second fully crawlable copy of the app at
`num-app.<account>.workers.dev`. `num-console` deliberately sets this to `false`
with a comment explaining why. Looks like an oversight on num-app.

---

## Open decisions for you

1. **Deploy the SW fix + ShareSheet together?** Low risk, fixes the whole link
   cluster. My recommendation: yes, soon — it is currently broken for exactly
   the most engaged users.
2. **Start the SEC-001 migration?** Step 1 is safe today and breaks nothing.
   The later steps need a call on stale clients.
3. **Wire the scanner into the UI**, given it is Android-only?
4. **May a session write test data to production D1** to verify the connect and
   invite flows end to end? Currently blocked on this.

## Also in the tree

Three security agent definitions in `.claude/agents/` — `redteam`,
`threat-intel`, `perimeter`. All read-only against production (no deploys, no
live attacks, no reading secret files, no commits — written in as hard limits).
`security/README.md` explains them.

A `redteam` run against `social.mjs`/`pay.mjs` was still going when this was
written and had not produced `security/findings/`. Re-run it if you want the
independent pass:

```bash
claude "use the redteam agent to audit worker/social.mjs and worker/pay.mjs"
```
