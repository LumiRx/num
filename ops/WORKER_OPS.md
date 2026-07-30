# The `num-ai` Cloudflare Worker — deploy, rollback, and why it's separate

**This is the stack that has actually been serving guests.** Read
`ops/RESTORE.md` first if you're unclear on which NUM is which.

| | `num-ai` Worker | FastAPI backend |
|---|---|---|
| Channel | LINE | SMS / WhatsApp |
| Model | Cloudflare Workers AI | Claude |
| Storage | D1 (`num-db`, `823979c8-b118-4a8a-953a-e07655205cf5`) | Supabase |
| Source | `origin/main`, `ai/` | branch `backend-fastapi`, `apps/api/` |
| Deploy | `wrangler deploy` from `ai/` | `railway up` from repo root |

The two histories have **no common ancestor**. Force-pushing either branch over
the other deletes a codebase. There is no scenario where that is the right move.

## Working on the Worker

`ai/` lives on `origin/main`, which is not checked out in the main working tree.
Use a worktree so the two never mix:

```bash
git worktree add /tmp/num-worker origin/main
cd /tmp/num-worker/ai
node --test *.test.mjs     # 12 tests
wrangler deploy
```

## Rollback

Every deploy creates a version. To go back:

```bash
cd /tmp/num-worker/ai
wrangler versions list                    # find the target ID
wrangler versions deploy <VERSION_ID>     # 100% traffic to it
```

Known-good version IDs:

| Version | When | What |
|---|---|---|
| `65790003-f6e4-4bb7-822e-9a15b638add0` | 2026-07-30 00:28 UTC | last state before the location fix |
| `62558e11-d3cc-4071-9a55-3f7ffc65f77e` | 2026-07-30 02:09 UTC | location fix (`unsupported` handling) |

### ⚠️ Dashboard edits get overwritten

Deploying printed:

> *You are about to publish a Workers Service that was last updated via the
> script API. Edits made via the script API will be overridden by your local
> code and config.*

Someone had edited this Worker outside of git — through the Cloudflare
dashboard or API — and those edits are **not in the repository**. The
`wrangler deploy` on 2026-07-30 replaced them with the git version.

If something that used to work has stopped, that's the first thing to suspect.
The pre-deploy code is still retrievable as version
`65790003-f6e4-4bb7-822e-9a15b638add0` — roll back, diff it against `ai/`, and
port anything worth keeping into git.

**Rule going forward: edit the Worker in git, never in the dashboard.** Anything
edited in the dashboard is invisible to review, untested, and one deploy away
from being deleted.

## Secrets

Held in Cloudflare, not in the repo, and not touched by `wrangler deploy`:

```bash
wrangler secret list
wrangler secret put LINE_CHANNEL_SECRET
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
```

Webhook URL registered in LINE Developers → Messaging API:
`https://num-ai.thatislumi.workers.dev/webhook`
