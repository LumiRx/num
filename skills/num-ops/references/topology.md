# NUM topology — what runs where

Read this when a task touches more than one system, or when you need to know
which thing serves the traffic you're debugging. Verify against the live repo
before relying on any specific value; this drifts.

## Contents
- [The two lineages](#the-two-lineages)
- [Worktrees](#worktrees)
- [Workers](#workers)
- [Databases](#databases)
- [Domains and routing](#domains-and-routing)
- [Known landmines](#known-landmines)

---

## The two lineages

`github.com/LumiRx/num` holds **two codebases with no common ancestor**. This is
the single most important fact about the repo.

**Worker lineage** — the live product. TypeScript/JS, Cloudflare Workers + D1.
This is what `origin/main` contains (identifiable by `worker/health.mjs` and
`package.json` at the root). Serves every real guest.

**Python/FastAPI lineage** — `origin/backend-fastapi`. FastAPI on Railway plus
Supabase. Identifiable by `Procfile`, `requirements.txt`, `.python-version`.
**Has never served a guest.**

`git merge-base` returns nothing between them. Merging or force-pushing across
them deletes a codebase. This is stated in `AGENTS.md` too — it is worth
repeating because it is the highest-consequence fact here.

## Worktrees

| Path | Checked-out branch | Actually tracks | Lineage |
|---|---|---|---|
| `~/num-worktrees/app-main` | `fix/mem-model-relay-requests` | same | Worker |
| `~/Documents/Claude/Projects/NUM` | `main` | **`refs/heads/backend-fastapi`** | Python |
| `~/num-worktrees/uptime` | `ops/uptime-monitor` | same | Worker (cut from real `origin/main`) |

The second row is the trap. A branch named `main` that pushes to
`backend-fastapi` will eventually be force-pushed by someone in a hurry.
Defusing it:

```bash
git branch -m main backend-fastapi
git branch -u origin/backend-fastapi backend-fastapi
```

Worktrees belong in `~/num-worktrees/`, never `/tmp` — macOS cleans `/tmp` and
uncommitted work dies with it (this has happened).

## Workers

| Worker | Config | Deploy command | Owns |
|---|---|---|---|
| `num-app` | `wrangler.app.jsonc` | `npm run release:stage` → `release:ship` | `app.itsnum.com` (SPA + `/api/*`) |
| `num-console` | `wrangler.jsonc` (root) | **bare** `npx wrangler deploy` | `itsnum.com/*` (marketing site, static assets) |
| `num-growth` | separate | — | `itsnum.com/api/claims*` |
| `num-ai` | `ai/` | `ai/release.sh stage → ship` | LINE concierge webhook |

Cloudflare routes by **most specific match**, which is why the explicit routes
in `wrangler.jsonc` coexist with the `itsnum.com/*` catch-all.

`num-app` runs a cron every 5 minutes (`worker/health.mjs`).

## Databases

- **`num-db`** — `823979c8-b118-4a8a-953a-e07655205cf5`. Shared by `num-app`,
  `num-ai`, `num-console`, `num-growth`. D1.
- **`5arz-ledger`** — `479dfff2-cd26-49b0-ae54-84d4a41b99aa`. The payout desk
  owns every write; the app reads only.
- **Supabase `lvallpzkhnuarrnxbvfg`** — Python lineage only. On an unreachable
  account with no `SUPABASE_DB_URL`, so no DDL is possible there.

## Domains and routing

- `itsnum.com` → proxied CNAME → **`itsnum.pages.dev`**, a *retired* Pages
  project that 301s back to the apex. This only stays invisible while
  `num-console` holds its routes. When those routes lapse, DNS takes over and
  the loop opens: apex → Pages → apex, forever.
- `app.itsnum.com` → `num-app` via custom domain.
- SSL mode must be **Full**. Cloudflare's "Automatic" setting selected
  *Flexible*, which produces an identical redirect-loop signature and wastes
  diagnosis time by presenting a second plausible cause.

## Known landmines

- **A Worker cannot fetch its own public hostname** → HTTP 522. External probing
  must come from outside Cloudflare (GitHub Actions).
- **Same-zone subrequests work from cron, fail from a request handler.**
- **GitHub `schedule:` only runs on the default branch.** Any scheduled workflow
  belongs on `origin/main` regardless of which lineage it tests.
- **GitHub disables scheduled workflows after 60 days of repo inactivity** —
  precisely when nobody is watching.
- **`num-ai` has been edited via the Cloudflare dashboard**, outside git. A
  deploy overwrites those edits. If `wrangler` warns "last updated via the
  script API", stop and commit the live state to a branch first.
- **Cowork sandbox git writes leave undeletable lock files.** Read-only git from
  the sandbox; the user commits.
- **No SSH credentials in the sandbox** — pushing always requires the user.
