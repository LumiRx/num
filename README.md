# NUM — by 5arz

AI text-message concierge for travellers. This repo is the working codebase:
the itsnum.com site + console, the accounts/invites worker, the LINE AI worker,
and the consumer app design.

**Start here**
- `docs/num-app-design-and-store-compliance.md` — the app design + App Store / Play strategy (read this first)
- `public/app-preview/index.html` — interactive v0.4 app prototype (live at https://itsnum.com/app-preview/)
- `public/` — itsnum.com static site (homepage, /signin, /claim, /console)
- `accounts/` — num-accounts worker (sign-in links, business invites)
- `ai/` — num-ai worker (LINE concierge, directory-grounded)
- `scripts/` — directory ingestion, invite generation, ranking
- `wrangler.jsonc` — routes for num-console (see comments before touching routes)

**Rules**
- Secrets are local dotfiles (`.resend_key`, `.line_*`, `.places_key`) — gitignored, never committed, set via `wrangler secret put ... < file`.
- Deploys: `npx wrangler@latest deploy` (site), `--config accounts/wrangler.jsonc`, `--config ai/wrangler.jsonc`.

Team channel: #num on Slack. Status canvas is pinned there.

---

## v0.8 concierge prototype (`src/`) + NUM AI backend

The repo root also carries the v0.8 concierge prototype (Vite + React + TS) and
its Claude-powered backend:

```bash
npm install
npm run dev     # prototype — desktop canvas, or ?app / narrow viewport for standalone
npm run build   # type-check + production build
```

Free-typed messages in the thread go to a real AI backend
([server/index.mjs](server/index.mjs), Claude Opus 5 via the Anthropic
TypeScript SDK). The scripted demo chips work with the server off.

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or `ant auth login`
npm run ai                            # backend on :8787
npm run dev                           # app (vite proxies /api → :8787)
```

How it works:

- `askNum()` in [src/lib/concierge.ts](src/lib/concierge.ts) posts the thread
  plus a trip-state snapshot to `POST /api/num`.
- The server calls Claude with a structured-output schema, so every reply is
  `{ reply, card, chips, actions }` — no parsing heuristics.
- `actions` (`add_booking`, `update_booking`, `add_meeting`) are applied to the
  store, so the PLAN tab and calendar update in real time from what Num books.
- The API key lives only in the server process — never in the browser. If the
  backend is unreachable, the thread shows a graceful offline message.
