// eSIM activation strings — the one thing every supplier returns and every
// phone understands.
//
// An activation code is "LPA:1$<SM-DP+ address>$<matching id>". A phone that
// scans the QR reads exactly this string. We also turn it into:
//   - Apple's one-tap install link (iOS 17.4+), so an iPhone owner installs
//     from the text or page on the SAME phone, with nothing to scan;
//   - the two manual fields Android asks for when there is no second screen.

const LPA_RE = /^LPA:1\$([^$\s]+)\$([^$\s]+)(?:\$[^\s]*)?$/i;

/** Parse an LPA string. Returns null for anything that is not one. */
export function parseLpa(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = LPA_RE.exec(s);
  if (!m) return null;
  const smdp = m[1];
  const code = m[2];
  // An SM-DP+ address is a hostname. Refuse anything that is not, so a
  // malformed supplier response can never become a link we send someone.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(smdp)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(code)) return null;
  return { lpa: `LPA:1$${smdp}$${code}`, smdp: smdp.toLowerCase(), code };
}

/** Build an LPA string from its two parts (suppliers that return them separately). */
export function buildLpa(smdp, code) {
  return parseLpa(`LPA:1$${smdp}$${code}`)?.lpa ?? null;
}

const APPLE_BASE = 'https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=';

/**
 * Apple's universal link for direct eSIM install (iOS 17.4 and later).
 * It only works when TAPPED on the iPhone that should receive the eSIM —
 * never behind a redirect — so pages render it as a plain link.
 */
export function appleInstallUrl(raw) {
  const p = parseLpa(raw);
  if (!p) return null;
  return APPLE_BASE + p.lpa;
}

/** The two fields Android (and older iPhones) ask for on manual entry. */
export function manualCodes(raw) {
  const p = parseLpa(raw);
  if (!p) return null;
  return { smdp: p.smdp, activationCode: p.code };
}
