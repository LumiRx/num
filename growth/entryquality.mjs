/**
 * Which referrals count, which do not, and why — said out loud.
 *
 * Dre, 19 Sep 2026: "lets make sure its not gamable they only get one account
 * to entered in the must verify with us through 5arz."
 *
 * ── THE THING THAT PAYS FOR FARMING, AND THE THING THAT STOPS IT ─────────
 *
 * A referral ladder with a trip at the top is an invitation to make accounts.
 * Twenty signups on one phone is twenty minutes of work and, before this
 * file, it was worth an entry. Two defences, and they do different jobs:
 *
 *   · THIS FILE removes the farm from the COUNT, so the entries never
 *     accrue in the first place.
 *   · THE CLAIM GATE (see tokyodraw.mjs) means a winner must be
 *     5arz-verified to collect. `/verify/5arz` already enforces one 5arz
 *     identity per Num account and says so in its own comment — "the whole
 *     Sybil problem wearing a badge" — so a farmer who somehow accumulates
 *     entries still cannot convert them into a trip.
 *
 * Together they remove the payoff twice over, which is the only way this
 * ever holds: any single check can be worked around by somebody patient.
 *
 * ── WHICH SIGNALS ARE EVIDENCE, AND WHICH ARE CLAIMS ────────────────────
 *
 * Found in review, 19 Sep 2026, and it mattered: `device_id` is taken from
 * the SIGNUP REQUEST BODY (worker/social.mjs, ctxSignals) and `ua_hash` is a
 * hash of the User-Agent header. Both are set by whoever is signing up. Until
 * today the device field also fell back to the new member's own id when
 * absent, so simply omitting it minted a unique device per account and the
 * cluster rule below could never fire — the farm defence was switched off by
 * sending nothing.
 *
 * So the signals are now ranked by who controls them:
 *
 *   ip_hash    Cloudflare sets CF-Connecting-IP. The attacker cannot choose
 *              it without real infrastructure. TRUSTWORTHY ORIGIN, weak
 *              meaning — see the paragraph below.
 *   device_id  a string the client sent. Useful, because a casual farmer does
 *              not think to vary it, and NULL now honestly means "we have no
 *              evidence" instead of a fabricated unique value. Never treated
 *              as proof on its own.
 *   ua_hash    a header. Same status as device_id.
 *
 * The honest consequence, stated rather than hidden: somebody who varies the
 * device string, varies the User-Agent, verifies an email and sends one
 * message per account can still accrue entries. What they cannot do is
 * collect — a winner must pass 5arz verification, and /verify/5arz refuses to
 * link one identity to two accounts. The counting rules raise the cost; the
 * claim gate removes the prize.
 *
 * ── WHY IP ALONE IS NOT EVIDENCE OF ANYTHING ─────────────────────────────
 *
 * Measured on production, 19 Sep 2026: 156 members across **104 devices and
 * 61 IP addresses**. That is not a farm, it is households, offices, campus
 * wifi and hotel NAT. Disqualifying a referral because two people share an IP
 * would reject a man who signed his wife up on the sofa next to him, and the
 * ambassador would have no idea why their number went down.
 *
 * So the signals are weighted by what they actually prove:
 *   device_id match            → the same browser profile. Strong. Rejected.
 *   ip_hash AND ua_hash match  → same network and same browser build. Rejected.
 *   ip_hash alone              → a shared router. NOT rejected, flagged only.
 *
 * ── AND EVERY REJECTION HAS TO BE EXPLAINABLE ────────────────────────────
 *
 * An ambassador who brings thirty people, sees "2 count", and is told
 * nothing will conclude NUM is stealing from them — and they will say so
 * publicly, which costs more than the farm would have. Every rule here
 * carries a `why` written for that person to read, and `assess()` returns the
 * tally so their console can show it. A silent filter is worse than no
 * filter.
 */

/**
 * The rules, in the order they are applied. All four of Dre's choices, each
 * one separately switchable — because two of them are severe at today's
 * verification levels and the numbers behind them will change.
 *
 * `severity` is a note to whoever tunes this later, not a behaviour.
 */
export const RULES = Object.freeze([
  {
    key: 'self',
    label: 'the referrer themselves',
    why: 'This account is yours. Bringing yourself in is not a referral.',
    severity: 'certain',
  },
  {
    key: 'same_device',
    label: 'same device as the referrer',
    why: 'This signup came from the same device as your own account. If that was a real person using your phone, ask them to open NUM on their own and it will count.',
    severity: 'strong',
  },
  {
    key: 'same_fingerprint',
    label: 'same network and browser as the referrer',
    why: 'This signup matched your own network and browser exactly. Sharing wifi alone is fine — this one matched both.',
    severity: 'strong',
  },
  {
    key: 'cluster',
    label: 'several signups from one device',
    why: 'Several of your signups came from one device. One of them counts and the rest do not.',
    severity: 'claimed-signal',
  },
  {
    key: 'ip_cluster',
    label: 'many signups from one internet connection',
    why: 'A lot of your signups came from a single internet connection. A few people on one wifi is normal and counts — this was more than a household. If you signed people up at an event, tell us and we will look.',
    severity: 'trustworthy-origin',
  },
  {
    key: 'no_contact',
    label: 'no verified phone or email',
    why: 'This person has not verified a phone or an email yet, so NUM cannot tell they are real. It counts as soon as they do.',
    severity: 'harsh-today',
  },
  {
    key: 'inactive',
    label: 'has never used NUM',
    why: 'They signed up and have not asked NUM for anything yet. It counts the first time they do.',
    severity: 'harsh-today',
  },
]);

export const RULE_KEYS = Object.freeze(RULES.map((r) => r.key));
export const ruleByKey = (k) => RULES.find((r) => r.key === k) || null;

