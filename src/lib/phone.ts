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

/**
 * Mobile shapes per country code — the same table the server keeps in
 * `claim/verify.mjs`. Sign-up is about to TEXT this number, so a landline
 * shape, or a shape no range in that country has, is refused here with a
 * sentence rather than on the server with a Twilio 60200 nobody sees.
 */
const MOBILE_NSN: Record<string, RegExp> = {
  '1': /^[2-9]\d{2}[2-9]\d{6}$/, '44': /^7\d{9}$/, '66': /^[689]\d{8}$/, '61': /^4\d{8}$/,
  '65': /^[89]\d{7}$/, '971': /^5\d{8}$/, '91': /^[6-9]\d{9}$/, '60': /^1\d{8,9}$/,
  '62': /^8\d{8,11}$/, '63': /^9\d{9}$/, '84': /^[35789]\d{8}$/, '81': /^[789]0\d{8}$/,
  '82': /^10\d{8}$/, '49': /^1[5-7]\d{8,9}$/, '33': /^[67]\d{8}$/, '34': /^[67]\d{8}$/,
  '39': /^3\d{8,9}$/, '31': /^6\d{8}$/, '353': /^8\d{8}$/, '64': /^2\d{7,9}$/, '27': /^[678]\d{8}$/,
};

const COUNTRY: Record<string, string> = {
  '1': 'US/Canada', '44': 'UK', '66': 'Thailand', '61': 'Australia', '65': 'Singapore', '971': 'UAE',
  '91': 'India', '60': 'Malaysia', '62': 'Indonesia', '63': 'Philippines', '84': 'Vietnam', '81': 'Japan',
  '82': 'Korea', '49': 'Germany', '33': 'France', '34': 'Spain', '39': 'Italy', '31': 'Netherlands',
  '353': 'Ireland', '64': 'New Zealand', '27': 'South Africa', '852': 'Hong Kong', '52': 'Mexico', '55': 'Brazil',
};

function splitCc(e164: string): { cc: string; nsn: string } {
  const digits = e164.slice(1);
  const ccs = Object.keys(COUNTRY).sort((a, b) => b.length - a.length);
  const cc = ccs.find((c) => digits.startsWith(c)) ?? '';
  return { cc, nsn: digits.slice(cc.length) };
}

/** Could this E.164 number receive a text? Unknown country → no opinion (true). */
export function plausibleMobile(e164: string): boolean {
  const { cc, nsn } = splitCc(e164);
  const rule = MOBILE_NSN[cc];
  return rule ? rule.test(nsn) : true;
}

/**
 * Everything the sign-up sheet needs to say about a number BEFORE it is sent:
 * the exact string Num will text, whether the country code was typed or
 * guessed from the device, and a sentence when the guess cannot be right.
 *
 * The 2 Sep 2026 case this is written for: a person with an Indian SIM,
 * standing in London, typed ten digits beginning 99. The device said GB, the
 * server said +44, Twilio said 60200, and he never got a code. Showing
 * "I'll text +44 991…" would have been enough for him to fix it himself.
 */
export function describePhone(raw: string): {
  e164: string | null;
  guessed: boolean;
  country: string | null;
  ok: boolean;
  note: string | null;
} {
  const s = String(raw ?? '').trim();
  if (!s) return { e164: null, guessed: false, country: null, ok: true, note: null };
  const guessed = !s.startsWith('+') && !s.startsWith('00');
  const e164 = normalisePhone(s);
  if (!e164) return { e164: null, guessed, country: null, ok: false, note: 'That number doesn’t look complete.' };
  const { cc } = splitCc(e164);
  const country = COUNTRY[cc] ?? null;
  if (!plausibleMobile(e164)) {
    return {
      e164, guessed, country, ok: false,
      note: guessed && country
        ? `I read that as a ${country} mobile and it doesn’t look like one. If your phone is from another country, start with its code — like +91 or +1.`
        : `That doesn’t look like a ${country ?? ''} mobile number I can text.`.replace('  ', ' '),
    };
  }
  return {
    e164, guessed, country, ok: true,
    note: guessed && country ? `I’ll text ${e164} (${country}) — add a + and your own code if that’s wrong.` : `I’ll text ${e164}.`,
  };
}

/** For display: what we will actually store, shown before they commit to it. */
export const prettyPhone = (raw: string): string | null => normalisePhone(raw);
