#!/usr/bin/env node
/**
 * Promote a business submission into a live listing.
 *
 * ── WHY THIS IS A SCRIPT AND NOT TWO CURLS ───────────────────────────────
 *
 * The two-curl version has three failure modes that all look identical from
 * the outside, because the second command prints the only error you see:
 *
 *   · the key is wrong                     → session 401, TOKEN is the string
 *   · you are rate limited (8/min)         → session 429,  "null", promote
 *   · the submission id does not exist     → promote 404   says "unauthorized"
 *
 * Two of those three are not authorisation problems and one of them fixes
 * itself in sixty seconds. Reporting all three as "unauthorized" is how an
 * afternoon disappears.
 *
 * ── AND WHY THE KEY COMES FROM A FILE ────────────────────────────────────
 *
 * A key typed on a command line is written to ~/.zsh_history in plain text and
 * stays there. A key pasted into a chat window is in that transcript forever.
 * This reads it from a file that never leaves the machine, so neither happens.
 *
 *   mkdir -p ~/num-worktrees/.secrets
 *   printf '%s' 'the-key' > ~/num-worktrees/.secrets/admin.key   # no newline
 *   chmod 600 ~/num-worktrees/.secrets/admin.key
 *
 * Usage:
 *   node scripts/promote-submission.mjs <submission_id> <lat> <lng> <dest> [--owner]
 *   node scripts/promote-submission.mjs --check            # key works?
 *
 * `--owner` says you have read this submission and are satisfied the person
 * who sent it is the business. It creates their account and hands back a
 * one-tap sign-in link, so somebody who already signed up does not have to
 * sign up again. Without it, promotion leaves the listing unclaimed and they
 * have to find themselves in a search box and claim it from scratch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = process.env.NUM_BASE || 'https://app.itsnum.com';
const KEY_FILE = process.env.NUM_ADMIN_KEY_FILE
  || join(homedir(), 'num-worktrees', '.secrets', 'admin.key');

const die = (msg, hint) => {
  console.error(`\n  ${msg}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
};

function readKey() {
  let raw;
  try {
    raw = readFileSync(KEY_FILE, 'utf8');
  } catch {
    die(`No admin key at ${KEY_FILE}`,
      'Create it:  printf \'%s\' \'your-key\' > ' + KEY_FILE + ' && chmod 600 ' + KEY_FILE);
  }
  // Trailing newline is the most common way this silently fails: `echo` adds
  // one, the comparison is exact, and the error says only "does not match".
  const key = raw.replace(/[\r\n]+$/, '');
  if (!key) die(`${KEY_FILE} is empty.`);
  if (key !== raw) {
    console.warn('  note: stripped a trailing newline from the key file '
      + '(use printf, not echo, to avoid it)');
  }
  // Every placeholder this project has ever printed in an instruction, plus
  // the obvious shapes. Copying the example verbatim is not carelessness — it
  // is what a shell command in a document invites — and the failure it causes
  // otherwise is a 401 that looks exactly like a wrong key.
  const PLACEHOLDERS = [
    'the-new-key', 'your-admin-key', 'the-key', 'your-key', 'new-key', 'admin-key',
  ];
  if (PLACEHOLDERS.includes(key.toLowerCase()) || /^(PASTE|REPLACE|YOUR[_-])/i.test(key)) {
    die(`${KEY_FILE} holds the example text, not your key.`,
      `It currently contains ${key.length} characters of placeholder.\n`
      + `  Write the real one:  printf '%s' 'THE-ACTUAL-KEY' > ${KEY_FILE}`);
  }
  return key;
}

async function session(key) {
  const res = await fetch(`${BASE}/api/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, who: 'dre' }),
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 429) {
    die('Rate limited on the admin door.',
      'The admin bucket is 8 attempts a minute, on purpose. Wait a minute and run this again.');
  }
  if (res.status === 401) {
    die('That key does not match the ADMIN_KEY set on the Worker.',
      'Check with:  npx wrangler secret list --config wrangler.app.jsonc\n'
      + '  Set it with: npx wrangler secret put ADMIN_KEY --config wrangler.app.jsonc');
  }
  if (res.status === 503) {
    die('No ADMIN_KEY is configured on the Worker at all.',
      'npx wrangler secret put ADMIN_KEY --config wrangler.app.jsonc');
  }
  if (!res.ok || !body?.token) {
    die(`The admin door answered ${res.status}: ${JSON.stringify(body)}`);
  }
  return body.token;
}

const argv = process.argv.slice(2);
const owner = argv.includes('--owner');

// Read the flags BEFORE the positionals are filtered out of them. An earlier
// version checked `id === '--check'` after that filter had already removed
// every argument starting with a dash, so --check could never be true and the
// only thing it could ever print was the usage line.
if (argv.includes('--check')) {
  await session(readKey());
  console.log('\n  Key works. A session was minted and thrown away.\n');
  process.exit(0);
}

const [id, lat, lng, dest] = argv.filter((a) => !a.startsWith('--'));

if (!id || !lat || !lng || !dest) {
  die('Usage: node scripts/promote-submission.mjs <submission_id> <lat> <lng> <dest> [--owner]',
    'e.g.   node scripts/promote-submission.mjs sub_abc 34.0443 -118.2507 los-angeles --owner');
}
if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
  die('lat and lng have to be numbers.');
}

const token = await session(readKey());
const res = await fetch(`${BASE}/api/admin/submissions/promote`, {
  method: 'POST',
  headers: { 'X-Admin-Session': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    submission_id: id, lat: Number(lat), lng: Number(lng), dest, by: 'dre', owner,
  }),
});
const out = await res.json().catch(() => ({}));

if (!res.ok) {
  die(`Promote failed (${res.status}): ${JSON.stringify(out)}`,
    res.status === 404 ? 'That submission id is not in the queue — check it with the ops console.' : '');
}
console.log(`\n  Promoted. ${JSON.stringify(out, null, 2).split('\n').join('\n  ')}\n`);

if (out.signin_url) {
  console.log('  ── Their sign-in link — one use, 14 days ──────────────────────────\n');
  console.log(`  ${out.signin_url}\n`);
  console.log('  Send it to them. One tap and they are in their dashboard, with');
  console.log('  everything they already told us already filled in.\n');
} else if (owner) {
  console.log('  The account was created but the sign-in link could not be minted.');
  console.log('  They can still sign in at itsnum.com/business and take a code.\n');
}
