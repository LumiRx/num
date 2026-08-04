#!/usr/bin/env node
// The prober that lives OUTSIDE Cloudflare.
//
// worker/health.mjs is good at everything except the one question that matters
// most: "can a stranger load this?" It cannot answer that about app.itsnum.com,
// because a Worker fetching its own public hostname loops back and gets 522,
// and it cannot answer it at all if the Worker never runs — a dropped route, a
// bad deploy, an expired zone. A monitor hosted inside the thing it monitors
// goes down at exactly the moment you need it.
//
// So this runs on GitHub's infrastructure instead. Different company, different
// network, different failure domain. It asks the only question a visitor asks.
//
// Usage:  node scripts/uptime.mjs            (probe live, exit 1 on failure)
//         node scripts/uptime.mjs --json     (machine-readable)

// ── what a working front door looks like ──────────────────────────────────
//
// Each target names a marker that MUST appear in the body. Status alone is not
// enough: a parked page, a stale deploy and the SPA shell served where the
// marketing site belongs are all HTTP 200, and all of them are outages to the
// person reading them. The marker is the difference between "the server
// answered" and "the product is there".
export const TARGETS = [
  {
    name: 'site',
    url: 'https://itsnum.com/',
    // Present in the marketing site's own markup. Deliberately not a word that
    // a Cloudflare error page or a parked domain would also contain.
    marker: 'itsnum.com',
    why: 'the marketing site — every printed link, QR code and share points here',
  },
  {
    name: 'app',
    url: 'https://app.itsnum.com/api/version',
    // /api/version proves the WORKER ran, not merely that the CDN served an
    // asset. A static file can be cached and served long after the code behind
    // it has stopped working; this string can only come from executing code.
    marker: '"version"',
    why: 'the app Worker — where every ad click lands, and what health.mjs cannot self-check',
  },
  {
    name: 'app_health',
    url: 'https://app.itsnum.com/api/health',
    // The internal checks (D1 writable, brain key alive, pay rail intact),
    // read from outside. The endpoint reports the last cron verdict, so this
    // also catches a cron that has stopped running.
    marker: '"verdict"',
    // Unlike the others, this one has a body condition beyond the marker.
    downIfBodyMatches: /"verdict"\s*:\s*"down"/,
    why: 'the internal dependency checks, as seen from outside the building',
  },
];

const UA = 'num-uptime/1.0 (+https://itsnum.com)';
const TIMEOUT_MS = 15000;

// ── the judgement, separated from the network so it can be tested ─────────
//
// Every rule below exists because of a real failure mode, and each returns a
// remedy written for whoever is reading it at 2am — not an error code.
export function evaluate(target, result) {
  const { status, location, body, error } = result;

  if (error) {
    return { ok: false, reason: `unreachable: ${error}`,
      remedy: `${target.url} could not be reached at all. Check DNS for the hostname and whether the Cloudflare zone is active.` };
  }

  // A redirect is never followed. This is the whole reason the 4 Aug outage
  // was invisible: curl and fetch will happily chase a self-referential 301
  // until they give up, and every intermediate hop looks like a normal
  // response. Refusing to follow turns a loop into an immediate, obvious no.
  if (status >= 300 && status < 400) {
    return { ok: false, reason: `HTTP ${status} → ${location || '(no Location)'}`,
      remedy: `${target.url} is redirecting. If the target points back at this same host, it is the redirect loop: DNS is pointing at a retired Pages project and the Worker has lost its route. Redeploy the owning Worker.` };
  }

  if (status !== 200) {
    return { ok: false, reason: `HTTP ${status}`,
      remedy: status === 522
        ? `${target.url} returned 522 — the origin did not answer. If a Worker is probing its own hostname, that is expected and the probe is wrong; from outside, it means the origin is genuinely down.`
        : `${target.url} returned HTTP ${status} instead of 200.` };
  }

  if (target.marker && !body.includes(target.marker)) {
    return { ok: false, reason: `200 but body is missing ${JSON.stringify(target.marker)}`,
      remedy: `${target.url} answered 200 with the wrong content — a parked page, a stale deploy, or the SPA shell served where this page belongs. A 200 is not proof the product is there.` };
  }

  if (target.downIfBodyMatches && target.downIfBodyMatches.test(body)) {
    return { ok: false, reason: 'health endpoint reports verdict: down',
      remedy: `${target.url} is reachable but reporting itself unhealthy. Open it directly — the detail field names the failing check.` };
  }

  return { ok: true, reason: `HTTP ${status}` };
}

async function probe(target) {
  try {
    const res = await fetch(target.url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return {
      status: res.status,
      location: res.headers.get('location'),
      // Cap the read. A probe that can be made to hang by a large response is
      // a probe that stops probing.
      body: (await res.text()).slice(0, 20000),
    };
  } catch (e) {
    return { error: e?.message ?? String(e), status: 0, location: null, body: '' };
  }
}

export async function runAll(targets = TARGETS) {
  const checks = [];
  for (const t of targets) {
    const verdict = evaluate(t, await probe(t));
    checks.push({ name: t.name, url: t.url, why: t.why, ...verdict });
  }
  return { at: new Date().toISOString(), ok: checks.every((c) => c.ok), checks };
}

// ── entrypoint ────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await runAll();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const c of out.checks) {
      console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(11)} ${c.reason}`);
      if (!c.ok) {
        // ::error:: renders in the GitHub Actions summary, so the remedy is
        // visible without opening the log.
        console.log(`::error title=${c.name} is down::${c.remedy}`);
      }
    }
    console.log(out.ok ? '\nAll front doors open.' : '\nFRONT DOOR DOWN — see remedies above.');
  }

  // Non-zero fails the workflow, which is what actually sends the alert.
  process.exit(out.ok ? 0 : 1);
}
