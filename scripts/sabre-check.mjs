// Test a pair of Sabre credentials against the real token endpoint, without
// putting either of them in your shell history, your process list, or a file.
//
// The reason this exists: Sabre answers every bad token request with the same
// sentence — "Credentials are missing or the syntax is not correct" — whether
// the problem is the password, the user id, the encoding, or a stray newline.
// One error for four causes is not a diagnosis, so this narrows it by trying
// both documented encodings and telling you exactly what came back.
//
//   node scripts/sabre-check.mjs            certification (default)
//   node scripts/sabre-check.mjs --prod     production
//
// Nothing is written anywhere and the secret is never echoed or printed.
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

const HOST = process.argv.includes('--prod') ? 'https://api.platform.sabre.com' : 'https://api.cert.platform.sabre.com';

// Two genuinely different input modes, rather than one that half-works in
// both. Interactively we want a live prompt with the echo suppressed; piped,
// readline races itself — both lines can arrive in a single chunk before the
// second question is registered, and the second value is then swallowed. So
// piped input is read whole, up front, and handed out from an array.
const interactive = stdin.isTTY;

let piped = [];
if (!interactive) {
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  piped = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

const rl = interactive ? createInterface({ input: stdin, output: stdout, terminal: true }) : null;

const ask = (question) =>
  interactive ? new Promise((resolve) => rl.question(question, resolve)) : Promise.resolve(piped.shift() ?? '');

/**
 * Ask without echoing, so a shoulder is not a threat.
 *
 * Repainting the prompt on each keystroke rather than muting the stream keeps
 * backspace and paste behaving the way people expect.
 */
function askHidden(question) {
  if (!interactive) return ask(question);
  const repaint = () => rl.output.write('\x1b[2K\r' + question);
  stdin.on('data', repaint);
  return ask(question).then((answer) => {
    stdin.off('data', repaint);
    rl.output.write('\n');
    return answer;
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const ENCODINGS = {
  'double Base64 (documented for v2)': (id, secret) => b64(`${b64(id)}:${b64(secret)}`),
  'plain HTTP Basic': (id, secret) => b64(`${id}:${secret}`),
};

const rawId = await ask('Client ID / Test user ID (e.g. V1:user:GROUP:EXT): ');
const rawSecret = await askHidden('Client secret / Test password (hidden): ');
rl?.close();

// Whitespace is the single most common cause here — a copied credential picks
// up a trailing space or newline and every encoding of it is then wrong.
const id = rawId.trim();
const secret = rawSecret.trim();
if (id !== rawId || secret !== rawSecret) {
  console.log('\n⚠  Trimmed surrounding whitespace from what you pasted — that alone is often the bug.');
}

console.log(`\n  host      ${HOST}`);
console.log(`  client id ${id}`);
console.log(`  secret    ${secret.length} characters\n`);

if (!/^V\d+:/.test(id)) {
  console.log('⚠  The client id does not start with "V1:" — Sabre EPR credentials normally look like V1:user:GROUP:EXT.\n');
}

let worked = null;
for (const [label, encode] of Object.entries(ENCODINGS)) {
  process.stdout.write(`  trying ${label}… `);
  try {
    const res = await fetch(`${HOST}/v2/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${encode(id, secret)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.access_token) {
      console.log(`✓ WORKS (token expires in ${body.expires_in ?? '?'}s)`);
      worked = label;
      break;
    }
    console.log(`✘ ${res.status} ${body.error_description ?? body.error ?? ''}`);
  } catch (err) {
    console.log(`✘ ${err.message}`);
  }
}

console.log();
if (worked) {
  console.log(`✓ These credentials are good against ${HOST}.`);
  console.log(`  Encoding that worked: ${worked}`);
  console.log('  The Worker tries both and remembers whichever succeeds, so nothing else to set.\n');
} else {
  console.log('✘ Neither encoding was accepted, so the VALUES are the problem, not the format. Usual causes:\n');
  console.log('   · The test password was reset — Dev Studio resets these periodically.');
  console.log('     Go to My Applications and generate a fresh pair.');
  console.log('   · The secret was copied from the masked field rather than after clicking the eye icon.');
  console.log('   · The client id and secret are from different applications.');
  console.log('   · This credential is scoped to the portal console only and not to external calls —');
  console.log('     if the "Try it" button works on the same page but this does not, that is the answer,');
  console.log('     and you need real application credentials rather than the docs test pair.\n');
}
