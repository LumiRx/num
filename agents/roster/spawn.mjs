/**
 * The agent that builds agents — and, more importantly, the one that refuses.
 *
 *   node agents/roster/spawn.mjs --brief "chase venues who claimed but never finished setup"
 *   node agents/roster/spawn.mjs --list
 *
 * Dre's ask was "an agent that can build agents to always fill new positions
 * and work on expanding NUM". Spawning a worker is the easy half and it is not
 * the half that matters. A builder with no opinion produces, on its first run,
 * an agent that emails every one of the 14,403 queued leads tonight — because
 * nothing technical prevents it, the key is set, and the agent was told to be
 * helpful.
 *
 * So this file is mostly a set of refusals. A brief that cannot answer these
 * does not become an agent:
 *
 *   WHO IS ON THE OTHER END, and did they ask to hear from us
 *   WHAT IS THE CEILING, per run and per day
 *   WHAT WOULD MAKE THIS STOP, and can a human reach that switch in one step
 *   WHAT MUST BE TRUE BEFORE IT RUNS AT ALL
 *   WHAT IS IT FORBIDDEN TO DO that a reasonable person might otherwise try
 *
 * The output is a charter and a stub, both written to disk for a human to
 * read and commit. It does not deploy anything. An agent that can put another
 * agent into production without a person reading the diff is the thing this
 * file exists to prevent.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { charter, FORBIDDEN, KILL_VAR } from './charter.mjs';
import { ROSTER } from './roster.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Briefs that describe a thing NUM will not do, however it is worded. */
const REFUSALS = Object.freeze([
  { re: /\b(scrape|harvest|crawl)\b.*\b(email|phone|contact)/i,
    why: 'Harvesting contact details is not what the directory is. NUM writes to the address a business published on its own listing, and nowhere else.' },
  { re: /\b(cold|bulk|mass|blast)\b.*\b(sms|text|message)/i,
    why: 'Bulk cold SMS is a carrier violation before it is a taste question. Consent lives in num_sms_consent and there is no path around it.' },
  { re: /\b(fake|generate|synthesi[sz]e|invent|fabricate)\b.*\b(reviews?|ratings?|testimonials?)\b/i,
    why: 'Inventing a review is the failure that cost TripAdvisor its credibility. num_ratings only ever holds what a real guest sent after a real visit.' },
  { re: /\b(boost|promote|prioriti[sz]e|rank)\b.*\b(paying|paid|premium|sponsor)/i,
    why: 'Placement is not for sale. Two tests fail the build if it becomes so, and this brief asks for exactly that.' },
  { re: /\bpose as|pretend to be|act like a (real )?(human|person)\b/i,
    why: 'NUM never claims to be a person. That specific move is what got Meta\'s AI profiles deleted inside a week.' },
  { re: /\bauto(-| )?(publish|approve|go live)\b/i,
    why: 'Nothing an agent produces reaches a traveller unread. That is the whole reason the API is safe to open.' },
]);

/** @returns {{ok:false, why:string}|{ok:true}} */
export function vet(brief) {
  const b = String(brief || '').trim();
  if (b.length < 20) return { ok: false, why: 'The brief is too short to describe who is on the other end.' };
  for (const r of REFUSALS) if (r.re.test(b)) return { ok: false, why: r.why };
  return { ok: true };
}

