#!/usr/bin/env node
/**
 * A HANDLER IS NOT A ROUTE — and now something checks, against production.
 *
 * This project has shipped the same defect at least six times. A form goes
 * live, looks perfect, posts to a path whose handler exists, and stores
 * nothing — because no ROUTE PATTERN carries that path on the host the page
 * is actually served from. The request falls through to num-console, an
 * assets-only Worker, which answers a POST with 405 and an empty body. The
 * page's own error handling turns that into "something went wrong", or into
 * nothing at all.
 *
 * The receipts, all written into the config comments by the people it bit:
 *   /api/sms-optin*  "every submission hit the static asset worker and
 *                     returned 405 — the form looked live and stored nothing"
 *   /s/*             itsnum.com/s/FARMER served public/404.html
 *   /api/pay/*       every QR on /biz/pay resolved to the 404 page
 *   /p/*             guests' pay links fell through
 *   /biz             "itsnum.com/biz/*" never matched a bare "/biz"
 *   /api/partner/*   found by this script, 2026-09-19, silently 405 since launch
 *
 * WHY THIS PROBES PRODUCTION INSTEAD OF READING THE CONFIGS.
 * The obvious version of this check parses the wrangler files and matches
 * patterns. It was written first and it was WRONG, because itsnum.com is
 * served by roughly eleven Workers and only three of them have a config in
 * this repo — num-accounts, num-claim and the rest live elsewhere. A guard
 * built on an incomplete map reports failures that work fine, and the first
 * time it cries wolf somebody deletes it.
 *
 * So it asks the internet. An empty POST to a routed endpoint comes back as
 * JSON saying which field is missing — that is a PASS, the door is open and
 * the form is talking to something. A 405, or a 404 carrying HTML, means the
 * request reached the static asset worker and no code will ever see it.
 * Nothing is created: every probe is an empty body that fails validation.
 *
 *   npm run check:routes
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** public/ is served at the apex. app-public/ is served at the app host. */
const SURFACES = [
  { dir: 'public', host: 'https://itsnum.com' },
  { dir: 'app-public', host: 'https://app.itsnum.com' },
];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(html|js)$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * The relative /api/ paths a page calls. Absolute URLs are deliberately
 * ignored: they name their own host and cannot fall through to the assets
 * worker by accident, which is the failure this guard exists to catch.
 */
export function apiCalls(text) {
  const found = new Set();
  const pats = [
    /fetch\(\s*[`'"](\/api\/[^`'"?\s]*)/g,
    /NUM\.call\(\s*[`'"](\/api\/[^`'"?\s]*)/g,
    /\b(?:ENDPOINT|EVENT_URL|API_PATH)\s*=\s*[`'"](\/api\/[^`'"?\s]*)/g,
  ];
  for (const re of pats) {
    let m;
    while ((m = re.exec(text))) {
      const p = m[1].replace(/\$\{.*$/, '').replace(/\/+$/, '');
      if (p.length > 5) found.add(p);
    }
  }
  // A template literal like fetch(`/api/host/${id}`) leaves the prefix
  // "/api/host" behind once the expression is cut off. That prefix is not an
  // endpoint anybody calls, and probing it reports a failure that is really
  // just this regex's shadow. If a captured path is a strict prefix of another
  // path from the same file, it is that shadow — drop it.
  const all = [...found];
  return all.filter((p) => !all.some((q) => q !== p && q.startsWith(`${p}/`)));
}

/** Every (host, path) a shipped page would call, with the pages that call it. */
export function surface() {
  const map = new Map();
  for (const { dir, host } of SURFACES) {
    for (const file of walk(join(ROOT, dir))) {
      for (const path of apiCalls(readFileSync(file, 'utf8'))) {
        const key = `${host}${path}`;
        if (!map.has(key)) map.set(key, { host, path, pages: [] });
        map.get(key).pages.push(relative(ROOT, file));
      }
    }
  }
  return [...map.values()];
}

/**
 * Open, or swallowed?
 *
 * PASS  any JSON answer, whatever the status — the request reached code.
 * FAIL  405              — the assets worker refusing a method it has no
 *                          opinion about. This is the signature.
 * FAIL  404 + text/html  — the site's 404 page. The path fell through.
 */
export async function probe({ host, path }, fetchImpl = fetch) {
  const url = `${host}${path}`;
  const call = async (method) => {
    const res = await fetchImpl(url, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined,
      redirect: 'follow',
    });
    return { res, type: String(res.headers.get('content-type') ?? ''), body: await res.text() };
  };

  let post;
  try { post = await call('POST'); } catch (e) {
    return { url, ok: false, why: `unreachable (${e?.message ?? 'network'})` };
  }

  if (post.type.includes('json')) return { url, ok: true, status: post.res.status, verb: 'POST' };

  // THE SIGNATURE. num-console answers a method it has no opinion about with a
  // bare 405: no content-type, no body. A Worker that ran code and decided it
  // did not like the verb always says something. That difference is the whole
  // test, and getting it wrong in either direction makes this guard useless —
  // too loose and it misses a swallowed form, too strict and somebody deletes
  // it the first time it fails on a GET-only endpoint.
  const bare405 = post.res.status === 405 && !post.type && !post.body.trim();
  if (bare405) {
    return { url, ok: false, status: 405, why: 'bare 405, no body — fell through to the assets Worker; no code will ever see this submission' };
  }
  if (post.res.status === 404 && post.type.includes('text/html')) {
    return { url, ok: false, status: 404, why: '404 serving the site 404 page — the path is not routed on this host' };
  }

  // Something answered, but not in JSON. Most often a GET-only endpoint told
  // off for being POSTed at. Ask again properly before accusing it.
  let get;
  try { get = await call('GET'); } catch { get = null; }
  if (get?.type.includes('json')) return { url, ok: true, status: get.res.status, verb: 'GET' };
  if (get && get.res.status === 404 && get.type.includes('text/html')) {
    return { url, ok: false, status: 404, why: '404 serving the site 404 page on both verbs — not routed on this host' };
  }
  return { url, ok: true, status: post.res.status, verb: 'POST', note: `answered ${post.type || 'no content-type'} — reached code, but check the verb` };
}

async function main() {
  const targets = surface();
  console.log(`routecheck: probing ${targets.length} endpoints that shipped pages actually call…\n`);
  const bad = [];
  for (const t of targets) {
    const r = await probe(t);
    const mark = r.ok ? 'ok  ' : 'FAIL';
    console.log(`  ${mark} ${String(r.status ?? '---').padEnd(4)} ${r.url}${r.note ? `  (${r.note})` : ''}`);
    if (!r.ok) bad.push({ ...r, pages: t.pages });
  }
  if (!bad.length) {
    console.log('\nEvery endpoint a page calls is answered by code. No submission is being swallowed.');
    return 0;
  }
  console.error(`\n${bad.length} SUBMISSION PATH(S) ARE BEING SWALLOWED:\n`);
  for (const b of bad) {
    console.error(`  ${b.url}`);
    console.error(`    ${b.why}`);
    console.error(`    called by: ${b.pages.join(', ')}\n`);
  }
  console.error('Fix by adding a route pattern for this path to the Worker that owns the');
  console.error('handler, or by serving the page from the host that already answers it.\n');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
