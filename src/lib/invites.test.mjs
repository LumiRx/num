// INVITES on PLAN (19 Sep 2026): every "someone wants you somewhere" in one
// rail with one answer set, folded past three, mutable per source; and the
// day by the hour with who it's with (lib/agenda.ts).
// Run: node --test src/lib/invites.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(spec)) {
      const base = ctx.parentURL ? dirname(fileURLToPath(ctx.parentURL)) : process.cwd();
      for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
        const p = resolvePath(base, spec + ext);
        if (existsSync(p)) return next(pathToFileURL(p).href, ctx);
      }
    }
    return next(spec, ctx);
  },
});
globalThis.window = globalThis;
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
globalThis.location = { search: '', pathname: '/', href: 'https://app.itsnum.com/', protocol: 'https:', hostname: 'app.itsnum.com', origin: 'https://app.itsnum.com' };
globalThis.history = { replaceState() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {}, dataset: {} }, documentElement: { style: { setProperty() {} } } };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true }, configurable: true }); } catch { /* fine */ }

let cardsOf, muteKeyOf, FOLD_AT, agendaWindow, selKey, withLine;
before(async () => {
  ({ cardsOf, muteKeyOf, FOLD_AT } = await import('./invites.ts'));
  ({ agendaWindow, selKey, withLine } = await import('./agenda.ts'));
});

const inbox = {
  connects: [{ id: 'lnk_1', a_id: 'mem_sam', plan_id: 'pl_1', from_name: 'Sam', from_avatar: null, plan_title: 'Lisbon weekend', created_at: 't' }],
  events: [{ token: 'tok_1', event_id: 'ev_1', title: 'Viv’s birthday', day: '2026-10-03', time: '20:00', place: 'Pensão Amor', host_name: 'Viv', via: 'agent' }],
  plans: [
    { id: 'pl_2', title: 'Porto day', dest: null, members: 3, open_items: 1, latest: 'Sam added Francesinha.', my_vote: null, my_role: 'member', owner_name: 'Sam', starts_on: '2026-10-05' },
    { id: 'pl_3', title: 'My own', dest: null, members: 1, open_items: 0, latest: null, my_vote: null, my_role: 'owner', owner_name: 'Dre', starts_on: null },
    { id: 'pl_4', title: 'Answered', dest: null, members: 2, open_items: 0, latest: 'Viv moved dinner.', my_vote: 'in', my_role: 'member', owner_name: 'Viv', starts_on: null },
  ],
};

test('one rail, three sources: a friend’s plan, an event, a plan that needs your answer', () => {
  const cards = cardsOf(inbox, [], { newsToo: false });
  assert.deepEqual(cards.map((c) => [c.kind, c.id]), [['connect', 'lnk_1'], ['event', 'tok_1'], ['plan', 'pl_2']]);
  assert.match(cards[0].title, /Sam invited you to “Lisbon weekend”/);
  assert.match(cards[2].title, /Porto day — are you in\?/);
  assert.equal(cards[2].needsVote, true);
});

test('the owner is never asked whether they are in; on TODAY a plan with news still shows', () => {
  const plan = cardsOf(inbox, [], { newsToo: false });
  assert.ok(!plan.some((c) => c.id === 'pl_3'), 'my own plan asks me nothing');
  assert.ok(!plan.some((c) => c.id === 'pl_4'), 'on PLAN an answered plan with news is not a card — it is a tab');
  const today = cardsOf(inbox, [], { newsToo: true });
  assert.ok(today.some((c) => c.id === 'pl_4'), 'on TODAY the news card stays, as it always has');
});

test('mute is by source — this friend, this host, this plan — and hides, never declines', () => {
  assert.equal(muteKeyOf({ kind: 'connect', from: 'mem_sam', id: 'lnk_1' }), 'friend:mem_sam');
  assert.equal(muteKeyOf({ kind: 'event', from: 'Viv', id: 'tok_1' }), 'host:Viv');
  assert.equal(muteKeyOf({ kind: 'plan', id: 'pl_2' }), 'plan:pl_2');
  const cards = cardsOf(inbox, ['friend:mem_sam', 'plan:pl_2'], { newsToo: false });
  assert.deepEqual(cards.map((c) => c.id), ['tok_1']);
  const rail = readFileSync(new URL('../components/app/InviteRail.tsx', import.meta.url), 'utf8');
  assert.match(rail, /const mute = \(key: string\) => store\.set\(/);
  assert.doesNotMatch(rail, /const mute = [^\n]*respond\(/, 'muting never calls respond()');
});

test('the rail folds past three; the PLAN badge counts what the rail shows', () => {
  assert.equal(FOLD_AT, 3);
  const rail = readFileSync(new URL('../components/app/InviteRail.tsx', import.meta.url), 'utf8');
  assert.match(rail, /cards\.length > FOLD_AT \? cards\.slice\(0, FOLD_AT\)/);
  assert.match(rail, /AND \{n\} MORE/);
  const app = readFileSync(new URL('../components/app/ConciergeApp.tsx', import.meta.url), 'utf8');
  assert.match(app, /cardsOf\(s\.inbox, s\.mutedInvites \?\? \[\], \{ newsToo: false \}\)\.length/);
  const plan = readFileSync(new URL('../components/app/PlanView.tsx', import.meta.url), 'utf8');
  assert.match(plan, /<InviteRail variant="plan" \/>/);
  const dash = readFileSync(new URL('../components/app/DashView.tsx', import.meta.url), 'utf8');
  assert.match(dash, /<InviteRail variant="today" \/>/);
});

test('agenda: three weeks around today, selDay keys, and who it’s with', () => {
  const w = agendaWindow(new Date('2026-09-19T12:00:00Z'));
  assert.deepEqual(w, { from: '2026-09-18', to: '2026-10-10' });
  assert.equal(selKey('2026-10-02'), '10-2');
  const people = [
    { member_id: 'me', name: 'Dre', sure: true }, { member_id: 'a', name: 'Sam', sure: true },
    { member_id: 'b', name: 'Viv', sure: false }, { member_id: 'c', name: 'Ana', sure: true }, { member_id: 'd', name: 'Bo', sure: true },
  ];
  assert.equal(withLine(people, 'me'), 'Sam, (Viv), Ana +1', 'I am not listed as being with myself; unsure in brackets; overflow counted');
  assert.equal(withLine([{ member_id: 'me', name: 'Dre', sure: true }], 'me'), '');
});

test('the calendar draws friends’ plans and events with who, once — mirrored bookings are not doubled', () => {
  const derive = readFileSync(new URL('./derive.ts', import.meta.url), 'utf8');
  assert.match(derive, /shadowed\.add\('grp_' \+ i\.id\.slice\(-8\)\)/);
  assert.match(derive, /shadowed\.add\('tbl_' \+ i\.id\.slice\('itm_tbl_'\.length\)\)/);
  assert.match(derive, /!ag\.shadowed\.has\(b\.id\)/);
  assert.match(derive, /who: withLine\(i\.with, meId\)/);
  const sheet = readFileSync(new URL('../components/app/CalendarSheet.tsx', import.meta.url), 'utf8');
  assert.match(sheet, /\{t\('with'\)\} \{e\.who\}/);
  assert.match(sheet, /openPlan\(e\.planId as string\)/, 'a friend’s plan on your day opens that plan');
  assert.match(sheet, /void refreshAgenda\(\)/);
});
