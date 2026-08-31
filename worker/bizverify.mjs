/**
 * Proving you own the business — the badge, not the account.
 *
 * Approval is automatic (bizapproval.autoApproveAll): anyone who claims their
 * own venue gets a dashboard immediately, because refusing costs a real
 * business and protects nothing. THIS file answers the other question — should
 * a traveller be told this listing is confirmed by its owner — and that one
 * needs proof, because the badge is worth exactly as much as it is hard to get.
 *
 * ── THREE ROUTES, ALL PROOF OF CONTROL ────────────────────────────────────
 *
 * 1. LISTING CONTACT — a code sent to the email or phone ALREADY published on
 *    the listing. Strongest and oldest: it proves control of the contact a
 *    traveller would have used anyway. 836,066 of 2.5M listings carry an
 *    email, so this covers a third of the directory. (growth/claimverify.mjs)
 *
 * 2. WEBSITE — put a token on the domain the listing already points at. Proof
 *    of control of the site, which is what an owner has and a stranger does
 *    not.
 *
 * 3. GOOGLE BUSINESS EMAIL — sign in with the Google account that manages the
 *    business, and match its verified email against the listing's own domain
 *    or published address.
 *
 * ── THE RULE THAT MAKES ALL THREE HONEST ──────────────────────────────────
 *
 * Every route compares what the claimant proved against WHAT WE ALREADY HELD
 * before they turned up. A claimant supplying both the evidence and the thing
 * it is checked against has proved nothing — that was SEC-006, and it is the
 * single mistake this file exists to avoid repeating.
 */

/** Strip to a bare registrable-ish host: no scheme, no www, no path, no port. */
export function hostOf(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  let host = raw;
  try {
    host = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  return host || null;
}

/** The domain part of an email address. */
export const domainOfEmail = (email) => {
  const m = /^[^@\s]+@([^@\s]+)$/.exec(String(email ?? '').trim().toLowerCase());
  return m ? m[1].replace(/^www\./, '') : null;
};

/**
 * Free mailbox providers can never prove a domain.
 *
 * `owner@gmail.com` proves control of a Gmail account and nothing about a
 * restaurant. Without this list a single Gmail address would verify every
 * listing that happened to publish a Gmail address — and 4 of our 8 real
 * signups used exactly those, so this is the common case, not the corner one.
 */
export const PUBLIC_MAILBOXES = Object.freeze(new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'hotmail.co.uk',
  'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com',
  'qq.com', '163.com', '126.com', 'naver.com', 'hanmail.net', 'zoho.com',
]));

/**
 * Does this proven email establish control of the listing?
 *
 * Two ways, and both compare against what the listing ALREADY said:
 *   · the exact address published on the listing, or
 *   · the domain of the listing's own website (never a public mailbox).
 */
export function emailProvesListing(provenEmail, listing = {}) {
  const email = String(provenEmail ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return { ok: false, reason: 'not an email address' };

  const listed = String(listing.email ?? '').trim().toLowerCase();
  if (listed && listed === email) return { ok: true, via: 'listing email' };

  const dom = domainOfEmail(email);
  if (!dom) return { ok: false, reason: 'not an email address' };
  if (PUBLIC_MAILBOXES.has(dom)) {
    return {
      ok: false,
      reason: 'a personal mailbox proves the mailbox, not the business — use the website or the address on the listing',
    };
  }

  const site = hostOf(listing.website);
  if (site && (site === dom || site.endsWith(`.${dom}`) || dom.endsWith(`.${site}`))) {
    return { ok: true, via: 'website domain' };
  }
  const listedDom = domainOfEmail(listed);
  if (listedDom && !PUBLIC_MAILBOXES.has(listedDom) && listedDom === dom) {
    return { ok: true, via: 'listing email domain' };
  }
  return { ok: false, reason: 'that address is not on the listing and does not match its website' };
}

/**
 * The token a business puts on its own website.
 *
 * Derived from the place id under a server-side secret, so it is stable
 * (an owner can come back to a half-finished job tomorrow) and unguessable
 * (nobody can compute another venue's token). No storage, no expiry to sweep.
 */
export async function siteToken(env, placeId) {
  const secret = String(env?.BIZ_VERIFY_SECRET ?? env?.ADMIN_KEY ?? '');
  if (!secret || !placeId) return null;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`site:${placeId}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `num-verify-${hex.slice(0, 32)}`;
}

/**
 * Check the website for the token.
 *
 * Fetched from the domain THE LISTING ALREADY POINTS AT — never a URL the
 * claimant supplies. Letting them name the URL would let them host the token
 * on a site they own and verify a venue they do not; the check would pass and
 * prove nothing.
 */
export async function checkSite(env, listing, { fetchImpl = fetch } = {}) {
  const host = hostOf(listing?.website);
  if (!host) return { ok: false, reason: 'this listing has no website on file, so there is nothing to check' };
  const token = await siteToken(env, listing.id ?? listing.place_id);
  if (!token) return { ok: false, reason: 'verification is not configured on this Worker' };

  // Two conventional homes, both under the owner's control and neither
  // requiring them to touch page markup.
  const urls = [`https://${host}/.well-known/num-verify.txt`, `https://${host}/num-verify.txt`];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const body = (await res.text()).slice(0, 2000);
      if (body.includes(token)) return { ok: true, via: 'website file', url };
    } catch { /* try the next location */ }
  }
  return {
    ok: false,
    reason: `put a file containing ${token} at https://${host}/.well-known/num-verify.txt, then press Check again`,
    token,
    host,
  };
}

/** Record the badge. Never called except by a route that has proof in hand. */
export async function markVerified(env, { placeId, claimId, via, evidence }) {
  if (!env?.DB) return { ok: false };
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_business_verification (
       place_id   TEXT PRIMARY KEY,
       claim_id   TEXT,
       method     TEXT NOT NULL,
       evidence   TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run();
  await env.DB.prepare(
    'INSERT OR REPLACE INTO num_business_verification (place_id, claim_id, method, evidence) VALUES (?1,?2,?3,?4)',
  ).bind(String(placeId), claimId ? String(claimId) : null, String(via), String(evidence ?? '').slice(0, 300)).run();
  if (claimId) {
    await env.DB.prepare("UPDATE claims SET verified_at = datetime('now') WHERE id = ?1")
      .bind(String(claimId)).run().catch(() => {});
  }
  return { ok: true, via };
}
