// Is Num actually working? Asked every few minutes, by Num itself.
//
// The reason this exists: the worst outage this project has had was SILENT.
// Writes to num-db failed for ~2 days while every endpoint returned 200,
// because the writes were wrapped in try/catch that logged and continued. The
// app looked fine. Guests just quietly stopped being remembered. Nobody knew
// until a person complained.
//
// So this checks the things that fail silently, and each check carries its own
// REMEDY — the fix, in the words of whoever has to act at 2am, not a status
// colour. A monitor that says "degraded" and stops has moved the problem, not
// solved it.
const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  verdict TEXT NOT NULL, failing TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_num_health_at ON num_health(at);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/** D1 WRITES — the silent killer. A read-only database looks perfectly healthy. */
async function checkWrite(env) {
  const probe = `hp_${crypto.randomUUID().slice(0, 8)}`;
  try {
    await env.DB.prepare('INSERT INTO num_health (verdict, failing, detail) VALUES (?1,?2,?3)')
      .bind('probe', null, probe).run();
    const back = await env.DB.prepare('SELECT detail FROM num_health WHERE detail = ?1').bind(probe).first();
    await env.DB.prepare('DELETE FROM num_health WHERE detail = ?1').bind(probe).run();
    if (!back) throw new Error('write accepted but not readable');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err?.message ?? String(err),
      remedy:
        'D1 writes are failing — signup, plans, Stars and concierge memory are ALL silently broken. ' +
        'Most likely the storage cap. Check `npx wrangler d1 info num-db`; if size is at the plan limit, ' +
        'the fix is capacity, not code. Overture/places ingest must stay paused.',
    };
  }
}

/** The brain. Key present is not the same as key valid — Railway taught us that. */
function checkBrain(env) {
  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, remedy: 'ANTHROPIC_API_KEY is unset — every reply is the fallback line. `wrangler versions secret put ANTHROPIC_API_KEY`.' };
  }
  return { ok: true };
}

/** Money paths. Half-configured payments are worse than none. */
function checkPay(env) {
  const key = !!env.STRIPE_SECRET_KEY;
  const hook = !!env.STRIPE_WEBHOOK_SECRET;
  if (key && !hook) {
    return {
      ok: false,
      remedy:
        'Stripe can CHARGE but the webhook secret is missing, so nothing marks a payment paid and no Stars are ever ' +
        'credited. People will pay and receive nothing. Set STRIPE_WEBHOOK_SECRET or turn STARS_SALE_OK off until it is.',
    };
  }
  if (env.STARS_SALE_OK === '1' && !key) {
    return { ok: false, remedy: 'Star top-ups are open but Stripe is not configured — every purchase fails at the last step. Set STRIPE_SECRET_KEY or unset STARS_SALE_OK.' };
  }
  return { ok: true };
}

/**
 * Push, the most silent failure of all. Nothing else notices it: every send is
 * fire-and-forget, wake() swallows rejections into a `fails` counter nobody
 * reads, and notify() reports how many it TRIED, not how many landed. A member
 * whose plan moves simply never hears.
 */
async function checkPush(env) {
  if (!env.VAPID_PRIVATE_KEY && !env.VAPID_SUBJECT) return { ok: true, note: 'push not configured' };
  if (!env.VAPID_PUBLIC_KEY) {
    return { ok: false, remedy: 'VAPID_PUBLIC_KEY is missing while the other VAPID secrets are set — every push send is rejected and silently dropped. Set it, and make sure it matches the key the app subscribes with.' };
  }
  try {
    const dead = await env.DB.prepare('SELECT COUNT(*) n FROM num_push_subs WHERE fails >= 5').first();
    const all = await env.DB.prepare('SELECT COUNT(*) n FROM num_push_subs').first();
    const bad = Number(dead?.n ?? 0);
    const total = Number(all?.n ?? 0);
    if (total >= 5 && bad / total > 0.5) {
      return { ok: false, dead: bad, of: total, remedy: `${bad} of ${total} push subscriptions have failed 5+ times. That usually means the VAPID keys were rotated on the server without the app being updated — check /api/push/config against the key the client subscribes with.` };
    }
    return { ok: true, dead: bad, of: total };
  } catch {
    return { ok: true };
  }
}

