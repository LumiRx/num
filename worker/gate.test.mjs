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
