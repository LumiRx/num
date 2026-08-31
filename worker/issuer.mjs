// Who actually puts a ticket in somebody's hand.
//
// ── THE SEAM ─────────────────────────────────────────────────────────────
//
// Everything else about a flight booking — the fields, the six-month
// passport check, the confirmation email, the SMS — is the same whoever
// issues. Only this file knows the difference, so only this file has to
// change when LetsGo2Trip's booking API arrives, or when the merchant-of-
// record decision on Duffel is finally made.
//
// ── AND THE REASON IT IS NOT JUST A FUNCTION ─────────────────────────────
//
// There is a simulator in here, and a simulator that can be mistaken for a
// real issuer is the most dangerous object in this codebase. A simulated PNR
// looks exactly like a real one: six characters, right shape, prints fine on
// a confirmation email. If one ever reached a traveller they would go to an
// airport with a booking reference that does not exist.
//
// So `real` is a property of the issuer, not a setting:
//
//   canIssue(env)    → is there an issuer that ISSUES REAL TICKETS?
//   canSimulate(env) → is there any issuer at all, real or not?
//
// `canIssueFlight` in services.mjs — the thing that decides whether the
// concierge may tell a traveller Num can book — is wired to the first. The
// simulator can never make it true. Setting FLIGHT_ISSUER=simulated runs the
// whole pipeline end to end for a demo or a test and leaves the concierge
// saying exactly what it says today: that Num cannot issue.
//
// Every artifact a simulated issue produces is stamped. See `SIM_MARK`.

/** Stamped on every simulated record, in the record itself, not alongside it. */
export const SIM_MARK = 'SIMULATED — NOT A REAL TICKET';

/** A PNR is six letters. Ambiguous glyphs are left out for the same reason
 *  airlines leave them out: these get read down a phone line. */
const PNR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function code(len, rand) {
  let s = '';
  for (let i = 0; i < len; i++) s += PNR_ALPHABET[Math.floor(rand() * PNR_ALPHABET.length)];
  return s;
}

/**
 * A simulated PNR is deliberately NOT in the airline six-character format.
 *
 * It carries a `SIM` prefix so that a reference which escapes into an email,
 * a screenshot or a support conversation is obviously not a booking
 * reference, to a person and to a regex. A simulator whose output is
 * indistinguishable from production is a simulator that will eventually be
 * mistaken for it.
 */
export const SIM_PNR_RE = /^SIM[A-Z0-9]{6}$/;
export const isSimulated = (ref) => SIM_PNR_RE.test(String(ref ?? ''));

/* ── ISSUERS ─────────────────────────────────────────────────────────────
   `real: true` means this issuer puts a flyable ticket in somebody's hand
   and takes their money for it. Nothing else in the codebase may decide
   that question. */
export const ISSUERS = Object.freeze({
  simulated: {
    id: 'simulated',
    label: 'Num simulator (no ticket is issued)',
    real: false,
    ready: () => true,
    /**
     * Runs the whole shape of a real issue — a reference, a ticket number per
     * passenger, a fare breakdown — so every downstream artifact can be built
     * and reviewed. Deterministic when a `rand` is supplied, so tests assert
     * on exact output rather than on "something that looks like a PNR".
     */
    async issue(env, booking, { rand = Math.random, now = () => new Date() } = {}) {
      const ref = `SIM${code(6, rand)}`;
      const at = now().toISOString();
      return {
        ok: true,
        simulated: true,
        note: SIM_MARK,
        reference: ref,
        // An airline PNR would be separate from ours. Simulated, it is
        // stamped too — a bare six-character string in this field is exactly
        // what somebody would copy into an airline website.
        airline_ref: `SIM${code(6, rand)}`,
        issued_at: at,
        tickets: booking.passengers.map((p, i) => ({
          passenger: `${p.given_name} ${p.family_name}`,
          number: `SIM-${String(9000000000 + Math.floor(rand() * 999999999)).slice(0, 13)}-${i + 1}`,
        })),
        price: booking.offer?.price ?? null,
      };
    },
  },

  letsgo2trip: {
    id: 'letsgo2trip',
    label: 'LetsGo2Trip (issues the ticket, takes the payment)',
    real: true,
    // Not ready, and the reason is in the connector registry: they have no
    // booking API that we know of. The email asking for one went out on
    // 30 Aug 2026. `ready` returns false rather than throwing so the roster
    // and the health endpoint can both report it honestly.
    ready: (env) => !!env?.LGT_BOOKING_API && !!env?.LGT_BOOKING_KEY,
    async issue() {
      throw new Error('letsgo2trip: no booking API yet — awaiting their answer of 30 Aug 2026');
    },
  },

  duffel: {
    id: 'duffel',
    label: 'Duffel (technically able to issue; MoR decision outstanding)',
    real: true,
    // The token is not the blocker and never was. Whether Num becomes
    // merchant of record on a ticket is a legal decision — see the §17550
    // note in services.mjs — so this stays closed behind its own flag even
    // when the credential is present.
    ready: (env) => !!env?.DUFFEL_ACCESS_TOKEN && env?.DUFFEL_ISSUING_APPROVED === 'true',
    async issue() {
      throw new Error('duffel: issuing is not approved — DUFFEL_ISSUING_APPROVED is not set');
    },
  },
});

/** The issuer this deployment is configured for, or null. */
export function issuerFor(env) {
  const want = String(env?.FLIGHT_ISSUER || '').trim();
  const i = ISSUERS[want];
  return i && i.ready(env) ? i : null;
}

/**
 * Can Num actually issue a real ticket? This is the question the concierge's
 * wording hangs on, and the simulator must never be able to answer it yes.
 */
export const canIssue = (env) => {
  const i = issuerFor(env);
  return !!i && i.real === true;
};

/** Is there any issuer, real or simulated? For the pipeline, not for copy. */
export const canSimulate = (env) => !!issuerFor(env);

/**
 * Issue.
 *
 * Refuses rather than throws on a booking that is not ready, because the
 * caller most likely to get this wrong is the one under time pressure, and
 * a thrown exception in that path becomes a 500 rather than a sentence.
 */
export async function issue(env, booking, opts = {}) {
  const i = issuerFor(env);
  if (!i) return { ok: false, error: 'no_issuer', message: 'No flight issuer is configured on this deployment.' };
  try {
    const out = await i.issue(env, booking, opts);
    return { ...out, issuer: i.id, real: i.real };
  } catch (e) {
    return { ok: false, error: 'issuer_failed', issuer: i.id, real: i.real, message: String(e?.message ?? e) };
  }
}
