import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pendingClaims, decideClaim, autoApproveAll, dueRound, staleDigest, REMINDER_HOURS,
} from './bizapproval.mjs';
import { onboardingEmail, sendOnboarding, consoleLink } from './bizonboard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Enough D1 to exercise the real SQL paths. */
function db(claims = []) {
  // Shared by the bound and unbound query paths, so the stub cannot disagree
  // with itself about what a query returns.
  let this_all;
  const decisions = new Map();
  const reminders = new Set();
  const rows = [...claims];
  const run = (q, a) => {
    if (/INSERT OR IGNORE INTO num_claim_decisions/.test(q)) {
      if (decisions.has(a[0])) return { meta: { changes: 0 } };
      decisions.set(a[0], { decision: a[1], by: a[2], onboarded: 0 });
      return { meta: { changes: 1 } };
    }
    if (/UPDATE claims SET state/.test(q)) {
      const r = rows.find((x) => String(x.id) === String(a[0]));
      if (r) { r.state = a[1]; r.decided_by = a[2]; r.decided_at = 'now'; }
      return { meta: { changes: r ? 1 : 0 } };
    }
    if (/INSERT OR IGNORE INTO num_claim_reminders/.test(q)) {
      const k = `${a[0]}:${a[1]}`;
      if (reminders.has(k)) return { meta: { changes: 0 } };
      reminders.add(k); return { meta: { changes: 1 } };
    }
    if (/UPDATE num_claim_decisions SET onboarded/.test(q)) {
      const d = decisions.get(String(a[0])); if (d) d.onboarded = 1; return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  };
  this_all = async (q, a) => {
    if (/FROM claims/.test(q)) {
      let out = rows.filter((r) => r.state === 'new');
      if (/verified_at IS NOT NULL/.test(q)) out = out.filter((r) => r.verified_at);
      return { results: out };
    }
    if (/FROM num_claim_reminders/.test(q)) {
      return { results: [...reminders].filter((k) => k.startsWith(`${a[0]}:`)).map((k) => ({ round: Number(k.split(':')[1]) })) };
    }
    return { results: [] };
  };
  return {
    decisions, reminders, rows,
    DB: {
      prepare(q) {
        return {
          bind: (...a) => ({
            run: async () => run(q, a),
            all: async () => this_all(q, a),
            first: async () => {
              if (/FROM claims/.test(q)) return rows.find((r) => String(r.id) === String(a[0])) ?? null;
              if (/FROM num_claim_decisions/.test(q)) return decisions.get(String(a[0])) ?? null;
              return null;
            },
          }),
          // D1 allows .all() with no .bind() when the SQL has no parameters —
          // autoApproveVerified does exactly that, and a stub that returned
          // nothing there made a passing function look broken.
          run: async () => run(q, []),
          all: async () => this_all(q, []),
          first: async () => null,
        };
      },
    },
  };
}

const claim = (over = {}) => ({
  id: 13, business_name: 'Holiday Inn Express', contact_name: 'Adam',
  phone: '+441315582300', email: 'reception@hieedinburgh.co.uk', country: 'GB',
  state: 'new', verified_at: null, created_at: '2026-08-24 16:32:33', ...over,
});

test('a decision is recorded against a person, not just a state', () => {
  // `decided_by` has been NULL on every row this table has ever held, so
  // "approved by whom" was unanswerable. Both writes must happen.
  const d = db([claim()]);
  return decideClaim(d.DB && { DB: d.DB }, { id: 13, decision: 'approved', by: 'admin:dre' }).then((out) => {
    assert.equal(out.ok, true);
    assert.equal(d.rows[0].state, 'approved');
    assert.equal(d.rows[0].decided_by, 'admin:dre');
    assert.equal(d.decisions.get('13').decision, 'approved');
  });
});

test('deciding twice does not onboard a business twice', async () => {
  const d = db([claim()]);
  const a = await decideClaim({ DB: d.DB }, { id: 13, decision: 'approved', by: 'x' });
  const b = await decideClaim({ DB: d.DB }, { id: 13, decision: 'approved', by: 'x' });
  assert.equal(a.alreadyDecided, false);
  assert.equal(b.alreadyDecided, true, 'a repeat decision would send a second onboarding email');
});

test('an unknown decision is refused', async () => {
  const d = db([claim()]);
  const out = await decideClaim({ DB: d.DB }, { id: 13, decision: 'maybe', by: 'x' });
  assert.equal(out.ok, false);
});

test('EVERY business is approved — the badge is what needs proof', async () => {
  // Approval and verification are different questions. Refusing a dashboard
  // until ownership is proved costs a real business and protects nothing:
  // the dashboard only ever edits that listing's own hours, phone and address.
  const d = db([claim({ id: 1, verified_at: null }), claim({ id: 2, verified_at: '2026-08-24 17:00:00' })]);
  const out = await autoApproveAll({ DB: d.DB });
  assert.equal(out.approved, 2, 'a business was left waiting for a human');
  assert.equal(d.rows.find((r) => r.id === 1).state, 'approved');
  assert.equal(d.rows.find((r) => r.id === 2).state, 'approved');
  // ...but the record still says which of them actually proved anything.
  assert.match(d.decisions.get('1').by, /unverified/);
  assert.match(d.decisions.get('2').by, /:verified/);
});

test('the reminder schedule widens and never repeats a round', () => {
  assert.deepEqual([...REMINDER_HOURS], [...REMINDER_HOURS].sort((a, b) => a - b));
  assert.equal(dueRound(0.5), null, 'a brand-new claim was nagged immediately');
  assert.equal(dueRound(3), 0);
  assert.equal(dueRound(3, [0]), null, 'the same round fired twice');
  assert.equal(dueRound(100), 3, 'an old claim should jump to its highest due round, not crawl');
  assert.equal(dueRound(100, [3]), null,
    'after the highest round fired, lower rounds must NOT fire — that is four texts for one signup');
});

test('an undecided claim is raised again — the fix for a dropped alert', async () => {
  // Fingal Hotel's alert fired once, into the SMS outage, and the per-claim
  // dedupe meant it never came back. This is what makes that survivable.
  const d = db([claim({ created_at: '2026-08-24 16:32:33' })]);
  const now = Date.parse('2026-08-30T00:00:00Z');
  const first = await staleDigest({ DB: d.DB }, { now });
  assert.ok(first, 'a six-day-old undecided signup was not re-raised');
  assert.match(first.text, /STILL WAITING/);
  assert.match(first.text, /Holiday Inn Express/);

  const again = await staleDigest({ DB: d.DB }, { now });
  assert.equal(again, null, 'the same round fired twice in a row — this becomes noise');
});

test('reminders stop the moment somebody decides', async () => {
  const d = db([claim()]);
  await decideClaim({ DB: d.DB }, { id: 13, decision: 'approved', by: 'dre' });
  const out = await staleDigest({ DB: d.DB }, { now: Date.parse('2026-09-30T00:00:00Z') });
  assert.equal(out, null, 'a decided claim is still being chased');
});

test('pendingClaims returns only what is waiting, oldest first', async () => {
  const d = db([claim({ id: 1 }), claim({ id: 2, state: 'approved' })]);
  const out = await pendingClaims({ DB: d.DB });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
});

// ── the email ──────────────────────────────────────────────────────────────

test('the onboarding email promises nothing that is not true today', () => {
  const { subject, text } = onboardingEmail({ business: 'Awafi', contact: 'Manaf', country: 'GB' });
  assert.match(subject, /Awafi/);
  // The booking desk returns 503, num_paylinks is empty, and the site and
  // commission.mjs have disagreed on the fee. None of it may be promised.
  assert.doesNotMatch(text, /\breservation|\bbook (?:a|your|tables)|QR pay|payment link/i,
    'the email promises bookings or pay — neither is live');
  assert.doesNotMatch(text, /\d+\s?%|commission|\bfee\b/i, 'the email quotes a commercial figure');
  assert.doesNotMatch(text, /rank|top of|featured|promote/i, 'the email implies placement can be influenced');
  // And it must say the one thing that protects the product's credibility.
  assert.match(text, /not for sale|cannot change|neither can anyone else/i);
  assert.match(text, /app\.itsnum\.com\/api\/biz\/console/);
});

test('a Thai business is written to in Thai', () => {
  const { text } = onboardingEmail({ business: 'ร้านอาหาร', contact: 'Somchai', country: 'TH' });
  assert.match(text, /[฀-๿]/, 'a TH claim got English');
});

test('the onboarding email is sent once, and only after a successful send', async () => {
  const d = db([claim()]);
  await decideClaim({ DB: d.DB }, { id: 13, decision: 'approved', by: 'dre' });

  let sends = 0;
  const failing = async () => { sends += 1; return { ok: false, error: 'resend down' }; };
  await sendOnboarding({ DB: d.DB }, claim(), { mailer: failing });
  assert.equal(d.decisions.get('13').onboarded, 0,
    'a FAILED send was recorded as delivered — this is how Fingal was lost');

  const ok = async () => { sends += 1; return { ok: true, via: 'test' }; };
  await sendOnboarding({ DB: d.DB }, claim(), { mailer: ok });
  assert.equal(d.decisions.get('13').onboarded, 1);

  await sendOnboarding({ DB: d.DB }, claim(), { mailer: ok });
  assert.equal(sends, 2, 'a third send was attempted after onboarding was recorded');
});

test('no email can reach a real business until the switch is thrown', () => {
  // Dre asked to read the wording before anything goes to a hotel. The send is
  // behind an explicit secret that is UNSET in production, so approving a claim
  // today files the decision and mails nobody.
  const idx = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(idx, /env\.BIZ_ONBOARD_EMAIL === 'on'/,
    'the onboarding email is no longer behind an explicit opt-in switch');
});

test('a business that waited is told so, and one that did not is not', () => {
  // Six businesses signed up between 9 and 29 Aug and heard nothing. Writing
  // three weeks later as though they filled the form this morning is the kind
  // of small dishonesty an owner notices.
  const late = onboardingEmail({ business: 'Morrisons Lounge', contact: 'Edward', country: 'GB', waitedDays: 21 });
  assert.match(late.text, /Sorry it took us 21 days/);
  const fresh = onboardingEmail({ business: 'New Place', contact: 'Sam', country: 'GB', waitedDays: 0 });
  assert.doesNotMatch(fresh.text, /Sorry it took/, 'a same-day signup was apologised to for nothing');
  // 3 days is the threshold — a two-day wait needs no apology.
  assert.doesNotMatch(onboardingEmail({ business: 'X', waitedDays: 2 }).text, /Sorry it took/);
});

test('the console link prefills their name and carries no credential', () => {
  const { text } = onboardingEmail({ business: "Giuliano's", contact: 'Angelo', country: 'GB' });
  assert.match(text, /api\/biz\/console\?q=Giuliano/, 'the owner lands on a blank search box');
  // A link that authorised anything would be a credential in an inbox, in a
  // forward, and in every referrer the page leaks.
  assert.doesNotMatch(text, /[?&]s=|key=|token=/, 'the email carries a session or key in a URL');
});

test('a claims table without decided_at is migrated, not silently failed against', async () => {
  // Production's `claims` had neither decided_at nor decided_by. Three code
  // paths write both. Every one of them threw into a .catch(() => {}), so the
  // ledger filled while claims.state never moved — eight businesses sat
  // approved-and-pending at once, invisible from both ends.
  const stmts = [];
  const prep = (sql) => {
    stmts.push(sql);
    const api = {
      run: async () => ({ meta: { changes: 1 } }),
      first: async () => ({ id: '13', business_name: 'Holiday Inn Express', state: 'new' }),
      all: async () => ({ results: [] }),
    };
    return { ...api, bind: () => api };
  };
  const env = { DB: { prepare: prep } };
  await decideClaim(env, { id: '13', decision: 'approved', by: 'test' });
  const alters = stmts.filter((s) => /ALTER TABLE claims ADD COLUMN/.test(s));
  assert.equal(alters.length, 2, 'both columns must be added before any decision is written');
  assert.ok(alters.some((s) => s.includes('decided_at')));
  assert.ok(alters.some((s) => s.includes('decided_by')));
});

test('a state update that fails is reported, never swallowed', async () => {
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: () => ({
          run: async () => {
            if (/UPDATE claims SET state/.test(sql)) throw new Error('no such column: decided_at');
            return { meta: { changes: 1 } };
          },
          first: async () => ({ id: '13', business_name: 'Holiday Inn Express', state: 'new' }),
          all: async () => ({ results: [] }),
        }),
        run: async () => ({ meta: { changes: 1 } }),
        first: async () => ({ id: '13', business_name: 'Holiday Inn Express', state: 'new' }),
        all: async () => ({ results: [] }),
      }),
    },
  };
  const out = await decideClaim(env, { id: '13', decision: 'approved', by: 'test' });
  assert.equal(out.ok, false, 'a decision the console cannot see is not a decision');
  assert.match(out.error, /state not moved/);
  assert.match(out.error, /decided_at/);
});
