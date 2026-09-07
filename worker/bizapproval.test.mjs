import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pendingClaims, decideClaim, autoApproveAll, dueRound, staleDigest, REMINDER_HOURS,
} from './bizapproval.mjs';
import { onboardingEmail, sendOnboarding, consoleLink, onboardApproved } from './bizonboard.mjs';

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
    if (/UPDATE num_claim_decisions\s+SET onboarded/.test(q)) {
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

/** Approved claims that nobody has been told about yet. */
function onboardDb(rows, alerts = new Set()) {
  return {
    prepare: (sql) => ({
      bind: (...a) => ({
        all: async () => ({ results: /FROM claims c/.test(sql) ? rows.filter((r) => !r.onboarded) : [] }),
        first: async () => (/SELECT onboarded/.test(sql)
          ? rows.find((r) => String(r.id) === String(a[0])) ?? null
          : null),
        run: async () => {
          if (/SET onboarded = 1/.test(sql)) {
            const r = rows.find((x) => String(x.id) === String(a[0]));
            if (r) r.onboarded = 1;
          }
          if (/INSERT OR IGNORE INTO num_onboard_alerts/.test(sql)) {
            const fresh = !alerts.has(a[0]);
            alerts.add(a[0]);
            return { meta: { changes: fresh ? 1 : 0 } };
          }
          return { meta: { changes: 1 } };
        },
      }),
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => {
        if (/DELETE FROM num_onboard_alerts/.test(sql)) alerts.clear();
        return { meta: { changes: 1 } };
      },
    }),
  };
}

test('approving is not telling — the sweep emails everyone nobody told', async () => {
  const rows = [
    { id: 13, business_name: 'Holiday Inn Express', email: 'reception@hie.co.uk', created_at: '2026-08-24 16:32:33', onboarded: 0 },
    { id: 15, business_name: 'Fingal Hotel', email: 'reservations@fingal.co.uk', created_at: '2026-08-29 14:44:29', onboarded: 0 },
  ];
  const sent = [];
  const out = await onboardApproved(
    { DB: onboardDb(rows), BIZ_ONBOARD_EMAIL: 'on' },
    { mailer: async (_e, m) => { sent.push(m.to); return { ok: true }; } },
  );
  assert.equal(out.sent, 2);
  assert.equal(out.failed, 0);
  assert.deepEqual(sent, ['reception@hie.co.uk', 'reservations@fingal.co.uk']);
});

test('the sweep stays shut while the flag is off', async () => {
  // Nothing emails a real business until that switch is thrown, by hand.
  const out = await onboardApproved({ DB: onboardDb([]), BIZ_ONBOARD_EMAIL: undefined });
  assert.equal(out.sent, 0);
  assert.match(out.skipped, /BIZ_ONBOARD_EMAIL/);
});

test('a business is told once, not once per tick', async () => {
  const rows = [{ id: 13, business_name: 'X', email: 'x@y.com', created_at: '2026-08-24 16:32:33', onboarded: 0 }];
  const env = { DB: onboardDb(rows), BIZ_ONBOARD_EMAIL: 'on' };
  const mailer = async () => ({ ok: true });
  assert.equal((await onboardApproved(env, { mailer })).sent, 1);
  assert.equal((await onboardApproved(env, { mailer })).sent, 0, 'the second tick must be silent');
});

test('a send that fails is retried next tick, and reported now', async () => {
  // onboarded is set only on a send that actually succeeded, so a mailer that
  // is down delays the news instead of losing it.
  const rows = [{ id: 13, business_name: 'Holiday Inn Express', email: 'x@y.com', created_at: '2026-08-24 16:32:33', onboarded: 0 }];
  const env = { DB: onboardDb(rows), BIZ_ONBOARD_EMAIL: 'on' };
  const down = await onboardApproved(env, { mailer: async () => ({ ok: false, error: 'destination not verified' }) });
  assert.equal(down.sent, 0);
  assert.equal(down.failed, 1);
  assert.match(down.errors[0], /Holiday Inn Express: destination not verified/);
  const up = await onboardApproved(env, { mailer: async () => ({ ok: true }) });
  assert.equal(up.sent, 1, 'the news is delayed, never lost');
});

test('the onboarding email never quotes a hand-written coverage number', () => {
  // It said "2.5 million" while the directory held 2,686,795 — the same drift
  // aifacts.mjs exists to stop, in the one email a business reads carefully.
  // Comments stripped first: the note explaining why this guard exists says
  // "2.5 million" itself, and a guard that trips on its own rationale is a
  // guard somebody deletes.
  const src = readFileSync(join(HERE, 'bizonboard.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/2\.5 million/.test(src), 'no literal coverage number in the template');
  assert.ok(!/2\.5 ล้าน/.test(src), 'nor in the Thai copy');
  const live = onboardingEmail({ business: 'X', contact: 'A', places: 2686795 });
  assert.match(live.text, /2,686,795 real places/);
  const unknown = onboardingEmail({ business: 'X', contact: 'A', places: null });
  assert.ok(!/\d,\d{3},\d{3}/.test(unknown.text), 'an unknown count states no number at all');
});

test('the email never prints an address that rejects mail', () => {
  // "Reply to this email and a person will read it" printed above
  // info@itsnum.com, whose MX rejects at the SMTP layer.
  const routed = onboardingEmail({ business: 'X', contact: 'A', contactAddress: 'info@thatislumi.com' });
  assert.match(routed.text, /NUM · info@thatislumi\.com/);
  assert.ok(!routed.text.includes('info@itsnum.com'));
  const thai = onboardingEmail({ business: 'X', contact: 'A', country: 'TH', contactAddress: 'info@thatislumi.com' });
  assert.match(thai.text, /NUM · info@thatislumi\.com/);
});

test('the same failure is reported once, not every five minutes', async () => {
  // alert() fans out to webhook, SMS and email with no throttle of its own,
  // and this sweep runs on the five-minute cron: 288 identical alerts a day
  // across three channels is an alert nobody reads.
  const rows = [{ id: 13, business_name: 'Holiday Inn Express', email: 'x@y.com', created_at: '2026-08-24 16:32:33', onboarded: 0 }];
  const env = { DB: onboardDb(rows), BIZ_ONBOARD_EMAIL: 'on' };
  const down = async () => ({ ok: false, error: 'destination not verified' });
  const first = await onboardApproved(env, { mailer: down });
  assert.equal(first.failed, 1);
  assert.ok(!first.repeated, 'the first report is news');
  const second = await onboardApproved(env, { mailer: down });
  assert.equal(second.failed, 1);
  assert.equal(second.repeated, true, 'the second tick must stay quiet');
});

test('a changed failure is news again', async () => {
  const rows = [{ id: 13, business_name: 'Holiday Inn Express', email: 'x@y.com', created_at: '2026-08-24 16:32:33', onboarded: 0 }];
  const env = { DB: onboardDb(rows), BIZ_ONBOARD_EMAIL: 'on' };
  await onboardApproved(env, { mailer: async () => ({ ok: false, error: 'destination not verified' }) });
  const changed = await onboardApproved(env, { mailer: async () => ({ ok: false, error: 'resend 401 invalid' }) });
  assert.ok(!changed.repeated, 'a different reason is a different alert');
});

test('a success clears the slate so the next outage is heard', async () => {
  const rows = [
    { id: 13, business_name: 'A', email: 'a@y.com', created_at: '2026-08-24 16:32:33', onboarded: 0 },
    { id: 15, business_name: 'B', email: 'b@y.com', created_at: '2026-08-29 14:44:29', onboarded: 0 },
  ];
  const env = { DB: onboardDb(rows), BIZ_ONBOARD_EMAIL: 'on' };
  let up = false;
  const mailer = async (_e, m) => (up && m.to === 'a@y.com' ? { ok: true } : { ok: false, error: 'destination not verified' });
  await onboardApproved(env, { mailer });
  up = true;
  const mixed = await onboardApproved(env, { mailer });
  assert.equal(mixed.sent, 1);
  assert.equal(mixed.failed, 1);
  assert.ok(!mixed.repeated, 'a tick that delivered something reports what still failed');
});
