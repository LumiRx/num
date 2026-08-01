# Handoff → Duke — the LINE concierge (`num-ai`), 2026-08-01

**From:** Dre's session · **Deployed:** `num-ai` version `b7278df8-b9b7-4721-85f5-84903f516ceb`
**Branch:** `fix/unsupported-location` on `github.com/LumiRx/num` (2 commits, pushed, not merged)

Read `HANDOFF-duke-CONSOLIDATED.md` first — it is the front door and it is right
about priority. This covers one thing those four documents don't: **the LINE
concierge `num-ai`, which binds the same `num-db` and is failing in a way that
looks like a prompt bug and isn't.**

---

## The finding that matters to your migration

`num-ai` binds `num-db` (`823979c8-b118-4a8a-953a-e07655205cf5`) — the same
write-blocked database. Its writes are all wrapped in `try/catch` that log and
continue, so **the concierge degrades silently instead of erroring**:

| Function | What it writes | Consequence while writes fail |
|---|---|---|
| `updateMemory` | the guest brain | **NUM learns nothing, ever** |
| `noteDest` / `clearDest` | `users.last_dest` | a guest is pinned to a stale city permanently |
| `saveLocation` | `last_lat/lng` | shared locations are discarded |
| user upsert (`worker.js:255`) | `users` row | new LINE guests are never created |

So "NUM doesn't remember me" is **not a prompt or model problem**. The guest
brain is physically unwritable. No amount of prompt work fixes it, and any
session that tries will burn hours. It clears the moment the `num-core` import
lands.

This is worth adding to the incident's blast radius: the consolidated handoff
lists signup, invites, plans, events, stars, tabs and DMs. **Concierge memory
belongs on that list**, and unlike the others it fails without any error
surfacing anywhere.

---

## The bug Dre reported, and what was actually wrong

A guest wrote *"I'm in Los Angeles"*. NUM replied *"I think there might be some
confusion — you're actually in Phuket"*, recommended a Phuket restaurant, and
repeated it after two corrections. Then, after a first fix, *"Give me hookah bar
in La tonight"* still returned a Phuket sky bar.

Four separate defects, all now fixed and deployed:

1. **`places.js` fell through to Phuket.** `destNamedIn` only matches cities we
   cover, so an uncovered city was indistinguishable from silence and
   `resolveLocation` hit `dests.find(d => d.slug === 'phuket')`.
2. **`last_dest` is sticky.** Once set, every later message re-anchored to it.
   Combined with the write block, it is now *permanently* sticky.
3. **The BIZ emergency fallback injected Phuket businesses** whenever rows were
   empty and dest was phuket — this is what put a Phuket venue in front of a
   guest in Los Angeles.
4. **The prompt asserted `GUEST IS IN: <city>` as fact**, and the standing rule
   `NEVER a flat "no" or "I can't"` pushed the model to offer something
   regardless — which is where the pivot to pitching a holiday came from.

Fixes, in `ai/places.js` and `ai/worker.js`:

- `statedPlace()` hears a city the guest names, covered or not, with **no
  trigger phrase required** — the first attempt demanded "I'm in …" and missed
  the hookah-bar message entirely. Guarded by a stopword set and a `places.area`
  lookup so "staying in Patong" isn't read as an uncovered city.
- `SHORT_PLACES` maps the abbreviations guests type (`la`, `nyc`, `sf`, `dc`).
  "La" is two characters and was previously discarded as noise.
- When flagged `unsupported`: no partner query, no BIZ fallback, no destination
  guide, and a prompt block that explicitly outranks "never say no".
- **Defence in depth:** the prompt no longer states location as fact even when
  nothing is flagged. It now reads *"WHERE WE THINK THE GUEST IS: … inferred
  from `<source>`, NOT something they told you … if the guest names anywhere
  else, they are right and this line is wrong."* A regex will always miss cases;
  this catches what it misses.

14 tests in `ai/places.test.mjs`, including the verbatim failing message.

### What is still broken after this fix

