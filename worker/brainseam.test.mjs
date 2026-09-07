// The seam between Num and its vendors, audited.
//
// 11 Aug 2026, before flipping traffic toward the Bionic response brain, Dre
// asked for a security pass on the seam. It found one real leak and two
// blind spots; these tests keep all three closed.
//
//   1. THE LEAK: the structured (Claude) path redacted the guest profile
//      before the model saw it — and the fallback context, the one every
//      OTHER vendor receives, passed the profile raw. The cheaper the brain,
//      the less we know about its operator, and it was the cheap brains
//      getting the unredacted data.
//   2. Cleartext: an http:// base URL would ship guest conversations and the
//      bearer key readable. One mistyped secret away.
//   3. Identity: /api/brains reported `model: null` for env-configured
//      brains, so during the 10 Aug outage nobody could name the vendor
//      actually answering guests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roster } from './brains.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('the fallback context gets the REDACTED profile, same as Claude', () => {
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  // The askBrains context block must scrub. Match the exact call so a
  // refactor that quietly reverts to the raw profile fails here.
  assert.match(index, /profile: redactProfile\(profile\)\.profile,\s*\n\s*buzz: grounding\.buzz/,
    'the fallback context passes the raw profile again — every non-Claude vendor sees identifying fields Claude never does');
});

test('guest data refuses to travel over cleartext http', () => {
  const brains = readFileSync(join(HERE, 'brains.mjs'), 'utf8');
  assert.match(brains, /refusing to send guest data in cleartext/,
    'the https guard is gone — a mistyped base URL broadcasts conversations and the bearer key');
  assert.match(brains, /localhost|127\.0\.0\.1/,
    'the localhost exception vanished — the self-hosted box cannot be reached at all');
});

test('every vendor answering guests is identifiable from /api/brains', () => {
  // Identity is not a secret; the KEY is. With NUM_LLM_MODEL set, the roster
  // must surface it — an unidentifiable vendor in the answer path is a
  // security finding in itself.
  const withModel = roster({ NUM_LLM_BASE_URL: 'https://api.bionic.example/v1', NUM_LLM_MODEL: 'deepseek-v4-flash' });
  const hosted = withModel.find((b) => b.id === 'hosted');
  assert.equal(hosted.model, 'deepseek-v4-flash',
    'hosted reports model:null while configured — the operator cannot name who answers guests');
  // And the key itself must never appear anywhere in the roster.
  const dump = JSON.stringify(roster({ NUM_LLM_BASE_URL: 'https://x', NUM_LLM_MODEL: 'm', NUM_LLM_KEY: 'sk-SECRET' }));
  assert.ok(!dump.includes('sk-SECRET'), 'the roster leaked a bearer key');
});

test('the model override cannot be chosen by the guest', () => {
  // The director names models from its own cost table. If the override ever
  // reads from parsed user state, a crafted request could route itself to an
  // arbitrary model string on our bill.
  const brains = readFileSync(join(HERE, 'brains.mjs'), 'utf8');
  // The lookup changed on 11 Aug — step 0 became "first step naming THIS
  // brain", because the chain is now reordered by the directive and the brain
  // being tried may be its second choice. The security property is unchanged
  // and is what this test exists for: the model name comes from the
  // directive's own cost table, never from anything the guest sent.
  assert.match(brains, /\(directive\?\.steps \?\? \[\]\)\.find\(\(s2\) => s2\.brain === brain\.id\)\?\.model/,
    'the override no longer reads the directive — verify the model name still cannot come from user input');
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  // Hoisted to a const on 30 Aug so the tier could also be RECORDED (it is
  // now num_asks.category and the lane label). The security property this
  // test exists for is unchanged and still checked: the directive is built
  // here, by the director, from the server's own env — never read off the
  // request body.
  //
  // 7 Sep 2026: the call gained `prevUser` — the previous message in the
  // thread — so a one-word reply can inherit the tier of what it replies to
  // instead of being escalated to the frontier model on no signal at all.
  //
  // That IS user-supplied, and it is worth being precise about why it changes
  // nothing here. It can influence the TIER; it can never name a MODEL.
  // Tiers resolve to model strings through the director's own cost table, on
  // the server, from env — which is the property this test exists to protect.
  // And the worst a crafted `prevUser` can do is make a cheap message
  // classify as an expensive one, which a guest can already do by simply
  // typing the expensive message. Same cost, one fewer step.
  assert.match(index, /const directive = direct\(lastUser, \{[\s\S]{0,60}?prevUser/,
    'the directive is no longer built server-side by the director');
  assert.match(index, /direct\(lastUser, \{ \.\.\.\(parsed\.state \?\? \{\}\), prevUser/,
    'the directive stopped being built from the server-side state');
  assert.ok(!/direct\([^)]*body\.(model|brain|directive)/.test(index),
    'the directive now reads a model or brain name off the request body');
  assert.ok(!/directive:\s*parsed\.(state\.)?directive/.test(index),
    'the directive is taken from the user payload — a guest could name the model on our bill');
});

test('the response brain is briefed as Num, not as a stand-in', () => {
  // From 11 Aug the hosted brain answers the everyday turn by design, so this
  // text is the product's voice for most guests most of the time. The old
  // brief opened with "you are answering while the main system is
  // unavailable" — an instruction to sound like a substitute.
  const brains = readFileSync(join(HERE, 'brains.mjs'), 'utf8');
  assert.match(brains, /YOU ARE NUM\. Answer as the concierge/,
    'the response brain is no longer told it IS Num — answers will read as a stand-in');
  assert.doesNotMatch(brains, /you are answering while the main system is unavailable/,
    'the apologetic framing is back; guests get status-page voice instead of a concierge');
});

test('the cheap brain is held to the same three rules as Claude', () => {
  // A cheaper model follows literally, so each rule is stated as a rule.
  // These three are the ones that cost real trust when they slip — and each
  // one is a bug we have already shipped once on the Claude path.
  const brains = readFileSync(join(HERE, 'brains.mjs'), 'utf8');
  assert.match(brains, /HARD CAP: three sentences, 40 words/,
    'no length cap on the response brain — replies drift back to paragraphs');
  assert.match(brains, /NEVER invent or half-remember a place, address, phone number, price, or opening hour/,
    'the invention ban is gone — the cheap brain will confabulate venues');
  assert.match(brains, /quote a rating, distance or price ONLY if it appears in the context above, verbatim/,
    'numbers may be estimated again — "about THB 2,800" was invented once already');
  assert.match(brains, /No JSON, no brackets/,
    'the format guard is gone — raw JSON leaked to guests on 9 Aug');
});

test('a recommendation gives three options and a pick', () => {
  // Dre, 11 Aug: "when someone asks for recommendations give them at least 3
  // options so they have choices." This sits in direct tension with the
  // 40-word cap added the same day — so it is a stated exception, on BOTH
  // paths, or one of the two rules quietly wins.
  for (const f of ['brains.mjs', 'prompt.mjs']) {
    const s = readFileSync(join(HERE, f), 'utf8');
    assert.match(s, /THREE options/,
      `${f}: the three-option rule is missing — the length cap will win and guests get one pick`);
    assert.match(s, /which ONE (you )?would pick|say which ONE/,
      `${f}: three options with no recommendation is a search result, not a concierge`);
  }
  const brains = readFileSync(join(HERE, 'brains.mjs'), 'utf8');
  assert.match(brains, /Under 70 words even so/,
    'the recommendation carve-out has no ceiling — "give three" becomes permission to ramble');
  assert.match(brains, /fewer than three, give what it holds and say plainly that is all/,
    'nothing covers a thin directory — the model will invent a third place to fill the list');
});
