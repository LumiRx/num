/**
 * emailaddr.mjs — one rule for "is that an email address", shared by both sides.
 *
 * Its own file, with no imports and no database, for one reason: the SIGN-UP
 * FORM needs the identical function. A client that accepts an address the
 * server then refuses is a button that looks fine and fails on tap — which is
 * exactly the class of bug this codebase has paid for before.
 *
 * So the Worker imports it here and src/lib/contact.ts re-exports it, the same
 * arrangement as worker/qr.mjs. There is one implementation and it cannot
 * drift.
 */

/**
 * Is this an email address we can actually send to?
 *
 * Not a full RFC 5322 parser, on purpose — that grammar admits addresses no
 * mail server in service would accept, and the only question here is whether
 * a code has somewhere to land. Rejects the shapes people actually mistype:
 * no @, two @, nothing before or after, no dot in the domain, a trailing dot,
 * a space in the middle.
 */
export function normaliseEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s.length > 160) return null;
  if (/\s/.test(s)) return null;
  const parts = s.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || local.length > 64) return null;
  if (!domain || domain.length > 255) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null;
  // A single-letter TLD is always a typo ("gmail.c"), and so is a numeric one.
  const tld = domain.split('.').pop();
  if (tld.length < 2 || /^\d+$/.test(tld)) return null;
  return s;
}

