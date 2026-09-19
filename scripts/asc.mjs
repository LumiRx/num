/**
 * App Store Connect API — auth and request helper.
 *
 * Factored out of asc-builds.mjs so that reading state and changing state use
 * exactly the same credentials and the same token, and so no script has to
 * re-derive the ES256 signing dance (Node emits DER; Apple wants raw r||s).
 *
 * Credentials come from the environment — ASC_KEY_ID, ASC_ISSUER_ID and, for
 * app-scoped calls, ASC_APP_ID. The private key is never passed in or printed:
 * it is read at run time from the folders altool already searches, named
 * AuthKey_<ASC_KEY_ID>.p8.
 */
import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BASE = 'https://api.appstoreconnect.apple.com';

export function credentials() {
  const KEY_ID = process.env.ASC_KEY_ID;
  const ISSUER = process.env.ASC_ISSUER_ID;
  const APP_ID = process.env.ASC_APP_ID;
  if (!KEY_ID || !ISSUER) {
    console.error('missing credentials. Set ASC_KEY_ID and ASC_ISSUER_ID (and ASC_APP_ID).');
    process.exit(2);
  }
  const keyPath = [
    join(process.cwd(), 'private_keys'),
    join(homedir(), 'private_keys'),
    join(homedir(), '.private_keys'),
    join(homedir(), '.appstoreconnect', 'private_keys'),
  ].map((d) => join(d, `AuthKey_${KEY_ID}.p8`)).find(existsSync);
  if (!keyPath) {
    console.error(`no AuthKey_${KEY_ID}.p8 found in any standard private_keys folder.`);
    process.exit(2);
  }
  return { KEY_ID, ISSUER, APP_ID, keyPath };
}

export function token() {
  const { KEY_ID, ISSUER, keyPath } = credentials();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })}.${b64({
    iss: ISSUER, iat: now, exp: now + 900, aud: 'appstoreconnect-v1',
  })}`;
  const sig = createSign('SHA256')
    .update(input)
    .sign({ key: readFileSync(keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${input}.${sig}`;
}

const JWT = { value: null };
const bearer = () => (JWT.value ??= token());

/**
 * One request. `path` may be a bare path ('/v1/apps') or a full URL (Apple
 * returns absolute `links.next`). Throws with Apple's own error detail, which
 * is far more useful than the status code alone.
 */
export async function asc(path, { method = 'GET', body = null, query = null } = {}) {
  const url = new URL(path.startsWith('http') ? path : BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${bearer()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const detail = (json?.errors ?? [])
      .map((e) => `${e.status} ${e.code}: ${e.title}${e.detail ? ` — ${e.detail}` : ''}`)
      .join('\n   ') || text.slice(0, 400);
    const err = new Error(`${method} ${url.pathname} → ${res.status}\n   ${detail}`);
    err.status = res.status;
    err.errors = json?.errors ?? [];
    throw err;
  }
  return json;
}

/** Follow `links.next` and concatenate `data`. */
export async function ascAll(path, opts = {}) {
  let page = await asc(path, opts);
  const out = [...(page?.data ?? [])];
  const included = [...(page?.included ?? [])];
  while (page?.links?.next) {
    page = await asc(page.links.next);
    out.push(...(page?.data ?? []));
    included.push(...(page?.included ?? []));
  }
  return { data: out, included };
}
