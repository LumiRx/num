/**
 * WHO ANSWERED, KEPT HONEST ACROSS THE CORRECTIVE RETRIES.
 *
 * The /api/num handler can replace a model's answer twice after the brain
 * chain has already picked a winner: once when the output guard catches
 * leaked JSON, once when the quality grader catches an invented price or a
 * deflection. Both retries call the structured Claude path DIRECTLY
 * (`callNum`), bypassing the brain chain — so what comes back carries no
 * `_brain`, `_tried` or `_degraded`.
 *
 * Spreading that over the result erased the routing record of the whole
 * turn. The lane column became `<tier>:none`, `brain` went NULL and
 * logUsage priced the turn at `undefined`. Between 1 and 3 Sep 2026 that
 * was 12 of 41 asks — every one a healthy answer from a healthy brain,
 * filed as though nothing had answered at all. That is the shape of the
 * "the brain is down" report: not an outage, a label that lied.
 *
 * The rule these functions encode:
 *   - a reply that came from a model is attributed to the model that
 *     produced THE TEXT WE SHIPPED, at the price it actually cost;
 *   - the chain that got us there (`_tried`) and the brain that answered
 *     first (`_first`) are kept, because "haiku answered, Claude corrected
 *     it" is the fact that tunes the router;
 *   - the hard-coded fallback string is attributed to NOBODY, because
 *     lane `:none` is then the truth and the uptime probe should page.
 */

/** The shipped reply came from a corrective retry on the Claude path. */
export function keepRouting(next, prev = {}) {
  return {
    ...next,
    _brain: 'claude',
    _model: next?._model ?? null,
    _tried: prev._tried,
    _first: prev._brain ?? null,
    // NOT `prev._degraded`. `_degraded` means "this turn needed something we
    // could not do". A corrective retry only returns at all when the
    // structured Claude path answered — the full concierge, cards and
    // actions included — so whatever the chain could not do a moment ago, it
    // just did. Carrying the old flag forward would page the uptime probe
    // (scripts/uptime.mjs treats degraded:true as an outage) for a turn that
    // recovered in front of the guest. What actually happened is recorded in
    // `_first` and `_tried`, where it belongs.
    _degraded: false,
    _retried: true,
  };
}

/** Nothing usable came back. Say so, loudly, in the columns we read. */
export function fallbackRouting(reply, prev = {}) {
  return {
    reply,
    card: null,
    chips: null,
    actions: [],
    _brain: null,
    _model: null,
    _tried: prev._tried,
    _first: prev._brain ?? null,
    _degraded: true,
    _retried: true,
  };
}

/**
 * `<tier>:<brain>`. `none` is reserved for a turn no brain answered — it is
 * an alarm, so nothing that a brain did answer may wear it.
 */
export function laneLabel(directive, result) {
  return `${directive?.tier ?? 'unknown'}:${result?._brain ?? 'none'}`;
}