/** Slug from a brief, collision-checked against the live roster. */
export function slugFor(brief, taken = ROSTER.map((c) => c.id)) {
  const base = String(brief).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ').trim().split(/\s+/).slice(0, 3).join('-')
    .replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
  let id = base.length >= 3 ? base : `agent-${base}`;
  let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * The five questions. Returned unanswered — deliberately.
 *
 * The builder does not guess these. A generated ceiling is a ceiling nobody
 * chose, and the whole point of the number is that a person picked it and can
 * be asked why.
 */
export const QUESTIONS = Object.freeze([
  { key: 'audience',  q: 'Who is on the other end, and how did NUM come to hold their contact details?' },
  { key: 'consent',   q: 'What gives us the right to contact them — a published business listing, a claim, an explicit opt-in?' },
  { key: 'budget',    q: 'Ceiling per run and per day. Pick numbers you would defend to the person receiving them.' },
  { key: 'stop',      q: 'What makes this stop on its own, and how does a human stop it in one step?' },
  { key: 'requires',  q: 'What must be true before it may run at all? (a secret set, an approval granted, a consent row)' },
  { key: 'never',     q: 'What is it forbidden to do that a reasonable person might otherwise try?' },
]);

/**
 * Turn an answered brief into a charter plus a stub on disk.
 * Throws if the answers do not satisfy charter().
 */
export function spawn({ brief, answers = {}, write = true } = {}) {
  const v = vet(brief);
  if (!v.ok) throw new Error(`refused: ${v.why}`);

  const missing = QUESTIONS.filter((q) => !answers[q.key]).map((q) => q.key);
  if (missing.length) {
    const err = new Error(`unanswered: ${missing.join(', ')}`);
    err.questions = QUESTIONS.filter((q) => missing.includes(q.key));
    throw err;
  }

  const id = answers.id || slugFor(brief);
  const ch = charter({
    id,
    role: String(brief).trim(),
    may: [].concat(answers.may || [`Contact ${answers.audience}, once, on the basis of: ${answers.consent}`]),
    never: [].concat(answers.never),
    budget: answers.budget,
    windows: answers.windows || null,
    requires: [].concat(answers.requires),
  });

  const stub = `/**
 * ${ch.role}
 *
 * Spawned ${new Date().toISOString().slice(0, 10)} by agents/roster/spawn.mjs.
 * The charter below is the contract. Every send goes through canAct() and
 * screen() — the guardrails are not advisory and are not to be routed around.
 *
 * WHO IS ON THE OTHER END
 *   ${answers.audience}
 * WHY WE MAY CONTACT THEM
 *   ${answers.consent}
 * WHAT STOPS IT
 *   ${answers.stop}  ·  and ${KILL_VAR}=true, always
 */
import { canAct, allowance, screen } from './charter.mjs';
import { byId } from './roster.mjs';

export const CHARTER_ID = ${JSON.stringify(id)};

export async function run(env, { now = new Date(), state = {}, dryRun = true } = {}) {
  const ch = byId(CHARTER_ID);
  if (!ch) throw new Error('${id} is not on the roster — add it to roster.mjs before running it');

  const gate = canAct(ch, { env, now, state });
  if (!gate.ok) return { ok: true, did: 0, skipped: gate.reason };

  const budget = allowance(ch, state.sentToday || 0);
  const work = await select(env, budget);          // ← implement
  const done = [];

  for (const item of work) {
    const message = await compose(env, item);      // ← implement
    const bad = screen(message.body);
    if (bad.length) {
      console.warn('[${id}] refused own draft:', bad.map((b) => b.rule).join(', '));
      continue;                                    // never send past a tripwire
    }
    if (!dryRun) await send(env, item, message);   // ← implement
    done.push(item.id);
  }
  return { ok: true, did: done.length, budget, dryRun };
}

/** Pick at most \`budget\` recipients. Must exclude opt-outs and suppressions. */
async function select(env, budget) { throw new Error('select() not implemented'); }
/** Build { subject, body }. Must not state anything the directory does not hold. */
async function compose(env, item) { throw new Error('compose() not implemented'); }
/** Actually send. Must record the send before returning. */
async function send(env, item, message) { throw new Error('send() not implemented'); }
`;

  const path = `${HERE}${id}.mjs`;
  if (write) {
    if (existsSync(path)) throw new Error(`refused: ${path} already exists`);
    mkdirSync(HERE, { recursive: true });
    writeFileSync(path, stub);
  }
  return { charter: ch, path, stub };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    console.log(`${ROSTER.length} agents on the roster\n`);
    for (const c of ROSTER) {
      console.log(`  ${c.id}`);
      console.log(`    ${c.role}`);
      console.log(`    cap ${c.budget.perRun}/run, ${c.budget.perDay}/day · ${c.never.length} prohibitions` +
        (c.requires.length ? ` · needs ${c.requires.join(', ')}` : ''));
      console.log('');
    }
    console.log(`House rules inherited by every one of them:`);
    for (const [k, v] of Object.entries(FORBIDDEN)) console.log(`  ${k}: ${v.split('.')[0]}.`);
    return;
  }

  const i = argv.indexOf('--brief');
  const brief = i >= 0 ? argv[i + 1] : '';
  if (!brief) { console.log('usage: spawn.mjs --brief "what this agent is for"   |   --list'); return; }

  const v = vet(brief);
  if (!v.ok) { console.log(`REFUSED\n\n  ${v.why}`); process.exitCode = 1; return; }

  console.log(`Brief accepted: "${brief}"`);
  console.log(`Proposed id:    ${slugFor(brief)}\n`);
  console.log('Answer these, then call spawn() with them. They are not generated on purpose —');
  console.log('a ceiling nobody chose is a ceiling nobody can be asked to defend.\n');
  for (const q of QUESTIONS) console.log(`  ${q.key.padEnd(9)} ${q.q}`);
}

if (process.argv[1] && process.argv[1].endsWith('spawn.mjs')) main();