/**
 * Cash-out that can't reach the desk. This is the shape that lost money once:
 * a switch saying "open" over a road that doesn't arrive.
 */
function checkCashout(env) {
  if (env.CASHOUT_OK === '1' && !env.PAYOUT_DESK_KEY) {
    return { ok: false, remedy: 'CASHOUT_OK is on but PAYOUT_DESK_KEY is unset, so no cash-out can reach the payout desk. The code refuses rather than debiting, but the switch is lying — set the key or turn CASHOUT_OK off.' };
  }
  return { ok: true };
}

/** Inbound SMS with no token = an open mailbox anyone can post into. */
function checkSms(env) {
  if (env.TWILIO_FROM && !env.TWILIO_TOKEN) {
    return { ok: false, remedy: 'A texting number is configured but TWILIO_TOKEN is not, so inbound signatures cannot be verified and every inbound text is rejected (403). Set TWILIO_TOKEN.' };
  }
  return { ok: true };
}

/**
 * Storage headroom. Not about the bill — 1.24 GB of D1 costs about a dollar a
 * month. It is about the cliff: when this hit the cap the whole product went
 * read-only, and the directory grows without anyone deciding to grow it.
 */
async function checkStorage(env) {
  try {
    const r = await env.DB.prepare('SELECT COUNT(*) n FROM places').first();
    const places = Number(r?.n ?? 0);
    if (places > 4_000_000) {
      return {
        ok: false,
        places,
        remedy: 'The places directory is past 4M rows and heading for the cap that caused the 2-day write outage. Pause any ingest and move the directory to its own database (num-core).',
      };
    }
    return { ok: true, places };
  } catch {
    return { ok: true, places: null }; // absence of the table is not an outage
  }
}

/**
 * Does the front door actually open?
 *
 * WHY THIS EXISTS — 4 Aug 2026
 * itsnum.com served an infinite 301 loop for hours. Every path redirected to
 * itself, browsers gave up, the site was gone. During that window this health
 * system ran 288 checks and reported ZERO failures, because every other check
 * here inspects an internal dependency — D1, the model key, Stripe, Twilio.
 * All the ingredients were in the kitchen; nobody checked that a meal came
 * out. A total outage of the public site was structurally invisible.
 *
 * So this fetches the real URLs over the real internet and asserts three
 * things a dependency check cannot:
 *
 *   1. HTTP 200 — not a redirect, not a 5xx.
 *   2. `redirect: 'manual'` — a 301 is a FAILURE, not something to follow.
 *      Following redirects is exactly how a loop hides: curl and fetch will
 *      happily chase it and report the last hop, which looks like a slow
 *      success. Refusing to follow turns the loop into an instant, loud no.
 *   3. The body contains an expected marker. A 200 that serves the wrong
 *      thing — a parked page, an SPA shell where the marketing site should
 *      be — is still an outage to the person reading it.
 *
 * Deliberately tolerant of network flake: a fetch that throws is reported as
 * a failure with the error attached, never as a thrown exception, because a
 * monitor that can crash is a monitor that stops monitoring.
 */
async function checkPublic(url, marker) {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      cf: { cacheTtl: 0 },
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'num-health/1.0' },
    });
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location') || '(none)';
      return {
        ok: false,
        status: res.status,
        location: to,
        remedy: `${url} answers ${res.status} -> ${to} instead of serving a page. `
          + 'If the target equals the requested path this is a redirect loop: check that the '
          + 'Worker owning the route is deployed (npx wrangler deploy from app-main re-registers '
          + "num-console's itsnum.com/* routes), and that DNS is not pointing at a retired Pages project.",
      };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, remedy: `${url} returned HTTP ${res.status}.` };
    }
    const body = await res.text();
    if (marker && !body.includes(marker)) {
      return {
        ok: false,
        status: 200,
        remedy: `${url} answers 200 but the page does not contain "${marker}", so it is serving `
          + 'something other than the real site — a parked page, a stale deploy, or the wrong Worker.',
      };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    // Unreachable is a failure worth waking up for, but it must not throw.
    return { ok: false, remedy: `${url} could not be reached: ${e?.message ?? e}` };
  }
}

