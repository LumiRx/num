// The paperwork desk.
//
// Two things are worth a test here and they are not the layout.
//
// ONE: every route is shut to a non-admin. This page lists real names and
// emails and streams a document with somebody's SSN on it.
//
// TWO: the form is streamed, never linked. receiveW9 deliberately keeps the
// object key out of reach and says so in a comment; a page that leaks the key,
// redirects to storage, or lets the uploaded content-type through would undo
// that quietly.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { queue, serveW9, deskShell, handleDesk } from './expertdesk.mjs';

const KEY = 'expert-tax/sc_1/2f9c-not-guessable';

function makeEnv({ admin = false, object = true } = {}) {
  const rows = [{
    id: 'sc_1', name: 'Isaiah Farmer', code: 'FARMER', email: 'z@num.test', country: 'US',
    created_at: '2026-09-15', nda_state: 'signed', signed_name: 'Isaiah Farmer',
    signed_at: '2026-09-18T04:38:27Z', nda_reason: null,
    w9_state: 'uploaded', uploaded_at: '2026-09-18T04:47:25Z',
    content_type: 'application/pdf', bytes: 1234, w9_reason: null, introduced: 0,
  }];
  return {
    // ADMIN_KEY present or not is what isAdmin reads first.
    ...(admin ? { ADMIN_KEY: 'k' } : {}),
    PHOTOS: {
      get: async (k) => (object && k === KEY
        ? { body: new Blob(['%PDF-1.4 pretend']).stream() } : null),
    },
    DB: {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => (/object_key/.test(sql)
            ? { object_key: KEY, content_type: 'application/pdf' } : rows[0]),
          all: async () => ({ results: rows }),
        }),
        all: async () => ({ results: rows }),
        first: async () => rows[0],
      }),
    },
  };
}

const req = (path, headers = {}) =>
  new Request(`https://app.itsnum.com/api/expert-docs${path}`, { headers });

describe('reachable by a person, shut to everybody else', () => {
  // The bug this replaces: the shell was admin-gated and the ops console
  // authenticates with a HEADER, not a cookie. A browser navigation sends
  // neither, so every attempt to open the desk was a 403 — a review page
  // nobody could reach. The shell is now public because it holds no data.
  test('the shell opens without a session, because it carries nothing', async () => {
    const res = await handleDesk(req('/desk'), makeEnv({ admin: false }), '/desk');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('Isaiah'), 'and still no name in it');
    assert.ok(!html.includes('z@num.test'), 'and no email');
    assert.ok(!html.includes(KEY), 'and no object key');
  });

  test('the shell sends the header the ops console actually uses', () => {
    const html = deskShell();
    assert.match(html, /sessionStorage\.getItem\('num_ops'\)/,
      'same origin as /ops/, so its session is already here');
    assert.match(html, /X-Admin-Session/,
      'a cookie would not be sent by /ops/ — that was the bug');
  });

  test('with no session it says where to sign in rather than failing blankly', () => {
    assert.match(deskShell(), /Sign in at <a href="\/ops\/">/);
  });

  for (const p of ['/queue', '/file']) {
    test(`${p} refuses a caller with no session`, async () => {
      const res = await handleDesk(req(`${p}?scout=sc_1`), makeEnv({ admin: false }), p);
      assert.equal(res.status, 403);
      const body = await res.text();
      assert.ok(!body.includes('Isaiah'), 'and leaks no name while refusing');
      assert.ok(!body.includes(KEY), 'and no object key');
    });
  }

  test('a worker with no ADMIN_KEY configured is shut, not open', async () => {
    const res = await handleDesk(req('/queue'), makeEnv({ admin: false }), '/queue');
    assert.equal(res.status, 403);
  });
});

describe('the form is streamed, never linked', () => {
  test('the object key never reaches the browser', async () => {
    const html = deskShell();
    assert.ok(!html.includes(KEY), 'the key stays in the worker');
    assert.ok(!html.includes('expert-tax/'), 'not even its namespace');
    assert.match(html, /\/api\/expert-docs\/file\?scout=' \+ encodeURIComponent/,
      'the page asks for a document by scout id, which is not a handle on one');
    assert.match(html, /createObjectURL/,
      'and shows it from a blob that dies with the tab, not a shareable link');
  });

  test('the bytes come back with no-store and an inline disposition', async () => {
    const res = await serveW9(makeEnv({ admin: true }), 'sc_1');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('content-disposition'), /^inline/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  test('an uploaded content-type is re-asserted from the allow-list, not echoed', async () => {
    const env = makeEnv({ admin: true });
    env.DB.prepare = () => ({
      bind: () => ({ first: async () => ({ object_key: KEY, content_type: 'text/html' }) }),
    });
    const res = await serveW9(env, 'sc_1');
    assert.equal(res.headers.get('content-type'), 'application/octet-stream',
      'text/html here would run inside the reviewer’s session');
  });

  test('a missing object is a 404, not a blank page that looks reviewed', async () => {
    const res = await serveW9(makeEnv({ admin: true, object: false }), 'sc_1');
    assert.equal(res.status, 404);
  });
});

describe('the queue', () => {
  test('counts only what actually needs a person', async () => {
    const q = await queue(makeEnv({ admin: true }));
    assert.equal(q.waiting, 1, 'one person, signed and uploaded, waiting on review');
  });

  test('the page says money accrues but cannot be paid, rather than implying it is lost', async () => {
    const html = deskShell();
    assert.match(html, /nothing is lost/i);
    assert.match(html, /cannot be PAID|nobody can be PAID/i);
  });

  test('a name with markup in it cannot break out of the page', async () => {
    const env = makeEnv({ admin: true });
    const rows = [{
      id: 'sc_x', name: '<script>alert(1)</script>', code: 'X', email: 'e@t', country: 'US',
      created_at: '', nda_state: 'signed', signed_name: null, signed_at: null, nda_reason: null,
      w9_state: null, introduced: 0,
    }];
    env.DB.prepare = () => ({ bind: () => ({ all: async () => ({ results: rows }) }), all: async () => ({ results: rows }) });
    const html = deskShell();
    assert.ok(!html.includes('<script>alert(1)</script>'), 'escaped, not executed');
  });

  test('rejecting asks for a reason — the page refuses to send one without it', () => {
    const html = deskShell();
    assert.match(html, /if \(!reason\) return;/,
      'a rejection with no reason leaves somebody guessing what to fix');
  });
});
