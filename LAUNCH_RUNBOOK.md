# NUM Console — Launch Runbook (copy-paste)

Goal: the partner demo console live at **itsnum.com/console** (plus an instant workers.dev preview URL). Total time: ~5 minutes.

---

## Path A — run it yourself on the Mac (recommended, no token needed)

**Step 0 — get the files.** Download `num_console_deploy_bundle.zip` from this chat, then:

```bash
cd ~/Downloads
unzip -o num_console_deploy_bundle.zip -d num-console
cd num-console
```

**Step 1 — log in to Cloudflare** (opens the browser; log in with the account that owns itsnum.com):

```bash
npx wrangler@latest login
npx wrangler@latest whoami     # confirm: should show the account with itsnum.com
```

**Step 2 — deploy:**

```bash
npx wrangler@latest deploy
```

That's the launch. The output prints two things:
- `https://num-console.<your-subdomain>.workers.dev` — **live immediately**, shareable right now
- the route `itsnum.com/console*` — live as soon as it attaches (usually seconds)

**Step 3 — verify:**

```bash
curl -sI https://itsnum.com/console/ | head -3      # expect: HTTP/2 200
open https://itsnum.com/console/                     # opens in your browser
open https://itsnum.com/                             # main site untouched — still the NUM landing page
```

---

## Path B — I deploy it from here (needs a token)

Create a scoped token: Cloudflare dashboard → My Profile → **API Tokens** → Create Token → Custom token, with exactly:

- Account → **Workers Scripts → Edit**
- Zone → **itsnum.com** → **Workers Routes → Edit**

Copy the token + your **Account ID** (dashboard → itsnum.com overview page, right sidebar) and paste both into the chat. I run the same deploy from the cloud workspace and report the live URLs back.

---

## If something complains

**"You do not have permission to create routes" (Path A, rare / Path B with wrong token):**
the deploy still succeeded on workers.dev. Either fix the token permission, or launch without the custom route for now:

```bash
# temporarily remove the route and redeploy (workers.dev URL only)
sed -i '' 's/"routes": \[/"routes_disabled": [/' wrangler.jsonc
npx wrangler@latest deploy
```

Then attach the route by hand: dashboard → Workers & Pages → **num-console** → Settings → **Domains & Routes** → Add → Route → `itsnum.com/console*`.

**`itsnum.com/console` shows the old site or 404 after deploy:** the existing site worker may own the path. Dashboard → the site's worker → Settings → Domains & Routes — make sure nothing there claims `/console*`; the `num-console` route wins once it's the only claimant. (Route conflicts are the only way the two workers can touch each other — `num-console` cannot break the main site.)

**`npx: command not found`:** install Node first: `brew install node` — then rerun from Step 1.

**Want to un-launch:** `npx wrangler@latest delete num-console` removes the worker and its route; itsnum.com is untouched.

---

## Updating the console later

Any newer `index.html` I send you: drop it into `num-console/public/console/index.html` (overwrite), then:

```bash
cd ~/Downloads/num-console && npx wrangler@latest deploy
```

Deploys are versioned on Cloudflare's side; `npx wrangler@latest rollback` if you ever want the previous one back.
