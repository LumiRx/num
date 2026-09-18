// Does every door on TODAY actually lead somewhere?
//
// The grid shipped in 0.8.343. A tile that opens a page that composes an ask
// NUM cannot answer is worse than no tile: it promises and then apologises.
// So this takes the REAL compose() from src/lib/features.ts, fills it with the
// values a guest would type, and asks production — with X-Num-Probe: 1, so the
// asks and usage tables stay clean (see the note in worker/index.mjs).
//
//   node scripts/featureaudit.mjs            → all of them, four at a time
//   node scripts/featureaudit.mjs charter    → just one
//
// It judges nothing. It prints what came back so a person can.
import { registerHooks } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
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

// features.ts imports the store, which expects a browser.
globalThis.window = globalThis;
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
globalThis.location = { search: '', pathname: '/', href: 'https://app.itsnum.com/', protocol: 'https:', hostname: 'app.itsnum.com', origin: 'https://app.itsnum.com' };
globalThis.history = { replaceState() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {}, dataset: {} }, documentElement: { style: { setProperty() {} } } };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true }, configurable: true }); } catch { /* fine */ }

const { FEATURES } = await import('../src/lib/features.ts');

const API = process.env.NUM_API ?? 'https://app.itsnum.com/api/num';
const PLACE = 'Bangkok';

/** What a guest would actually type into each page. */
const INPUT = {
  flights: { from: 'BKK', to: 'NRT', date: '2026-10-03', ret: '' },
  stays: { where: 'Sukhumvit, Bangkok', checkin: '2026-10-03', nights: '3' },
  tables: { what: 'quiet, Thai, near the river', when: 'tomorrow 8pm', people: '2' },
  tonight: {},
  events: { when: 'this weekend', what: 'live music' },
  charter: { route: 'Bangkok → Phuket', when: 'Saturday 10am', people: '4' },
  rides: { to: 'Suvarnabhumi Airport', when: '6:30am tomorrow' },
  pickup: { what: 'two iced lattes and a croissant', from: '', when: '20 minutes' },
  hire: { what: 'collect a package from the post office on Sathorn', where: 'Sathorn, Bangkok', when: 'before 5pm today' },
  wellness: { where: 'Sukhumvit', when: 'this afternoon', notes: 'deep tissue, 90 minutes' },
};

const only = process.argv[2];
const todo = FEATURES.filter((f) => f.compose && (!only || f.id === only));
const LANES = Object.fromEntries(FEATURES.map((f) => [f.id, f.lanes?.[0]?.id ?? null]));

async function askOne(f) {
  const values = INPUT[f.id] ?? {};
  // A cache hit would tell us nothing about whether the ask works, so each run
  // is unique to itself — the same trick the smoke checks use.
  const ask = f.compose(values, LANES[f.id]) + ` (audit ${Date.now()}${Math.random().toString(36).slice(2, 6)})`;
  const started = Date.now();
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Num-Probe': '1', 'x-num-debug': '1' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: ask }],
        state: { onboarded: true, anon: 'audit-claude' },
        place: PLACE,
        lang: 'en',
      }),
    });
    const body = await res.json().catch(() => ({}));
    return {
      id: f.id, ok: res.ok, status: res.status, ms: Date.now() - started,
      ask,
      reply: body.reply ?? null,
      picks: (body.picks ?? []).map((p) => p.name),
      actions: (body.actions ?? []).map((a) => a.type),
      chips: (body.chips ?? []).map((c) => c.label),
      card: body.card?.title ?? null,
      lane: body.turn?.lane ?? body._timing?.lane ?? null,
      brain: body.turn?.brain ?? null,
      degraded: !!body.degraded,
    };
  } catch (e) {
    return { id: f.id, ok: false, ms: Date.now() - started, ask, error: String(e?.message ?? e) };
  }
}

/** One at a time, five seconds apart. Four at once earned a 429 from our own
 *  rate limiter, and two at once still did — a throttled door reads exactly
 *  like a broken one until you look at the status code, so the audit stays
 *  slower than the limiter rather than teaching you to ignore its failures. */
async function pool(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
    process.stderr.write(`  …${Math.min(i + size, items.length)}/${items.length}\n`);
    if (i + size < items.length) await new Promise((r) => setTimeout(r, 5000));
  }
  return out;
}

const results = await pool(todo, 1, askOne);

for (const r of results) {
  console.log(`\n═══ ${r.id.toUpperCase()}  ${r.ok ? 'HTTP ' + r.status : 'FAILED'}  ${(r.ms / 1000).toFixed(1)}s  lane=${r.lane ?? '—'} brain=${r.brain ?? '—'}${r.degraded ? ' DEGRADED' : ''}`);
  console.log(`ask:   ${r.ask.replace(/ \(audit [^)]+\)$/, '')}`);
  console.log(`reply: ${(r.reply ?? r.error ?? '(nothing)').replace(/\s+/g, ' ')}`);
  if (r.card) console.log(`card:  ${r.card}`);
  if (r.picks?.length) console.log(`picks: ${r.picks.join(' · ')}`);
  if (r.actions?.length) console.log(`acts:  ${r.actions.join(' · ')}`);
  if (r.chips?.length) console.log(`chips: ${r.chips.join(' · ')}`);
}

writeFileSync('/tmp/num-feature-audit.json', JSON.stringify(results, null, 2) + '\n');
// A 429 is our own rate limiter, not a broken door — say so rather than
// listing it beside a real failure.
const throttled = results.filter((r) => r.status === 429);
const bad = results.filter((r) => r.status !== 429 && (!r.ok || !r.reply || r.degraded));
if (throttled.length) console.log(`(${throttled.map((t) => t.id).join(', ')} hit our own rate limit — rerun those alone)`);
console.log(`\n── ${results.length} asked, ${bad.length} to look at${bad.length ? ': ' + bad.map((b) => b.id).join(', ') : ''}`);
console.log('full JSON: /tmp/num-feature-audit.json');
