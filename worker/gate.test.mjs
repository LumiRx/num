// The login that cannot fail silently.
//
// The JS gate produced five distinct flavours of nothing: a load race that ate
// keystrokes, a service-worker swap that aborted the first POST, an autofill
// overlay over an empty field, a missing autofocus, and errors too quiet to
// see. Each was real, each was fixed, each was replaced by the next. The
// rebuild removes the whole class: a native <form> posts to the worker, the
// browser carries the submission, the server answers with a redirect. There
// is no script left in the path to go quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionCookie } from './console.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');
const api = readFileSync(join(HERE, 'console.mjs'), 'utf8');

test('the submission path contains no JavaScript', () => {
  assert.match(page, /<form id="gateform" method="post" action="\/api\/admin\/login">/,
    'the gate is not a native form — the submission depends on script again');
  assert.ok(!/gateform'\)\.addEventListener\('submit'/.test(page),
    'a submit listener is back on the form — it can preventDefault the native path into silence');
  assert.ok(!/signin'\)\.onclick/.test(page),
    'the button has a JS onclick again — the fetch-based login and its five silent failures are back');
  assert.match(page, /name="key"/, 'the input lost its form name — the POST body arrives empty');
});

test('the server answers every submission with a visible outcome', () => {
  assert.match(api, /path === '\/admin\/login' && post/, 'the form has nowhere to POST — submissions 404');
  assert.match(api, /err=wrong/, 'a wrong key no longer redirects back with a reason');
  assert.match(api, /HttpOnly; Secure; SameSite=Lax/, 'the session cookie lost its protections');
  assert.match(api, /status: 303/, 'the login answers with something other than a redirect — a form POST will render raw JSON');
  assert.match(page, /'Wrong password\.'/, 'the gate no longer translates err=wrong into words');
});

test('the dashboard opens on the cookie alone', () => {
  // After a form login there is NO JS token — HttpOnly means script cannot
  // see it. boot() must ask the server rather than bail on a missing token.
  assert.ok(!/if \(!S\.key\) \{ \$\('gate'\)/.test(page),
    'boot bails when sessionStorage is empty — a form login can never reach the dashboard');
  assert.match(api, /sessionCookie\(req\.headers\.get\('Cookie'\)\)/,
    'isAdmin ignores the cookie — the form login authenticates nothing');
});

test('the cookie parser is exact', () => {
  assert.equal(sessionCookie('num_ops_session=abc.def'), 'abc.def');
  assert.equal(sessionCookie('other=1; num_ops_session=x%2Ey; theme=dark'), 'x.y');
  assert.equal(sessionCookie('num_ops_session_old=evil; foo=1'), null,
    'a prefix-named cookie matches — another cookie can impersonate the session');
  assert.equal(sessionCookie(null), null);
});

test('a cookie that fails right after login names itself', () => {
  assert.match(api, /\/ops\/\?in=1/, 'the login redirect lost its marker — a dead cookie is indistinguishable from a first visit');
  assert.match(page, /cookie did not stick/, 'the page no longer explains a cookie failure — silence returns wearing new clothes');
});

test('the session survives a browser that refuses cookies', () => {
  // Observed 8 Aug: password accepted (?in=1 reached), cookie set by the
  // server, dashboard still gated — the browser accepted the login and then
  // silently declined to store or return the cookie. The token therefore
  // travels twice: HttpOnly cookie AND URL fragment. The fragment never
  // leaves the browser, and the page moves it into sessionStorage — the auth
  // path that has worked since the dashboard shipped — then wipes it from
  // the address bar.
  assert.match(api, /#t=\$\{encodeURIComponent\(token\)\}/,
    'the login redirect no longer carries the token — a cookie-refusing browser locks the admin out with a correct password');
  assert.match(page, /location\.hash\.slice\(1\)\)\.get\('t'\)/,
    'the page never collects the fragment token — the second carrier is dead weight');
  assert.match(page, /history\.replaceState\(null, '', '\/ops\/'\)/,
    'the token lingers in the address bar and browser history after use');
});

test('the business page sells the moment, honestly', () => {
  // The rate card was accurate and inert. The story is: a guest asks, NUM
  // answers with three names, you are in the answer or you are not — and the
  // proof is a counter the merchant can audit. Every claim on the page must
  // stay true to the running system: the conversation shown is one NUM
  // actually produced, the impressions rule (card/named only) matches
  // impressions.mjs, and nothing promises placement money can buy.
  const biz = readFileSync(join(HERE, '..', 'public', 'business', 'index.html'), 'utf8');
  assert.match(biz, /NUM will answer with three names/, 'the hero lost the moment — back to the rate card');
  assert.match(biz, /my group wants somewhere lively for dinner in kata/, 'the real conversation is gone — the page tells instead of showing');
  assert.match(biz, /somebody else&#039;s is|somebody else's is/, 'the turn — the reason to care — is gone');
  assert.match(biz, /survives the audit/, 'the honest-counter promise is gone; the differentiator with proof became a claim without it');
  assert.match(biz, /passed over is not counted/i, 'the impressions rule on the page no longer matches what impressions.mjs actually records');
  assert.ok(!/pay to rank|boost your position|top of the list/i.test(biz), 'the page implies placement can be bought — the one promise that must never appear');
});

test('the beaches page is citable — by engines and by answer machines', () => {
  // GEO in practice: an AI engine cites the page that answers the question
  // directly, in the language of the question, with structure it can parse.
  // This page exists because the directory now genuinely holds every named
  // beach on Phuket — the content is the database, not copywriting.
  const pg = readFileSync(join(HERE, '..', 'public', 'phuket', 'beaches', 'index.html'), 'utf8');
  const ld = JSON.parse(/application\/ld\+json">([\s\S]*?)<\/script>/.exec(pg)[1]);
  const list = ld['@graph'].find((g) => g['@type'] === 'ItemList');
  assert.ok(list.numberOfItems >= 45, 'the beach list shrank — check the nature extract');
  assert.ok(pg.includes('Karon Beach') && pg.includes('หาดกะรน'),
    'the bilingual names are gone — English engines or Thai searchers lose the page');
  assert.ok(ld['@graph'].some((g) => g['@type'] === 'FAQPage'), 'the FAQ schema is gone — the direct answers AI engines lift are unstructured');
  assert.match(pg, /red flag/i, 'the monsoon safety warning is gone — the one line on this page that protects someone');
  const sitemap = readFileSync(join(HERE, '..', 'public', 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes('phuket/beaches'), 'the page is not in the sitemap — invisible to every engine');
  const llms = readFileSync(join(HERE, '..', 'public', 'llms.txt'), 'utf8');
  assert.ok(llms.includes('app.itsnum.com'), 'llms.txt still tells AI engines the product is LINE-only');
});
