// Which worker actually answers a URL is not obvious, and getting it wrong is
// silent.
//
// itsnum.com is served by several workers whose routes overlap. num-console
// holds `itsnum.com/*`, the least specific pattern there is, so ANY other
// worker with a prefix route beats it. Two of those collisions have now cost
// real time:
//
//   • /sitemap.xml — num-biz-site answered it with 8 hardcoded URLs. That was
//     silently the sitemap Google read; 19 of 27 live pages were missing.
//   • /business/  — num-biz-site served a 15,929-byte page from 9 Aug while
//     the 17,471-byte page in this repo went to www only. Editing
//     public/business/index.html reached almost nobody, and `wrangler deploy`
//     correctly reported "No updated asset files to upload" the whole time.
//
// Both were fixed the same way: claim the exact path, because an exact route
// beats a prefix route. These tests keep those claims from being tidied away
// by someone who sees a redundant-looking catch-all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(HERE, '..', 'wrangler.jsonc'), 'utf8');
const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
const patterns = cfg.routes.map((r) => r.pattern);

test('the pages this repo owns are claimed by exact path, not left to the catch-all', () => {
  // itsnum.com/* cannot win against another worker's prefix route. Anything we
  // must be the source of truth for needs its own line.
  for (const p of ['itsnum.com/sitemap.xml', 'itsnum.com/business', 'itsnum.com/business/']) {
    assert.ok(patterns.includes(p), `${p} is not claimed — another worker will answer it and nobody will notice`);
  }
});

test('both spellings of /business are claimed', () => {
  // A route without a wildcard matches exactly one URL. Claiming only the
  // trailing-slash form leaves /business on the other worker, so the same page
  // answers differently depending on how it was linked.
  assert.ok(patterns.includes('itsnum.com/business'));
  assert.ok(patterns.includes('itsnum.com/business/'));
});

test('the /business claim is NOT a wildcard', () => {
  // num-biz-site is the only thing serving /business/pricing/,
  // /business/verification/ and /business/signup/ — all live, all 200, none of
  // them in public/. A wildcard here would 404 the page businesses sign up on.
  assert.ok(!patterns.includes('itsnum.com/business*'),
    'a wildcard claim would take three live pages this repo cannot serve');
  const owned = ['pricing', 'verification', 'signup']
    .filter((p) => patterns.some((x) => x.startsWith(`itsnum.com/business/${p}`)));
  assert.deepEqual(owned, [], 'claiming a sub-page we do not have a file for would 404 it');
});

test('every claimed page has a file behind it', () => {
  // The other half of the same mistake: claiming a route and having nothing to
  // serve turns a working page on another worker into a 404 on this one.
  const fileFor = { 'itsnum.com/business': 'business/index.html', 'itsnum.com/business/': 'business/index.html' };
  for (const [pattern, file] of Object.entries(fileFor)) {
    if (!patterns.includes(pattern)) continue;
    assert.doesNotThrow(() => readFileSync(join(HERE, '..', 'public', file)),
      `${pattern} is claimed but public/${file} does not exist`);
  }
});
