// Reading a figure off a photograph of a bill. These tests are mostly about
// what the reader is NOT allowed to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  parseRead, buildPrompt, readBillPhoto, proposeFromPhoto, confirmProposal,
  readerScore, photoReady, photoNeeds, MIN_CONFIDENCE, MAX_B64,
} from './billphoto.mjs';

const ENV = { ANTHROPIC_API_KEY: 'sk-ant-test' };
const IMG = { data: btoa('not-really-a-jpeg'), mediaType: 'image/jpeg' };

function db({ country = 'TH' } = {}) {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_business_profiles (business_id TEXT PRIMARY KEY, country TEXT);
    CREATE TABLE num_bill_proposals (id TEXT PRIMARY KEY, business_id TEXT, resource_id TEXT,
      booking_id TEXT, amount_minor INTEGER, currency TEXT, confidence REAL, note TEXT, raw TEXT,
      image_sha TEXT, state TEXT DEFAULT 'proposed', confirmed_minor INTEGER, corrected INTEGER DEFAULT 0,
      token TEXT, created_by TEXT, confirmed_by TEXT, created_at TEXT DEFAULT (datetime('now')), confirmed_at TEXT);
    INSERT INTO num_business_profiles VALUES ('b1','${country}');
  `);
  const DB = {
    prepare(sql) {
      const b = [];
      const api = {
        bind(...a) { b.push(...a); return api; },
        async first() { return d.prepare(sql).get(...b) ?? null; },
        async all() { return { results: d.prepare(sql).all(...b) }; },
        async run() { const r = d.prepare(sql).run(...b); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
  };
  return { d, env: { ...ENV, DB } };
}

const answers = (text) => async () => new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });

test('a read the model is not sure about is refused, not shown', () => {
  const sure = parseRead('{"amount":"2400.00","confidence":0.95,"legible":true}', { currency: 'THB' });
  assert.equal(sure.ok, true);
  assert.equal(sure.amount_minor, 240000);

  const shaky = parseRead(`{"amount":"2400.00","confidence":${MIN_CONFIDENCE - 0.01},"legible":true}`, { currency: 'THB' });
  assert.equal(shaky.ok, false, 'staff typing four digits beats a number nobody should trust');
  assert.equal(shaky.low, true);
  assert.match(shaky.reason, /type it instead/);

  assert.equal(parseRead('{"legible":false,"note":"the photo is blurred","confidence":0.2}').ok, false);
  assert.match(parseRead('{"legible":false,"note":"the photo is blurred"}').reason, /blurred/);
  assert.equal(parseRead('not json at all').ok, false);
  assert.equal(parseRead('{"amount":"2,4OO","confidence":0.99,"legible":true}').ok, false, 'the strict parser still applies');
  assert.equal(parseRead('{"amount":"0","confidence":0.99,"legible":true}').ok, false);
});

test('the prompt asks for the amount DUE and forbids the model inventing anything', () => {
  const p = buildPrompt('THB');
  assert.match(p, /TOTAL AMOUNT THE GUEST MUST PAY, in THB/);
  assert.match(p, /amount STILL DUE/, 'a deposit already paid must not be billed twice');
  assert.match(p, /Do not add anything/);
  assert.match(p, /Do not apply a tip/);
  assert.match(p, /Do not convert a currency/);
  assert.match(p, /say so instead of guessing/);
});

test('the currency is the VENUE\'s — a model must never be able to turn baht into dollars', async () => {
  const { env } = db({ country: 'TH' });
  let seen = null;
  const fetchImpl = async (_u, init) => {
    seen = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"amount":"2400.00","confidence":0.95,"legible":true}' }] }), { status: 200 });
  };
  const out = await proposeFromPhoto(env, { businessId: 'b1', ...IMG }, { fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.currency, 'THB');
  const promptText = seen.messages[0].content.find((c) => c.type === 'text').text;
  assert.match(promptText, /in THB/);

  const us = db({ country: 'US' });
  const out2 = await proposeFromPhoto(us.env, { businessId: 'b1', ...IMG }, { fetchImpl });
  assert.equal(out2.currency, 'USD');
});

test('nothing is minted by reading a photo — a proposal is filed and staff are told to check it', async () => {
  const { d, env } = db();
  const out = await proposeFromPhoto(env, { businessId: 'b1', resourceId: 'r7', ...IMG },
    { fetchImpl: answers('{"amount":"2400.00","confidence":0.9,"legible":true}') });
  assert.equal(out.ok, true);
  assert.equal(out.amount, '2400.00');
  assert.match(out.confirm, /you are the one who is sure/);
  const row = d.prepare('SELECT * FROM num_bill_proposals').get();
  assert.equal(row.state, 'proposed', 'proposed — never minted');
  assert.equal(row.amount_minor, 240000);
  assert.equal(row.token, null, 'no bill code exists until a human says yes');
});

test('the photograph is never stored — only what the reader said about it', async () => {
  const { d, env } = db();
  await proposeFromPhoto(env, { businessId: 'b1', ...IMG },
    { fetchImpl: answers('{"amount":"2400.00","confidence":0.9,"legible":true}') });
  const row = d.prepare('SELECT * FROM num_bill_proposals').get();
  const stored = JSON.stringify(row);
  assert.ok(!stored.includes(IMG.data), 'a bill can carry a guest name or a card\'s last four');
  assert.ok(row.image_sha && row.image_sha.length === 64, 'but the read stays provable');
  assert.match(row.raw, /2400/);
});

test('an unreadable photo is filed as unreadable, and confirming it is still possible by typing', async () => {
  const { d, env } = db();
  const out = await proposeFromPhoto(env, { businessId: 'b1', ...IMG },
    { fetchImpl: answers('{"legible":false,"note":"glare across the total","confidence":0.1}') });
  assert.equal(out.ok, false);
  assert.match(out.reason, /glare/);
  assert.equal(d.prepare('SELECT state FROM num_bill_proposals').get().state, 'unreadable');

  // Staff can still put the figure on it by hand — the photo path never blocks the old one.
  const minted = [];
  const done = await confirmProposal(env, 'b1', out.id, {
    amount: '2400', by: 'staff@venue',
    mint: async (a) => { minted.push(a); return { ok: true, token: 'TOK1', url: 'https://itsnum.com/p/TOK1' }; },
  });
  assert.equal(done.ok, true);
  assert.equal(done.token, 'TOK1');
  assert.equal(minted[0].amount, '2400.00');
  assert.equal(minted[0].currency, 'THB');
});

test('staff win over the model, and a correction is recorded', async () => {
  const { d, env } = db();
  const out = await proposeFromPhoto(env, { businessId: 'b1', ...IMG },
    { fetchImpl: answers('{"amount":"240.00","confidence":0.88,"legible":true}') });
  assert.equal(out.amount_minor, 24000);
  // The model dropped a zero. Staff are holding the paper.
  const done = await confirmProposal(env, 'b1', out.id, {
    amount: '2400', by: 'staff',
    mint: async () => ({ ok: true, token: 'TOK2', url: 'u' }),
  });
  assert.equal(done.ok, true);
  assert.equal(done.corrected, true);
  const row = d.prepare('SELECT confirmed_minor, corrected, state, token FROM num_bill_proposals').get();
  assert.equal(row.confirmed_minor, 240000, 'the human\'s number is the one that ships');
  assert.equal(row.corrected, 1);
  assert.equal(row.state, 'confirmed');
  assert.equal(row.token, 'TOK2');
});

test('a proposal cannot be confirmed twice, or across venues', async () => {
  const { env } = db();
  const out = await proposeFromPhoto(env, { businessId: 'b1', ...IMG },
    { fetchImpl: answers('{"amount":"100.00","confidence":0.9,"legible":true}') });
  const mint = async () => ({ ok: true, token: 'T', url: 'u' });
  assert.equal((await confirmProposal(env, 'b1', out.id, { mint })).ok, true);
  assert.match((await confirmProposal(env, 'b1', out.id, { mint })).reason, /already been made/);
  assert.match((await confirmProposal(env, 'b2', out.id, { mint })).reason, /no such proposal/);
});

test('a refused mint leaves the proposal unconfirmed rather than claiming a bill exists', async () => {
  const { d, env } = db();
  const out = await proposeFromPhoto(env, { businessId: 'b1', ...IMG },
    { fetchImpl: answers('{"amount":"100.00","confidence":0.9,"legible":true}') });
  const done = await confirmProposal(env, 'b1', out.id, {
    mint: async () => ({ ok: false, reason: 'this venue has no active payment code to inherit from' }),
  });
  assert.equal(done.ok, false);
  assert.match(done.reason, /no active payment code/);
  assert.equal(d.prepare('SELECT state FROM num_bill_proposals').get().state, 'proposed');
});

test('bad input and an unreachable reader both refuse in words staff can act on', async () => {
  assert.match((await readBillPhoto(ENV, { data: 'x', mediaType: 'application/pdf' })).reason, /not a photo/);
  assert.match((await readBillPhoto(ENV, { data: 'x'.repeat(MAX_B64 + 1), mediaType: 'image/jpeg' })).reason, /too large/);
  assert.match((await readBillPhoto({}, IMG)).reason, /not switched on/);
  assert.deepEqual(photoNeeds({}), ['ANTHROPIC_API_KEY']);
  assert.equal(photoReady(ENV), true);
  const dead = await readBillPhoto(ENV, IMG, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.match(dead.reason, /type the amount instead/);
  const five = await readBillPhoto(ENV, IMG, { fetchImpl: async () => new Response('nope', { status: 500 }) });
  assert.match(five.reason, /type the amount instead/);
});

test('the reader is scored against itself, whether or not anybody asks', async () => {
  const { d, env } = db();
  d.exec(`INSERT INTO num_bill_proposals (id,business_id,currency,state,corrected) VALUES
    ('p1','b1','THB','confirmed',0), ('p2','b1','THB','confirmed',1),
    ('p3','b1','THB','unreadable',0), ('p4','b1','THB','proposed',0);`);
  assert.deepEqual(await readerScore(env, 'b1'), { proposals: 4, unreadable: 1, confirmed: 2, corrected: 1 });
});

// ── the console wiring ────────────────────────────────────────────────────
// The module can be as careful as it likes; what matters is what the screen
// actually does with it. These read growth/worker.js the way
// growth/billreceipt.test.mjs does.
import { readFileSync } from 'node:fs';
const CONSOLE = readFileSync(new URL('../growth/worker.js', import.meta.url), 'utf8');

test('the photo route exists, needs the bill permission, and is separate from minting', () => {
  assert.match(CONSOLE, /p === "\/api\/venue\/bill\/photo" && req\.method === "POST"/);
  assert.match(CONSOLE, /p === "\/api\/venue\/bill\/photo\/confirm" && req\.method === "POST"/);
  const fn = CONSOLE.slice(CONSOLE.indexOf('async function qrBillPhoto('), CONSOLE.indexOf('async function qrBillPhotoConfirm('));
  assert.match(fn, /QR\.can\(who\.role, "bill"\)/, 'a waiter may put an amount on a table; this is that');
  assert.match(fn, /BILLPHOTO\.proposeFromPhoto/);
  assert.ok(!/mintBillCode|billForTable/.test(fn), 'reading a photo must not mint anything');
});

test('the browser fills the amount box and never posts a bill by itself', () => {
  const ui = CONSOLE.slice(CONSOLE.indexOf("document.getElementById('bphoto').onchange"),
                           CONSOLE.indexOf("document.getElementById('bill').onclick"));
  assert.match(ui, /\/api\/venue\/bill\/photo/);
  assert.ok(!/post\('\/api\/venue\/bill',/.test(ui), 'the photo handler must not make the code — the human presses that button');
  assert.match(ui, /getElementById\('ba'\)\.value=j\.amount/, 'it fills the box staff already read from');
  assert.match(ui, /Type the amount instead/, 'a failed read has to leave staff where they already were');
  assert.match(ui, /shrink\(f\)/, 'a 5MB photo over restaurant wifi is a member of staff going back to typing');
});
