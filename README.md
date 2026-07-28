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