/**
 * The last verdict the cron actually observed, or null if it has never run.
 *
 * Staleness is surfaced, not swallowed: if the newest row is older than three
 * cron intervals the cron itself has stopped, and a monitor that quietly
 * reports a fifteen-minute-old "ok" is lying by omission.
 */
async function runHealthFromLastRun(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT at, verdict, failing, detail FROM num_health WHERE verdict <> 'probe' ORDER BY id DESC LIMIT 1",
    ).first();
    if (!row) return null;
    const ageMin = (Date.now() - new Date(row.at.replace(' ', 'T') + 'Z').getTime()) / 60000;
    if (ageMin > 16) {
      return {
        verdict: 'down',
        failing: ['health_cron_stalled'],
        checks: { health_cron_stalled: { ok: false, last_run: row.at, remedy:
          `The health cron has not run for ${Math.round(ageMin)} minutes. Check that the scheduled `
          + 'trigger is still deployed (npx wrangler triggers deploy --config wrangler.app.jsonc).' } },
        at: row.at,
      };
    }
    let checks = {};
    try { checks = JSON.parse(row.detail || '{}'); } catch { /* a truncated row is not an outage */ }
    return {
      verdict: row.verdict,
      failing: row.failing ? row.failing.split(',') : [],
      checks,
      at: row.at,
    };
  } catch { return null; }
}

export async function runHealth(env) {
  await ensure(env);
  // WHY ONLY itsnum.com IS PROBED HERE
  //
  // The first version of this also fetched https://app.itsnum.com/ and it
  // returned 522 every time — a false "down" while the app was serving fine.
  // Cause: this code IS num-app, and a Worker fetching its own public
  // hostname makes a subrequest that loops back into itself. Cloudflare times
  // it out rather than recursing. There is no header or cf option that fixes
  // that; it is the architecture saying no.
  //
  // itsnum.com is a different Worker (num-console) on the same zone, so this
  // probe is a genuine end-to-end check — and it is the surface that actually
  // broke on 4 Aug, so it is the one worth having.
  //
  // The gap this leaves, stated plainly: nothing here proves app.itsnum.com's
  // ROUTE resolves. The cron running proves the Worker executes, not that
  // traffic reaches it. Closing that needs a prober outside Cloudflare — an
  // external uptime check hitting /api/version every minute. Until that
  // exists, this file cannot honestly claim to watch the app's front door.
  const site = await checkPublic('https://itsnum.com/', 'NUM');
  const checks = {
    site_public: site,        // itsnum.com — a real cross-Worker probe
    d1_write: await checkWrite(env),
    brain: checkBrain(env),
    payments: checkPay(env),
    sms: checkSms(env),
    push: await checkPush(env),
    cashout: checkCashout(env),
    storage: await checkStorage(env),
  };
  const failing = Object.entries(checks).filter(([, v]) => !v.ok).map(([k]) => k);
  // A broken write or a dead brain is DOWN — the product does not work. So is
  // a front door that will not open: on 4 Aug the site served an infinite
  // redirect for hours while every internal check stayed green, which is
  // precisely the case this severity exists to stop being quiet about.
  const DOWN = ['d1_write', 'brain', 'site_public'];
  const verdict = failing.some((f) => DOWN.includes(f))
    ? 'down'
    : failing.length ? 'degraded' : 'ok';
  return { verdict, failing, checks, at: new Date().toISOString() };
}

/**
 * The cron body. Records every run and shouts only on a CHANGE of state —
 * a monitor that alerts every five minutes while something is broken trains
 * everyone to ignore it, which is how the next outage gets missed.
 */
