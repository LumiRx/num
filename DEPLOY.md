# NUM App — Deploy Runbook (copy-paste)

Goal: the consumer app live on one Worker — **num-app** — serving the static build
(`dist/`) plus the AI endpoint (`POST /api/num`), with an instant preview URL at
`https://num-app.<your-subdomain>.workers.dev`. Total time: ~5 minutes.

This is a **separate Worker** from the partner console (`num-console`, root
`wrangler.jsonc`) — that one has its own runbook: [LAUNCH_RUNBOOK.md](LAUNCH_RUNBOOK.md).
Everything here uses `--config wrangler.app.jsonc`, so the console can't be touched by accident.

**What ships:** the Vite build of `src/` (PWA manifest + icons included via `app-public/`),
SPA fallback for client-side routes, and `worker/index.mjs` answering `POST /api/num`
(Claude with a structured-output schema). `run_worker_first` means only `/api/*` hits the
Worker code — every other path is served as a static asset.

---

## Before you start

- **Node 18+** — `node -v`
- **Cloudflare** — `wrangler login` is already done on this Mac (account **thatislumi@gmail.com**). Confirm: `npx wrangler@latest whoami`
- **Anthropic API key** — optional at deploy time. Without it the app still works: the demo chips are scripted, and free-typed messages get the graceful offline reply. Add the key in Step 3 to turn the AI brain on.

## Step 1 — build

```bash
cd ~/num-concierge
npm run build      # tsc -b && vite build → dist/
```

## Step 2 — dry-run, then deploy

```bash
npx wrangler@latest deploy --dry-run --config wrangler.app.jsonc   # validates config + bundle, ships nothing
npx wrangler@latest deploy --config wrangler.app.jsonc
```

The output prints the live URL — `https://num-app.<your-subdomain>.workers.dev` —
shareable immediately.

## Step 3 — set the AI key

```bash
npx wrangler@latest secret put ANTHROPIC_API_KEY --config wrangler.app.jsonc
```

Paste the key at the interactive prompt — never pass it on the command line or
`echo` it. The secret takes effect on its own in seconds; no rebuild or redeploy needed.

## Step 4 — verify

```bash
curl -sI https://num-app.<your-subdomain>.workers.dev/ | head -3
# expect: HTTP/2 200 + content-type: text/html

curl -s https://num-app.<your-subdomain>.workers.dev/api/num \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"state":{}}'
```

Before Step 3 the API curl returns `401 {"error":"ANTHROPIC_API_KEY not configured"}` —
that's the expected no-key response, not a failure. After Step 3: `200` with
`{"reply": ..., "card": ..., "chips": ..., "actions": ...}`.

## Logs, rollback, un-launch

```bash
npx wrangler@latest tail --config wrangler.app.jsonc       # live logs (observability is on)
npx wrangler@latest rollback --config wrangler.app.jsonc   # back to the previous version
npx wrangler@latest delete --config wrangler.app.jsonc     # removes num-app; num-console untouched
```

---

## Local dev matrix

**Day-to-day (Vite + Node backend):**

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or `ant auth login`
npm run ai      # Node backend (server/index.mjs) on :8787
npm run dev     # Vite on :5299, proxies /api → :8787
```

**The real Worker, locally (exactly what production runs):**

```bash
npm run build                                    # wrangler dev serves dist/, so build first
npx wrangler@latest dev --config wrangler.app.jsonc
```

Secrets for `wrangler dev` come from `.dev.vars` (already gitignored) — one line:
`ANTHROPIC_API_KEY=sk-ant-...`. Note `wrangler dev` also defaults to :8787, so stop
`npm run ai` first.

---

## Going custom later (itsnum.com)

workers.dev is the preview. When it's time for a real address:

- **`app.itsnum.com` custom domain (recommended):** dashboard → Workers & Pages → **num-app** → Settings → Domains & Routes → Add → Custom domain. No route conflicts possible, assets just work.
- **`itsnum.com/app*` route:** possible, with two cautions. Same route-claim warning as [LAUNCH_RUNBOOK.md](LAUNCH_RUNBOOK.md) — another worker owning the path wins/loses by claim, and `/app*` would also capture the existing `itsnum.com/app-preview/` pages. The build also assumes root paths, so a sub-path route needs a Vite `base` change first. Prefer the subdomain.

---

## Cost & limits

The Workers free tier (100k requests/day) comfortably covers the static app and the
API endpoint. The only real spend is Anthropic tokens: each free-typed message is one
Claude call; the scripted demo chips cost nothing. No key set = no spend possible.

---

## Launch hardening

`POST /api/num` is **public and unauthenticated** — the app has no login, so anyone
who finds the URL can spend our Anthropic budget. [worker/guard.mjs](worker/guard.mjs)
runs before any token is spent:

| Guard | Limit | Rejects with |
|---|---|---|
| Per-IP rate limit | 12 requests / 60s | `429` + `Retry-After` |
| Isolate-wide ceiling | 240 requests / 60s | `429` + `Retry-After` |
| Body size | 128 KB | `413` |
| Thread length | 40 messages | `400` |
| Per-message / total text | 8k / 60k chars | `400` |
| Trip-state size | 64 KB | `400` |
| CORS | same-origin (+ localhost) only | header omitted, so cross-site JS can't read replies |

Requests are also normalized to `{role, content}` before reaching Claude, so extra
client-supplied fields are dropped rather than forwarded.

**Know the limitation:** the limiter lives in module scope, so it is *per isolate* —
Cloudflare may run several per colo and recycle them. It reliably stops one client
looping the endpoint; it is not an exact global quota. Tighten `LIMITS` in
`worker/guard.mjs` to trade capacity for safety.

Before opening it to real traffic, add one hard control:

- **Cloudflare Rate Limiting binding** — exact, distributed counting.
- **Turnstile** — invisible bot check in front of `/api/num` (see the `turnstile-spin` skill).
- **Real auth** — the honest fix once accounts exist; the AI seam is already server-side.
- **Anthropic spend cap** — set a monthly budget limit in the Anthropic Console. Do this
  regardless of the above: it is the only ceiling that cannot be bypassed.

## Go-live checklist

```bash
cd ~/num-concierge
npm run design:check                                            # design snapshots intact
npm run build                                                   # tsc + vite must pass
npx wrangler@latest deploy --dry-run --config wrangler.app.jsonc
npx wrangler@latest deploy --config wrangler.app.jsonc
```

Then confirm, against the live URL:

- [ ] `/` returns 200 `text/html`; app renders with the glass theme
- [ ] `/manifest.webmanifest` returns 200 `application/manifest+json` (installable)
- [ ] A deep path (e.g. `/plan`) returns the app, not a 404 (SPA fallback)
- [ ] `POST /api/num` returns 200 with a `reply` (or a clean 401 if no key is set)
- [ ] 13+ rapid API calls start returning `429` (rate limit is live)
- [ ] Demo chips work with the AI key **removed** — scripted flows must never depend on the backend
- [ ] Phone check: installed to home screen, safe-area padding correct, no horizontal scroll
- [ ] Anthropic Console: monthly spend limit set
- [ ] `npx wrangler tail --config wrangler.app.jsonc` is clean during a smoke run
