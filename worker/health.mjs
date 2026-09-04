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
import { senderParams } from './twiliosender.mjs';
import { NOT_PROBE } from './asks.mjs';

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
  // The 30034 check. A US long code carries A2P campaign approval only through
  // its Messaging Service; sending as a bare number is rejected by the carrier
  // with the same error an unregistered brand gets, which is how this went
  // unread for a month while the campaign sat approved in the console.
  //
  // It is a WARNING, not a failure: outside the US no campaign is needed and
  // the bare number is correct, so this must never take the health check red
  // for a Thailand-only deployment.
  const svc = String(env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  if (env.TWILIO_FROM && !svc) {
    return { ok: true, warn: 'TWILIO_FROM is set but TWILIO_MESSAGING_SERVICE_SID is not, so US-destined texts go out as a bare number and carriers reject them with 30034 even when the A2P campaign is approved. Set the Messaging Service SID (MG…) that carries the campaign, and confirm the number is in that service\'s sender pool.' };
  }
  if (svc && !/^MG[0-9a-f]{32}$/i.test(svc)) {
    return { ok: false, remedy: `TWILIO_MESSAGING_SERVICE_SID is set to something that is not a Messaging Service SID (expected MG + 32 hex, got ${svc.slice(0, 4)}…). An account SID starts AC, a campaign CM, a brand BN — check which one was pasted. Every send is falling back to the bare number. GET /api/admin/twilio (X-Admin-Key) asks Twilio which service carries the approved campaign AND holds our number, and prints the exact command to set it.` };
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
    // Ask D1 how big it is instead of counting the directory. The previous
    // version ran `SELECT COUNT(*) FROM places` — a full scan of ~2.69M rows —
    // every five minutes: ~774M rows read per day, about $23/month, to guard a
    // storage bill of roughly a dollar. D1 reports its own size on every
    // statement's `meta.size_after`, so a one-row query answers the real
    // question (distance to the cap) for free. The cap that caused the 2-day
    // read-only outage is a byte limit, not a row count.
    const probe = await env.DB.prepare('SELECT 1').run();
    const bytes = Number(probe?.meta?.size_after ?? 0);
    const CAP_BYTES = 10 * 1024 ** 3; // D1 paid-plan per-database limit
    const WARN_BYTES = 6 * 1024 ** 3;  // ample runway to move the directory out
    if (bytes > WARN_BYTES) {
      return {
        ok: false,
        bytes,
        capBytes: CAP_BYTES,
        remedy: `Database is ${(bytes / 1024 ** 3).toFixed(2)} GB of a ${CAP_BYTES / 1024 ** 3} GB cap. Pause any ingest and move the places directory to its own database (num-core) before the cap makes the product read-only again.`,
      };
    }
    return { ok: true, bytes, capBytes: CAP_BYTES };
  } catch {
    return { ok: true, bytes: null }; // an unreadable size is not an outage
  }
}

/**
 * Brains that are standing down. A brain with class 'quota' or 'auth' means
 * guests are being answered by fallback when they shouldn't be — the 9-10 Aug
 * and 11 Aug outages both ran 18+ hours because nothing read this table
 * while the product silently degraded to prose-only.
 */
