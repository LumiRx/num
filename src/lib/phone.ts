// Turning what a person types into a number we can actually reach.
//
// The old field demanded E.164 with a leading "+". That is correct, and it is
// also a thing almost nobody types unprompted — people type the number the way
// they'd read it aloud. Rejecting "555 123 4567" with "start with +1" makes
// the app look pedantic at the exact moment it is asking a favour, and we have
// 48 abandoned sign-ups that stopped at this field.
//
// So: accept what they type, infer the country from the device, and store the
// canonical form. The strictness moves from the human to the code, which is
// where it belongs.

/** Dial codes for the locales we actually see, by region subtag. */
const DIAL: Record<string, string> = {
  US: '1', CA: '1', GB: '44', IE: '353', NL: '31', BE: '32', DE: '49', FR: '33',
  ES: '34', IT: '39', PT: '351', SE: '46', NO: '47', DK: '45', FI: '358',
  PL: '48', CZ: '420', AT: '43', CH: '41', TH: '66', SG: '65', MY: '60',
  ID: '62', VN: '84', PH: '63', JP: '81', KR: '82', CN: '86', HK: '852',
  IN: '91', AE: '971', AU: '61', NZ: '64', ZA: '27', BR: '55', MX: '52',
};

/** The device's country, from the browser's own locale. Falls back to US. */
export function guessDialCode(): string {
  try {
    const loc =
      (Intl.DateTimeFormat().resolvedOptions() as { locale?: string }).locale ||
      navigator.language || 'en-US';
    const region = loc.split('-').pop()?.toUpperCase() ?? 'US';
    return DIAL[region] ?? '1';
  } catch {
    return '1';
  }
}

/**
 * Canonicalise to E.164, or null if it cannot be one.
 *
 * Returns null rather than guessing wildly: a number we cannot form properly
 * is worse than an absent one, because an absent number is honest about the
 * fact that we cannot reach them.
 */
export function normalisePhone(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  // Already international.
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  // 00 is the other way people write an international prefix.
  if (s.startsWith('00')) {
    const digits = s.slice(2).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  const digits = s.replace(/\D/g, '');
  if (!digits) return null;

  const cc = guessDialCode();
  // A leading 0 is a national trunk prefix in most of the world (020…, 06…)
  // and is dropped when the country code goes on.
  const national = digits.replace(/^0+/, '');
  if (national.length < 6 || national.length > 14) return null;

  return `+${cc}${national}`;
}

/** For display: what we will actually store, shown before they commit to it. */
export const prettyPhone = (raw: string): string | null => normalisePhone(raw);