/**
 * Which of these people actually count for the referrer, and why not.
 *
 * `rows` is every member with `referred_by = referrer`, carrying their
 * signals. Pure and synchronous on purpose: the database work belongs to the
 * caller, and a decision about who gets a prize should be testable without
 * one.
 *
 * Returns { counted, rejected: [{ member_id, rule }], tally: { rule: n } }.
 */
/**
 * How many signups may share ONE internet connection before the rest stop
 * counting.
 *
 * Six, and the number is a judgement rather than a measurement. A household
 * is two to five people and must not be punished — production on 19 Sep had
 * 156 members behind 61 IPs, so shared connections are the norm, not the
 * exception. Twenty-five accounts behind one is not a family.
 *
 * The honest cost: an ambassador who signs twenty people up on one venue's
 * wifi at an event loses the excess. That is a real case and it is rare, the
 * rejection says so in words, and the ops queue exists for them to ask. The
 * alternative — no limit on the one signal an attacker cannot forge — leaves
 * the whole ladder open to anybody with a scripted signup.
 */
export const MAX_PER_IP = 6;

export function assess({ referrerId, referrerSignals = null, rows = [] } = {}) {
  const rejected = [];
  const tally = {};
  const reject = (id, rule) => {
    rejected.push({ member_id: id, rule });
    tally[rule] = (tally[rule] || 0) + 1;
  };

  // One pass to find which device fingerprints appear more than once ACROSS
  // the referrals. A farm on a second phone shares nothing with the referrer
  // and everything with itself, which the per-row checks below cannot see.
  const seenDevice = new Map();
  const seenIp = new Map();
  for (const r of rows) {
    if (r.device_id) seenDevice.set(r.device_id, (seenDevice.get(r.device_id) || 0) + 1);
    if (r.ip_hash) seenIp.set(r.ip_hash, (seenIp.get(r.ip_hash) || 0) + 1);
  }
  const keptFromDevice = new Set();
  const keptPerIp = new Map();

  let counted = 0;
  for (const r of rows) {
    const id = String(r.id);

    if (id === String(referrerId)) { reject(id, 'self'); continue; }

    if (r.device_id && referrerSignals?.device_id && r.device_id === referrerSignals.device_id) {
      reject(id, 'same_device'); continue;
    }

    // BOTH, never IP alone. See the header: 61 IPs for 156 members.
    if (r.ip_hash && r.ua_hash && referrerSignals?.ip_hash && referrerSignals?.ua_hash
      && r.ip_hash === referrerSignals.ip_hash && r.ua_hash === referrerSignals.ua_hash) {
      reject(id, 'same_fingerprint'); continue;
    }

    // The first from a repeated device counts; the rest do not. Keeping one
    // rather than none matters — a family really might share a tablet, and
    // taking all of them would punish the honest case as hard as the farm.
    if (r.device_id && seenDevice.get(r.device_id) > 1) {
      if (keptFromDevice.has(r.device_id)) { reject(id, 'cluster'); continue; }
      keptFromDevice.add(r.device_id);
    }

    /* THE ONE AN ATTACKER CANNOT SIMPLY OMIT. Applied after the device
       checks so that the clearer explanation wins when both would fire. */
    if (r.ip_hash && seenIp.get(r.ip_hash) > MAX_PER_IP) {
      const used = keptPerIp.get(r.ip_hash) || 0;
      if (used >= MAX_PER_IP) { reject(id, 'ip_cluster'); continue; }
      keptPerIp.set(r.ip_hash, used + 1);
    }

    if (!(Number(r.phone_verified) === 1 || Number(r.email_verified) === 1)) {
      reject(id, 'no_contact'); continue;
    }

    if (!(Number(r.activity) > 0)) { reject(id, 'inactive'); continue; }

    counted += 1;
  }

  return { counted, rejected, tally };
}

/** The tally turned into sentences an ambassador can read. */
export function explain(tally = {}) {
  return Object.entries(tally)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => {
      const r = ruleByKey(key);
      return { key, n, label: r?.label ?? key, why: r?.why ?? '' };
    })
    .sort((a, b) => b.n - a.n);
}

/**
 * One human, one entrant.
 *
 * The key a person is deduplicated by, strongest evidence first:
 *
 *   5arz:<id>    a verified 5arz identity. `/verify/5arz` already refuses to
 *                link one 5arz account to two Num accounts, so this is the
 *                only key here that is actually PROVEN unique.
 *   phone:<n>    a verified phone. Signup refuses a duplicate number.
 *   device:<id>  the weakest, and only used when there is nothing better.
 *                Two people who genuinely share a tablet collapse into one
 *                entrant, which is the wrong answer — but the alternative is
 *                that one person with two accounts gets two entries, and of
 *                the two mistakes this is the one that does not hand out a
 *                trip.
 *   member:<id>  no evidence at all. Their own row, so they still enter.
 */
export function identityKey(member) {
  if (!member) return null;
  const five = five5arzId(member);
  if (five) return '5arz:' + five;
  if (Number(member.phone_verified) === 1 && member.phone) return 'phone:' + member.phone;
  if (member.device_id) return 'device:' + member.device_id;
  return 'member:' + member.id;
}

/** The 5arz id Num recorded when this member consented, or null. Mirrors
 *  linked5arzId in worker/air.mjs — never parsed from a request. */
export function five5arzId(row) {
  if (!row?.bio) return null;
  try {
    const bio = typeof row.bio === 'string' ? JSON.parse(row.bio) : row.bio;
    const id = bio?.['5arz_id'];
    return typeof id === 'string' && id ? id : null;
  } catch { return null; }
}

/** Is this person verified well enough to be handed a prize? */
export const canClaim = (member) =>
  Number(member?.identity_verified) === 1 && Boolean(five5arzId(member));
