// Empty is not the same as broken, and the whole of 12 Sep 2026 was spent paying
// for that confusion.
//
// `.catch(() => ({ results: [] }))` on a list query is the single most expensive
// habit in this codebase. It turns a schema problem into a blank page and a
// 200 OK. Every instance of it today produced the same symptom — a host looking
// at a card that says "nothing here yet" when the truth is "this query cannot
// run" — and in each case the only evidence was a console line nobody was
// watching:
//
//   · /api/host/requests answered 500 for WEEKS because booking_fee_minor was
//     missing. The POSTs kept working, so "Log it" looked merely unloved.
//   · resolveSupplier selected a column added by an ALTER. Had that ALTER ever
//     been missing, EVERY supplier would have become an unknown sender.
//   · /api/host/suppliers shipped ahead of 0022 and the supplier list swallowed
//     "no such column: phone" into an empty array — a live card, reporting
//     success, that could never show a supplier or accept one.
//
// So: a read that FAILS says so, and says so differently from a read that found
// nothing. 503 and not 500, because the cause is almost always configuration —
// a migration that has not run yet — rather than a bug in the handler, and 503
// is the status the console already hides a card on.
//
// `rows` is the catch for a query whose emptiness is a legitimate answer but
// whose failure is not. Use it instead of `.catch(() => ({ results: [] }))`
// everywhere a missing column would otherwise look like an empty table.

export class ReadFailed extends Error {
  constructor(what, cause) {
    super(`${what}: ${cause?.message ?? cause}`);
    this.name = 'ReadFailed';
    this.what = what;
    this.cause = cause;
  }
}

/**
 * Run a list query. Empty results are fine. A thrown query is not.
 *
 * @param {Promise} q        the .all() promise
 * @param {string}  what     what was being read, for the log and the message
 */
export async function rows(q, what) {
  try {
    const r = await q;
    return (r && r.results) || [];
  } catch (e) {
    // Loud, and named. "no such column: phone" in a log line that also says
    // which read it came from is a two-minute diagnosis; the same error with no
    // context is the afternoon we just spent.
    console.warn(`[read] FAILED ${what}:`, e?.message ?? e);
    throw new ReadFailed(what, e);
  }
}

/**
 * The answer a handler gives when a read could not run.
 *
 * Deliberately names the likely cause. Whoever reads this is either a host who
 * needs to know it is not their fault, or whoever is about to go looking — and
 * "a migration has probably not been applied" saves that person the hour.
 */
export function readFailedResponse(J, e) {
  return J({
    ok: false,
    error: 'read_failed',
    reading: e?.what ?? 'unknown',
    detail: String(e?.cause?.message ?? e?.message ?? '').slice(0, 200),
    says: 'This section cannot load right now. It is not something you did — most often a database change has not been applied yet.',
  }, 503);
}

/** True when the thrown thing is one of ours. */
export const isReadFailed = (e) => e instanceof ReadFailed || e?.name === 'ReadFailed';