async function checkBrains(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT brain, fails, class, last_error, cooldown_until FROM num_brain_state WHERE class IS NOT NULL AND cooldown_until > ?1 ORDER BY cooldown_until DESC',
    ).bind(Math.floor(Date.now() / 1000)).all().catch(() => ({ results: null }));
    // WHAT COUNTS AS "SOMEBODY HAS TO DO SOMETHING".
    //
    // quota and auth need a human and never heal on their own. `blocked` — an
    // edge or WAF refusal in front of the vendor — normally heals in seconds,
    // so a single one is noise and must NOT raise the same alarm; that
    // conflation on 31 Aug 2026 printed "mint a new key" for a key that was
    // working. But a block that keeps coming back is no longer weather, so it
    // joins the list once it has failed three times in a row.
    const needsHuman = (r) => {
      const cls = String(r.class).toLowerCase();
      return cls === 'quota' || cls === 'auth' || (cls === 'blocked' && Number(r.fails) >= 3);
    };
    const down = (results ?? []).filter(needsHuman);
    const cooling = (results ?? []).filter((r) => !down.includes(r));
    if (down.length) {
      const names = down.map((r) => `${r.brain} (${r.class}${r.last_error ? ': ' + String(r.last_error).slice(0, 80) : ''})`).join('; ');
      return {
        ok: false,
        down,
        // The remedy names the class it is talking about. The old one offered
        // every fix at once — "top up, or mint a new key" — which is how a
        // 403 from an upstream edge became an instruction to rotate a
        // credential that had nothing wrong with it.
        remedy: `${down.length} brain(s) are standing down: ${names}. `
          + 'Quota: check the vendor balance and top up. '
          + 'Auth: the vendor rejected the credential itself — mint a new key and `wrangler versions secret put`. '
          + 'Blocked: something IN FRONT of the vendor API refused us (edge, WAF, region). The key is not the problem; '
          + 'check vendor status and whether the calls are egressing from an unexpected region.',
      };
    }
    return { ok: true, cooling: cooling.map((r) => r.brain) };
  } catch {
    return { ok: true };
  }
}

/**
 * IS ANYTHING BROKEN THAT NOBODY HAS BEEN TOLD ABOUT.
 *
 * The other checks on this page ask a dependency how it feels. This one asks
 * whether the reporting itself is working — which on 3 Sep 2026 turned out to
 * be the only question that mattered. The watchman had been recording four
 * real failures for a month into a LINE channel that returned 404 on every
 * send, and no dashboard anywhere showed a thing.
 *
 * OPEN AND UNTOLD is the failing condition, not merely OPEN. A failure that
 * somebody has been told about is work in progress; a failure nobody knows
 * about is the product deceiving its owners.
 */
async function checkFailures(env) {
  try {
    const { summary } = await import('./failures.mjs');
    const s = await summary(env);
    if (!s.open) return { ok: true, open: 0 };
    if (!s.blind && !s.critical) {
      // Known about, being handled. Reported, not alarming.
      return { ok: true, open: s.open, high: s.high, worst: s.worst };
    }
    return {
      ok: false,
      ...s,
      remedy: s.blind
        ? `${s.open} open failure(s) and at least one that nobody was successfully told about. `
          + 'Read GET /api/admin/failures. While this is true, every other check on this page is '
          + 'unverified — the alarm channel is the thing to fix first, before the failures themselves.'
        : `${s.critical} critical failure(s) open: ${s.worst.map((w) => `${w.kind} ${w.subject}`).join('; ')}. `
          + 'GET /api/admin/failures for the detail.',
    };
  } catch (e) {
    // A ledger that cannot be read is itself a reason to be suspicious, but it
    // is not proof the product is down.
    return { ok: true, error: String(e?.message ?? e).slice(0, 120) };
  }
}

/**
 * WHO IS ACTUALLY ANSWERING — the check that would have caught 3 Sep 2026.
 *
 * Every brain reported ready, /api/health said ok, and brains_state.cooling
 * was empty, while the most-used lane on the dashboard read `moderate:none`
 * with brain NULL on 12 of 41 asks. Nothing was down: the two corrective
 * retries in /api/num rebuilt the result object and dropped `_brain` on the
 * way through, so healthy answers filed themselves as though no brain had
 * produced them (fixed in worker/routinglabel.mjs).
 *
 * It cost days, because every check we had was asking the brains how they
 * felt rather than reading what they had signed. So this one reads the
 * signatures: over the last day of real asks, how many arrived with nobody's
 * name on them.
 *
 * A warning, never a page. `brain: null` on a live product means one of two
 * things and both need a human eventually, neither this minute:
 *   - the fallback line really is going out (a genuine, quiet degradation), or
 *   - the attribution is lying again (a reporting bug wearing an outage's
 *     clothes, which is the expensive one).
 * Cached and small-lane rows are excluded — they never had a brain to lose.
 */
