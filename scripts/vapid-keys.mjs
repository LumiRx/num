// Generate the VAPID keypair that identifies this server to push services.
//
// The private key is piped STRAIGHT into `wrangler secret put` and is never
// printed, never written to disk, and never reaches a terminal buffer — a
// secret that appears on a screen has to be treated as compromised, which is
// exactly how the first pair of these had to be thrown away.
//
//   node scripts/vapid-keys.mjs            → print the public key only
//   node scripts/vapid-keys.mjs --install  → also set the Worker secret
import { webcrypto as crypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
const privateKey = b64url(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

console.log('\nVAPID public key (not a secret — the browser needs it):\n' + publicKey + '\n');

if (process.argv.includes('--install')) {
  execFileSync('npx', ['wrangler', 'secret', 'put', 'VAPID_PRIVATE_KEY', '--config', 'wrangler.app.jsonc'], {
    input: privateKey,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log('\n✓ VAPID_PRIVATE_KEY set. It was never printed or saved.');
  console.log('  Now paste the public key above into src/lib/push.ts.\n');
} else {
  console.log('Run with --install to set the private key without ever showing it.\n');
}
