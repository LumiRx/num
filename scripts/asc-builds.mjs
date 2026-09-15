#!/usr/bin/env node
/**
 * What build numbers does Apple already have?
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * Apple refuses an upload whose build number is not higher than every build it
 * already holds for that version, and it refuses it AFTER the archive, the
 * export and the transfer — several minutes in, at the last possible moment.
 *
 * Worse, the number in the project file is not a reliable guide to what Apple
 * has. On 13 Sep 2026 `CURRENT_PROJECT_VERSION` read 5 while the build sitting
 * at App Review was 6: something outside the repository had incremented it.
 * Anyone trusting the file would have built 6 again and lost the upload.
 *
 * So ask Apple. It is one request and it takes a second.
 *
 * ── CREDENTIALS ────────────────────────────────────────────────────────────
 *
 * Reads, in order of preference, from the environment:
 *
 *   ASC_KEY_ID      the key's ID, e.g. the one named "num admin"
 *   ASC_ISSUER_ID   the issuer UUID from Users and Access → Integrations
 *   ASC_APP_ID      the app's numeric Apple ID
 *
 * The private key itself is never passed in or printed. It is read at run time
 * from the standard locations altool already searches:
 *
 *   ./private_keys  ~/private_keys  ~/.private_keys  ~/.appstoreconnect/private_keys
 *
 * named AuthKey_<ASC_KEY_ID>.p8. Nothing about it is logged.
 *
 * Usage:  node scripts/asc-builds.mjs [marketingVersion]
 * Prints: the highest build number Apple holds, or `none`.
 */
import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER = process.env.ASC_ISSUER_ID;
const APP_ID = process.env.ASC_APP_ID;
const WANT_VERSION = process.argv[2] || null;

if (!KEY_ID || !ISSUER || !APP_ID) {
  console.error('missing credentials. Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_APP_ID.');
  console.error('Find them in App Store Connect → Users and Access → Integrations.');
  process.exit(2);
}

const keyPath = [
  join(process.cwd(), 'private_keys'),
  join(homedir(), 'private_keys'),
  join(homedir(), '.private_keys'),
  join(homedir(), '.appstoreconnect', 'private_keys'),
].map((d) => join(d, `AuthKey_${KEY_ID}.p8`)).find(existsSync);

if (!keyPath) {
  console.error(`no AuthKey_${KEY_ID}.p8 found in any of the standard private_keys folders.`);
  process.exit(2);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const signingInput = `${b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })}.${b64({
  iss: ISSUER, iat: now, exp: now + 600, aud: 'appstoreconnect-v1',
})}`;
// ES256 wants a raw r||s signature, not the DER encoding Node emits by default.
const sig = createSign('SHA256')
  .update(signingInput)
  .sign({ key: readFileSync(keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' })
  .toString('base64url');
const jwt = `${signingInput}.${sig}`;

const url = new URL('https://api.appstoreconnect.apple.com/v1/builds');
url.searchParams.set('filter[app]', APP_ID);
url.searchParams.set('limit', '200');
url.searchParams.set('fields[builds]', 'version,uploadedDate,preReleaseVersion');
url.searchParams.set('include', 'preReleaseVersion');

const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
if (!res.ok) {
  console.error(`App Store Connect answered ${res.status}. ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const body = await res.json();
const pre = new Map((body.included ?? []).map((i) => [i.id, i.attributes?.version]));
const builds = (body.data ?? []).map((b) => ({
  build: Number(b.attributes?.version),
  version: pre.get(b.relationships?.preReleaseVersion?.data?.id) ?? null,
}));
const scoped = WANT_VERSION ? builds.filter((b) => b.version === WANT_VERSION) : builds;
const highest = scoped.reduce((m, b) => (Number.isFinite(b.build) && b.build > m ? b.build : m), 0);

// `--list` prints every build Apple holds, newest first. The version page in
// App Store Connect shows only the build currently SELECTED for submission,
// which is easily read as "this is all Apple has". It is not the same thing.
if (process.argv.includes('--list')) {
  const rows = (body.data ?? [])
    .map((b) => ({
      build: Number(b.attributes?.version),
      version: pre.get(b.relationships?.preReleaseVersion?.data?.id) ?? '?',
      uploaded: b.attributes?.uploadedDate ?? '',
    }))
    .filter((b) => !WANT_VERSION || b.version === WANT_VERSION)
    .sort((a, b) => b.build - a.build);
  for (const r of rows) {
    console.log(`  ${r.version} (${r.build})   uploaded ${r.uploaded.slice(0, 16).replace('T', ' ')}`);
  }
  console.log(`\n  highest: ${highest || 'none'}`);
} else {
  console.log(highest || 'none');
}
