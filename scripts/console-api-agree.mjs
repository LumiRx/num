// Does the live console agree with the live API?
//
// The console ships from num-console. The endpoints it calls ship from
// num-growth. They are two workers and two deploys, so one can go out without
// the other — and when it does, a host opens their working tool and finds a
// whole section where every button does nothing. That happened on 12 Sep 2026
// with the Fleet card: the card was live on itsnum.com and
// /api/host/assets answered 404 for as long as it took somebody to notice.
//
// Tests cannot catch this. The code was correct in both workers; only one of
// them was deployed. The only way to see it is to ask the live site.
//
// So: read the LIVE console, pull out every endpoint it calls, and ask the live
// API about each one. A 404 means the console is calling something nothing
// serves. Every other answer — 401, 403, 200 — means the route exists, which is
// all this is checking. We deliberately send no key, so nothing is touched.

const SITE = process.env.SITE || 'https://itsnum.com';
const CONSOLE_URL = `${SITE}/host/`;

/** Every api('x') call in the console becomes /api/host/x. */
export function pathsFrom(html) {
  const names = new Set([...html.matchAll(/\bapi\('([a-z0-9-]+)'/g)].map((m) => m[1]));
  // Plus anything it builds as a literal path, like the image route.
  //
  // The quote in front of the path is NOT part of the match. The image URL is
  // built inside an HTML string — `'<img src="/api/host/asset-image?id='` — so
  // it is preceded by a double quote, and a pattern that insisted on a single
  // quote missed the one endpoint most likely to be forgotten in a deploy.
  const literals = new Set([...html.matchAll(/\/api\/host\/([a-z0-9-]+)/g)].map((m) => '/api/host/' + m[1]));
  return [...new Set([...[...names].map((n) => `/api/host/${n}`), ...literals])].sort();
}

/**
 * Is this path served at all?
 *
 * GET first. Several host endpoints are POST-only — /api/host/close and
 * /api/host/contacts among them — and a GET to one of those falls through the
 * router and lands on the site's 404 page. Reporting those as missing is how a
 * check like this gets a reputation for crying wolf and then gets switched off,
 * which costs more than not having it.
 *
 * So a 404 on GET is retried as POST. Sending no key and no body is safe on
 * every host endpoint by construction: hostAuth() runs before anything else in
 * all of them and answers 401 with a missing key, and badOrigin() rejects
 * before any write. A 401, 403 or 400 all mean the same thing here — the route
 * exists. Only a 404 from BOTH methods means nothing serves it.
 */
async function reachable(p) {
  const ask = async (method) => {
    try {
      const r = await fetch(`${SITE}${p}`, { method, redirect: 'manual' });
      return r.status;
    } catch { return -1; }
  };
  const get = await ask('GET');
  if (get !== 404) return { ok: get !== -1, code: get };
  const post = await ask('POST');
  if (post !== 404 && post !== -1) return { ok: true, code: post, via: 'POST only' };
  return { ok: false, code: post === -1 ? -1 : 404 };
}

async function main() {
  const res = await fetch(CONSOLE_URL);
  if (!res.ok) {
    console.error(`Could not read the live console at ${CONSOLE_URL} — HTTP ${res.status}`);
    process.exit(1);
  }
  const html = await res.text();
  const paths = pathsFrom(html);

  if (!paths.length) {
    console.error('Read the console but found no api() calls in it. That is either a');
    console.error('changed helper name or a page that did not deploy — check by hand.');
    process.exit(1);
  }

  console.log(`Console at ${CONSOLE_URL} calls ${paths.length} endpoints. Asking the API about each.\n`);

  const missing = [];
  for (const p of paths) {
    const probe = await reachable(p);
    if (!probe.ok) missing.push({ p, code: probe.code });
    console.log(`   ${String(probe.code).padEnd(5)} ${p.padEnd(32)} ${probe.ok ? 'ok' : probe.code === -1 ? 'UNREACHABLE' : 'MISSING'}${probe.via ? ' (' + probe.via + ')' : ''}`);
  }

  console.log();
  if (!missing.length) {
    console.log('The console and the API agree. Every endpoint the page calls is served.');
    return;
  }

  console.error(`${missing.length} endpoint${missing.length === 1 ? '' : 's'} the live console calls ${missing.length === 1 ? 'is' : 'are'} NOT SERVED:`);
  for (const m of missing) console.error(`   ${m.p}`);
  console.error('');
  console.error('A host using the console right now is pressing buttons that do nothing.');
  console.error('Almost always this means num-growth was not deployed alongside num-console:');
  console.error('   npx wrangler deploy --config growth/wrangler.jsonc');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