Per-message honesty works. **Persistence does not.** `clearDest` cannot clear the
stale `last_dest`, and `updateMemory` cannot record that the guest has moved.
Every conversation re-reads a brain that has been frozen since writes started
failing. Re-test the concierge after the import — not before.

---

## ⚠️ I overwrote dashboard edits on `num-ai`

Deploying printed:

> *You are about to publish a Workers Service that was last updated via the
> script API. Edits made via the script API will be overridden by your local
> code and config.*

Someone had been editing `num-ai` outside git. My deploy replaced those edits
with the git version. Tests pass and the fix is sound, but if something that
worked has stopped, this is the first suspect.

| Version | When | What |
|---|---|---|
| `65790003-f6e4-4bb7-822e-9a15b638add0` | 07-30 00:28 UTC | last pre-fix state, **includes the dashboard edits** |
| `62558e11-d3cc-4071-9a55-3f7ffc65f77e` | 07-30 02:09 UTC | first location fix |
| `b7278df8-b9b7-4721-85f5-84903f516ceb` | 08-01 16:4x UTC | current — broadened detector |

```bash
wrangler versions deploy 65790003-f6e4-4bb7-822e-9a15b638add0   # rollback
```

Worth adding to the concurrency warning in the consolidated handoff: it isn't
only the shared checkout. **`num-ai` has been edited in the Cloudflare dashboard
by someone, invisible to review and one deploy from deletion.**

---

## Separately: the Railway/Supabase backend is not what anyone thinks it is

There is a **fourth** NUM: a FastAPI app on Railway
(`web-production-d6ed4.up.railway.app`) backed by Supabase, not D1. Findings
from testing it directly today:

1. **Its `ANTHROPIC_API_KEY` is invalid** — `authentication_error: invalid
   x-api-key` straight from the API. Every reply it has ever produced is the
   "having trouble reaching my brain" fallback. It has never worked.
2. **It has had zero real traffic.** Its Supabase was empty — not because writes
   fail, but because nothing has ever reached it. A synthetic message wrote a
   user, conversation, 2 messages, usage and events correctly, and the PDPA
   erasure path cleaned them up.
3. **Its Twilio webhook accepts unsigned requests.** `TWILIO_AUTH_TOKEN` is
   unset, so `verify_request` fails open by design. Anyone with the URL can post
   messages. Harmless only while the Anthropic key is dead — **set the token
   before fixing the key**, not after. `ops/set_twilio_secrets.sh` does it
   without the secret entering a shell history or a chat window.
4. **Its Supabase (`lvallpzkhnuarrnxbvfg`) is on a third Cloudflare-unrelated
   account** we cannot reach from the dashboard or MCP, and Railway holds no
   `SUPABASE_DB_URL` — so **no DDL is possible**. Migrations 0007–0009 cannot be
   applied there by any route. `ops/backup.sh` works around it via PostgREST,
   but that is a data backup, not a database backup: no sequences, no storage
   objects, no RLS state. Documented in `ops/RESTORE.md`.

Decision needed: this backend has never served a guest. Either it becomes the
platform (fix the key, lock the webhook, move Supabase somewhere administrable)
or it is retired. Carrying it un-owned is the worst of the three.

---

## What I did not touch

The `num-core` migration, `core_import.sql`, the PII question, the coverage
number, SEC-001, and `num-places`. All still yours, all still as the other
handoffs describe them.

---

## Reproducing

```bash
git worktree add /tmp/num-worker fix/unsupported-location
cd /tmp/num-worker/ai && node --test *.test.mjs        # 14 tests

# the write block, from outside
curl -s -X POST https://app.itsnum.com/api/social/me \
  -H 'Content-Type: application/json' -d '{"id":"probe","name":"Probe"}'

# concierge writes failing silently — look for these, they are not errors
npx wrangler tail num-ai --format json | grep -E "noteDest|clearDest|updateMemory"
```

One trap worth repeating from Viv's supplement, because it cost me time too:
**a git worktree under `/tmp` gets cleaned.** I lost a round of uncommitted
edits that way and had to redo them. Commit before you walk away, or put the
worktree somewhere durable.