export async function healthCron(env) {
  const out = await runHealth(env);
  const prev = await env.DB?.prepare("SELECT verdict FROM num_health WHERE verdict <> 'probe' ORDER BY id DESC LIMIT 1")
    .first().catch(() => null);

  await env.DB?.prepare('INSERT INTO num_health (verdict, failing, detail) VALUES (?1,?2,?3)')
    .bind(out.verdict, out.failing.join(',') || null, JSON.stringify(out.checks).slice(0, 2000))
    .run().catch(() => {});

  if (prev?.verdict !== out.verdict) {
    const remedies = Object.entries(out.checks)
      .filter(([, v]) => !v.ok && v.remedy)
      .map(([k, v]) => `• ${k}: ${v.remedy}`)
      .join('\n');
    const text = out.verdict === 'ok'
      ? '✅ Num is healthy again.'
      : `${out.verdict === 'down' ? '🔴 NUM IS DOWN' : '🟠 Num is degraded'} — ${out.failing.join(', ')}\n\n${remedies}`;
    await alert(env, text);
  }
  // Keep the log from becoming the thing it monitors.
  await env.DB?.prepare("DELETE FROM num_health WHERE at < datetime('now','-30 days')").run().catch(() => {});
  return out;
}

/** Wherever the humans are. Silent if nothing is configured — never throws. */
export async function alert(env, text) {
  if (env.ALERT_WEBHOOK) {
    await fetch(env.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  }
  if (env.ALERT_SMS_TO && env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM) {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: env.ALERT_SMS_TO, From: env.TWILIO_FROM, Body: text.slice(0, 320) }),
    }).catch(() => {});
  }
  console.warn('[health]', text);
}

export async function handleHealth(request, env, path) {
  // Run the cron body on demand. Two reasons this is not just a debug hook:
  // an external scheduler (uptime service, GitHub Action) can drive it if the
  // Workers cron ever stops firing, and a human can force a check after a fix
  // instead of waiting out the interval.
  if (path === '/run' && request.method === 'POST') {
    const { isAdmin } = await import('./console.mjs');
    if (!(await isAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
    const out = await healthCron(env);
    return json({ ran: true, ...out });
  }
  if (path === '/history') {
    await ensure(env);
    const { results } = await env.DB.prepare(
      "SELECT at, verdict, failing FROM num_health WHERE verdict <> 'probe' ORDER BY id DESC LIMIT 50",
    ).all();
    return json({ history: results ?? [] });
  }
  // Report what the CRON last observed; do not re-probe on every poll.
  //
  // Two reasons, one of which cost an hour on 4 Aug:
  //
  //   1. Running the public probe inside a live request makes a same-zone
  //      subrequest that fails where the identical probe succeeds from cron.
  //      The endpoint reported "down" while the cron reported "ok" — the
  //      monitor disagreeing with itself, which is worse than no monitor.
  //   2. An endpoint that performs outbound fetches per request is a lever
  //      anyone can pull. Uptime checkers poll this every minute.
  //
  // The cron is the observer; this is the window onto what it saw. If the
  // cron has not written for a while, that staleness is itself the signal, so
  // it is reported rather than hidden.
  let out = await runHealthFromLastRun(env);
  if (!out) out = await runHealth(env);   // first boot, before any cron row
  // PUBLIC gets the verdict. Nothing else.
  //
  // The full `checks` object names exactly which secrets are missing — "Stripe
  // can charge but the webhook secret is missing", "TWILIO_TOKEN is not set" —
  // which is a live reconnaissance feed telling an attacker precisely which
  // window is open right now. An uptime checker only ever needed the status
  // code and the word.
  const { isAdmin } = await import('./console.mjs');
  if (await isAdmin(env, request)) return json(out, out.verdict === 'down' ? 503 : 200);
  return json(
    { verdict: out.verdict, failing: out.failing.length, at: out.at },
    out.verdict === 'down' ? 503 : 200,
  );
}