async function checkAttribution(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN brain IS NULL OR brain = '' THEN 1 ELSE 0 END) AS unattributed
         FROM num_asks
        WHERE ts > datetime('now', '-1 day')
          AND cached = 0
          AND (lane IS NULL OR lane NOT IN ('small', 'cache', 'rescue'))
          AND ${NOT_PROBE}`,
    ).first().catch(() => null);
    const n = Number(row?.n ?? 0);
    const orphan = Number(row?.unattributed ?? 0);
    // Under ten asks a day, one odd row is 10% and means nothing. Silence is
    // the honest answer on a sample that small.
    if (n < 10) return { ok: true, asks: n };
    const share = orphan / n;
    if (share >= 0.2) {
      return {
        ok: false,
        asks: n,
        unattributed: orphan,
        remedy:
          `${orphan} of ${n} answers in the last day recorded no brain (${Math.round(share * 100)}%). `
          + 'If the brains are otherwise healthy this is almost certainly ATTRIBUTION, not an outage: '
          + 'something on the answer path is rebuilding the result and dropping `_brain` — see '
          + 'worker/routinglabel.mjs, which exists because that exact bug read as "the brain is down" for days. '
          + 'If brains_state also shows brains standing down, believe that one instead: the fallback line really is shipping.',
      };
    }
    return { ok: true, asks: n, unattributed: orphan };
  } catch {
    // A missing column on an older table is not an outage.
    return { ok: true };
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
 * "A real health run", as SQL.
 *
 * ── THE BUG THIS CLOSES ───────────────────────────────────────────────────
 *
 * `num_health` is not written only by the health cron. `mailer.selfTest()`
 * also writes to it, using the `failing` column — which everywhere else holds
 * a comma-separated list of FAILING CHECK NAMES — as a label: `mail:selftest`,
 * with verdict `ok` and a plain-text detail.
 *
 * Found 2026-08-30 by reading /api/health during a sweep. It answered:
 *
 *     { "verdict": "ok", "failing": 1, "at": "2026-08-30 19:46:05" }
 *
 * Healthy, with one thing failing. Both halves came from the self-test row.
 *
 * Cosmetic on a good day. On a bad one it is the outage that gets missed:
 *
 *   - a self-test row landing AFTER a degraded run makes /api/health report
 *     `ok`, so the monitor stops showing a live failure;
 *   - `detail` on those rows is prose, not JSON, so `checks` parses to `{}`
 *     and every per-check remedy vanishes from the endpoint;
 *   - healthCron alerts on a CHANGE of verdict, so with `ok` rows interleaved
 *     every five minutes a sustained outage flips ok -> degraded -> ok ->
 *     degraded forever, and pages on every second tick.
 *
 * Both readers now ask for health runs specifically, rather than for whatever
 * was written to this table last.
 */
const REAL_RUN = "verdict <> 'probe' AND (failing IS NULL OR failing NOT LIKE 'mail:%')";

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
      `SELECT at, verdict, failing, detail FROM num_health WHERE ${REAL_RUN} ORDER BY id DESC LIMIT 1`,
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
    brains_state: await checkBrains(env),
    attribution: await checkAttribution(env),
    failures: await checkFailures(env),
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
  // `failures` joins the DOWN list for one reason only, and it is the reason
  // this whole ledger exists: it goes not-ok when something is broken AND
  // nobody was successfully told. A product that is quietly broken while its
  // alarms shout into a dead wire — 81 line_404 rows over a month — is down in
  // every sense that matters, because nothing else it reports can be believed.
  const DOWN = ['d1_write', 'brain', 'site_public', 'failures'];
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
  const prev = await env.DB?.prepare(`SELECT verdict FROM num_health WHERE ${REAL_RUN} ORDER BY id DESC LIMIT 1`)
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
export async function alert(env, text, { kind = 'alert', subject = '' } = {}) {
  // WRITTEN DOWN BEFORE IT IS SENT.
  //
  // For a month the watchman reported four real failures into a dead LINE
  // channel — 81 rows, every one line_404 — and nobody could see any of them,
  // because the way you would find out was the broken thing. So the ledger
  // comes first and is not conditional on any channel working. See
  // worker/failures.mjs.
  const { record, told: markTold } = await import('./failures.mjs');
  await record(env, {
    kind, subject: subject || text.slice(0, 100),
    detail: text, severity: 'high',
  });
  // Did ANY channel take it. Not "did we try" — the four fire-and-forget
  // catches below made trying and succeeding indistinguishable.
  let carried = null;

  if (env.ALERT_WEBHOOK) {
    const r = await fetch(env.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => null);
    if (r && r.ok) carried = carried || 'webhook';
  }
  // The quietest of the three senders, and the one it would hurt most to leave
  // behind: its whole job is to tell us something broke. If it keeps sending
  // `From: <number>` after the others move to the Messaging Service, the alert
  // that an outage has started is the message the carrier drops.
  const smsSender = senderParams(env);
  if (env.ALERT_SMS_TO && env.TWILIO_SID && env.TWILIO_TOKEN && smsSender) {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: env.ALERT_SMS_TO, ...smsSender, Body: text.slice(0, 320) }),
    }).then((r) => { if (r && r.ok) carried = carried || 'sms'; }).catch(() => {});
  }
  // Resend email — the handoff mandates this path so an outage that runs 18
  // hours before a human notices (9-10 Aug, 11 Aug) is impossible again.
  // The key lives in a separate secrets file (never Gmail); the address wakes
  // a person, not a role account that nobody checks.
  if (env.RESEND_API_KEY && env.ALERT_EMAIL_TO) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.ALERT_EMAIL_FROM || 'Num <alerts@itsnum.com>',
        to: env.ALERT_EMAIL_TO,
        subject: `Num ${text.slice(0, 50)}`,
        text,
      }),
    }).then((r) => { if (r && r.ok) carried = carried || 'resend'; }).catch(() => {});
  }

  // ── THE ALERTER WAS ITSELF UNREACHABLE ──────────────────────────────────
  //
  // On 30 Aug 2026 all three channels above were dead at once and nothing
  // said so, which is the worst possible failure for this function: its only
  // job is to be the thing that still works when other things do not.
  //
  //   ALERT_WEBHOOK   — not set
  //   Twilio SMS      — A2P campaign unapproved, every send rejected 30034
  //   Resend          — key returns 401 invalid; and this block reads
  //                     RESEND_API_KEY while the rest of the codebase sets
  //                     RESEND_KEY, so on most deployments it never ran at all
  //
  // So the mailer goes last and unconditionally: it owns transport fallback,
  // and the Cloudflare binding reaches the account's verified addresses even
  // when every credential is dead. An alert nobody receives is a log line
  // with extra steps.
  const to = env.ALERT_EMAIL_TO || env.ADMIN_EMAIL;
  if (to) {
    try {
      const { send } = await import('./mailer.mjs');
      const r = await send(env, {
        to,
        from: env.ALERT_EMAIL_FROM || 'Num <alerts@itsnum.com>',
        subject: `Num alert — ${text.slice(0, 60)}`,
        text: `${text}\n\n— Num, automatically. Reply and a person will see it.`,
      });
      if (r.ok) carried = carried || `mail:${r.via}`;
      else console.error('[health] ALERT UNDELIVERABLE —', r.error);
    } catch (e) {
      console.error('[health] alert mailer threw', e?.message ?? e);
    }
  }

  // ── THE STATE THAT OUTRANKS EVERY OTHER ─────────────────────────────────
  //
  // "Something is broken" is a degradation. "Something is broken AND we could
  // not tell you" is an outage, because from that moment every green light on
  // every other dashboard is an unverified claim. It is recorded as critical
  // so /api/health carries it, and the uptime probe outside Cloudflare — the
  // one reporting path with a month of proven delivery — reads that.
  if (carried) {
    await markTold(env, kind, subject || text.slice(0, 100), carried);
  } else {
    const { record: rec } = await import('./failures.mjs');
    await rec(env, {
      kind: 'alert_undelivered',
      subject: 'no channel accepted an alert',
      detail: `Nothing carried: "${text.slice(0, 200)}". Tried webhook / SMS / Resend / mailer. `
        + 'While this is open, every other check on this page is unverified.',
      severity: 'critical',
    });
  }
  console.warn('[health]', text, carried ? `(via ${carried})` : '(UNDELIVERED)');
  return { carried };
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
      `SELECT at, verdict, failing FROM num_health WHERE ${REAL_RUN} ORDER BY id DESC LIMIT 50`,
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
