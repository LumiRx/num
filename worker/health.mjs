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

export async function runHealth(env) {
  await ensure(env);
  const checks = {
    d1_write: await checkWrite(env),
    brain: checkBrain(env),
    payments: checkPay(env),
    sms: checkSms(env),
    storage: await checkStorage(env),
  };
  const failing = Object.entries(checks).filter(([, v]) => !v.ok).map(([k]) => k);
  // A broken write or a dead brain is DOWN — the product does not work. The
  // rest degrade a feature without taking the app with them.
  const verdict = failing.includes('d1_write') || failing.includes('brain')
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
async function alert(env, text) {
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
  if (path === '/history') {
    await ensure(env);
    const { results } = await env.DB.prepare(
      "SELECT at, verdict, failing FROM num_health WHERE verdict <> 'probe' ORDER BY id DESC LIMIT 50",
    ).all();
    return json({ history: results ?? [] });
  }
  const out = await runHealth(env);
  // A monitor that answers 200 when the thing is down is a monitor nobody can
  // point an uptime checker at.
  return json(out, out.verdict === 'down' ? 503 : 200);
}
