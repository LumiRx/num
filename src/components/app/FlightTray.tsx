// The fare tray — live prices, rendered as data rather than prose.
//
//
// (The heading above deliberately does not repeat the label used in the
// markup below: composertray.test.mjs locates that label by searching for
// the literal string, and a second copy in a comment sends it to the wrong
// one. A guard defeated by a comment is a guard that stops being read.)
//
// Lifted out of ThreadView on 20 Sep 2026 so the listing page can show the
// same fares without a second implementation of the booking flow. That flow
// is the reason this is one component and not two: BOOK IT is deliberately
// two taps — the first mints the referral and shows the fee sentence, the
// second opens it — because a single tap would deliver the disclosure to
// somebody already navigating away from it. A copy of this in another file
// is a copy that drifts, and the thing it would drift away from is a
// disclosure.
//
// Nothing about the behaviour changed in the move.
import { useState } from 'react';
import { store, useApp } from '../../lib/store';
import {
  bookHandoff, checkOffer, duration, heldFor, legWindow, offerSummary, stillValid, stopsLabel,
  type BookHandoff, type FlightOffer,
} from '../../lib/flights';
import { openShareCard } from '../../lib/sharecard';
import { pressable } from '../../lib/a11y';
import { isSaved, saveOffer } from '../../lib/savedflights';
import { XIcon } from '../../lib/icons';
import { t } from '../../lib/i18n';

/** A fare card action: tall enough for a thumb, calm enough to sit three abreast. */
const fareBtn: React.CSSProperties = {
  cursor: 'pointer', minHeight: 40, borderRadius: 999, padding: '0 10px', display: 'grid', placeItems: 'center',
  fontSize: 12, fontWeight: 700, letterSpacing: '.02em',
  background: 'var(--field-bg)', border: '1px solid var(--ink-12)', color: 'var(--ink)',
};

/**
 * Live fares, rendered as data.
 *
 * Deliberately NOT prose. Every number here came back from Sabre in this
 * session, and keeping it in its own card is what stops it drifting into the
 * transcript where a later turn might repeat it as though it were still true.
 * The expiry is shown for the same reason — a fare has a shelf life and
 * pretending otherwise is how somebody turns up at a desk with the wrong price.
 */
export default function FlightTray() {
  const state = useApp((s) => s.flightOffers);
  // Subscribed so a Save repaints the button it was pressed on.
  useApp((s) => s.savedFlights.length);
  const busy = useApp((s) => s.flightSearching);
  const error = useApp((s) => s.flightError);
  const [checking, setChecking] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Record<string, string>>({});
  const [handoff, setHandoff] = useState<Record<string, BookHandoff>>({});
  const [opening, setOpening] = useState<string | null>(null);

  if (busy) {
    return (
      <div className="glass" style={{ margin: '0 2px 10px', borderRadius: 'var(--r-md)', padding: '11px 12px', fontSize: 12, color: 'var(--ink-60)' }}>{t('Checking live fares…')}</div>
    );
  }
  if (error && !state) {
    return (
      <div className="glass" style={{ margin: '0 2px 10px', borderRadius: 'var(--r-md)', padding: '11px 12px', fontSize: 12, color: 'var(--ink-60)' }}>
        {error}
      </div>
    );
  }
  if (!state?.offers.length) return null;

  const recheck = async (o: FlightOffer) => {
    setChecking(o.id);
    const out = await checkOffer(o, state.query);
    setVerdict((v) => ({ ...v, [o.id]: out.message }));
    setChecking(null);
  };

  /**
   * BOOK IT is two taps on purpose.
   *
   * The first tap asks the server for the link and shows the fee sentence.
   * The second one opens it. A single tap that both minted a referral and
   * threw the traveller onto another company's checkout would mean the fee
   * disclosure arrives after they have already left — which is the one
   * failure the whole disclosure design exists to prevent. Nobody reads a
   * sentence on a page they are navigating away from.
   */
  const startBooking = async (o: FlightOffer) => {
    if (handoff[o.id]) return;
    setOpening(o.id);
    const out = await bookHandoff(o, state.query);
    setHandoff((h) => ({ ...h, [o.id]: out }));
    setOpening(null);
  };

  const shareOffer = (o: FlightOffer) => {
    const seg = o.legs[0]?.segments ?? [];
    openShareCard({
      kind: 'flight',
      title: `${state.query.fromCode} → ${state.query.toCode} · ${o.currency ?? ''} ${o.price ?? ''}`.trim(),
      summary: offerSummary(o, state.query),
      day: seg[0]?.departs.slice(0, 10) ?? state.query.depart,
      cost: o.price ? `${o.currency ?? ''} ${o.price}`.trim() : null,
    });
  };

  return (
    /**
     * ── WHY THIS BOX IS CAPPED AND SCROLLS ITSELF ────────────────────────
     *
     * 13 Sep 2026: "we had someone looking at flights and the screen got
     * stuck scrolling." This is the thing that stuck it.
     *
     * The tray lives inside the composer bar, and that bar is `flex: 'none'`
     * — deliberately, so its height does not jump while you type. But an
     * uncapped list of fares inside a box that cannot shrink, inside a shell
     * that is `height: 100%; overflow: hidden`, has only one outcome: five
     * offers at roughly a hundred pixels each push the bar past the bottom of
     * the phone. The thread above it collapses, the lower offers are clipped
     * off-screen, and on a short device the text input goes with them.
     *
     * And nothing could scroll to reach them. The shell is `overflow: hidden`
     * and clamps its own scrollTop to 0 (holdFrame in ConciergeApp), the bar
     * is not a scroll container, and neither was this. The screen was, quite
     * literally, stuck.
     *
     * The cap is in `vh` rather than pixels because the failure is a
     * proportion of the screen, not a number of offers — the same six fares
     * are fine on a tablet and fatal on an iPhone SE.
     *
     * The two caps live together in app.css as --tray-max-flight and
     * --tray-max-service, and their SUM is the number that matters: both
     * trays can be open at once, and what must survive that is the text
     * input. See the budget written beside them.
     */
    <div
      className="glass"
      style={{
        margin: '0 2px 10px', borderRadius: 'var(--r-md)', padding: '11px 12px',
        maxHeight: 'var(--tray-max-flight)', overflowY: 'auto',
        overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
      }}
    >
      {/* 18 Sep 2026: this tray had no way to close. A guest who had seen
          the fares kept them pinned above the keyboard until they searched
          something else. The X clears the tray; anything they wanted to
          keep is a Save away and lives on the Flights page. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>
          {t('LIVE FARES')} · {state.query.fromCode} → {state.query.toCode}
        </div>
        <div
          {...pressable(() => store.set({ flightOffers: null }))}
          aria-label={t('Close fares')}
          className="press tap"
          style={{ cursor: 'pointer', width: 30, height: 30, borderRadius: 999, display: 'grid', placeItems: 'center', background: 'var(--field-bg)', border: '1px solid var(--ink-08)', flex: 'none' }}
        >
          <XIcon size={12} />
        </div>
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
        {state.offers.map((o) => {
          const leg = o.legs[0];
          const hops = leg ? [leg.segments[0]?.from, ...leg.segments.map((sg) => sg.to)].filter(Boolean).join(' → ') : '';
          const hidden = o.legs.flatMap((l) => l.segments).flatMap((sg) => sg.hiddenStops ?? []);
          const dead = !stillValid(o);
          const held = heldFor(o.validUntil);
          const window = legWindow(leg);
          const hop = handoff[o.id];
          return (
            <div key={o.id} style={{ borderRadius: 14, border: '1px solid var(--ink-08)', padding: '12px 13px', opacity: dead ? 0.5 : 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                {/* THE NUMBER THEY PAY, in the money colour. On a fare list
                    this is the only thing anyone is comparing, and until now
                    it was the same ink as the aircraft type. */}
                <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--money)', letterSpacing: '-.01em' }}>
                  {o.currency} {o.price}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-40)' }}>
                  {o.validatingCarrier} · {stopsLabel(leg?.stops)} · {duration(o.totalDurationInMinutes)}
                </div>
              </div>
              {/* DEPARTURE AND ARRIVAL, with the day it lands.
                  13 Sep 2026: this card used to print "B63677 17:59" for a
                  LAX→JFK that lands at 05:40 the NEXT MORNING, and nothing
                  else. A traveller had no way to know the evening they
                  thought they were keeping was already gone. The +1 is the
                  single most important thing on the row after the price. */}
              {window && (
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', marginTop: 4 }}>
                  {window.replace(/ \+(\d)$/, '')}
                  {/\+\d$/.test(window) && (
                    <span style={{ color: 'var(--color-accent-700)', fontWeight: 800, marginLeft: 5 }}>
                      {window.slice(window.lastIndexOf('+'))} day{window.endsWith('+1') ? '' : 's'}
                    </span>
                  )}
                </div>
              )}
              <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 3 }}>{hops}</div>
              <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 2 }}>
                {leg?.segments.map((sg) => `${sg.marketing} ${sg.departs.slice(11, 16)}`).join(' · ')}
                {leg?.segments[0]?.cabin ? ` · ${leg.segments[0].cabin}` : ''}
              </div>
              {/* A stop the airline does not advertise is the thing travellers
                  find out about at the gate. Always said out loud. */}
              {hidden.length > 0 && (
                <div style={{ fontSize: 10.5, color: 'var(--color-accent-700)', fontWeight: 700, marginTop: 3 }}>
                  Unadvertised stop at {hidden.map((h) => h.airportCode).join(', ')}
                </div>
              )}
              {/* Why a dead card is grey. Without this the traveller sees a
                  faded row and assumes the app is broken. */}
              {held && (
                <div style={{ fontSize: 10.5, color: dead ? 'var(--color-accent-700)' : 'var(--ink-40)', marginTop: 3 }}>
                  {dead ? 'This price has expired — ask me to search again.' : `Held at this price for ${held}`}
                </div>
              )}
              {verdict[o.id] && <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.45 }}>{verdict[o.id]}</div>}

              {/* The fee sentence, before the link and never after it. */}
              {hop?.available && hop.disclosure && (
                <div
                  style={{
                    fontSize: 10.5, color: 'var(--ink-60)', lineHeight: 1.5, marginTop: 7,
                    borderRadius: 10, background: 'var(--money-soft)', padding: '7px 9px',
                  }}
                >
                  {hop.disclosure}
                </div>
              )}
              {hop && !hop.available && hop.why && (
                <div style={{ fontSize: 10.5, color: 'var(--ink-60)', marginTop: 6, lineHeight: 1.5 }}>{hop.why}</div>
              )}

              {/* Three equal buttons with room to be tapped. 18 Sep 2026:
                  these were 10.5px capitals in pills with no height of their
                  own — "squished" was the word. Save is new: the fare goes to
                  the Flights page so it never has to be searched for twice. */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 10 }}>
                <div
                  {...pressable(() => void recheck(o))}
                  className="press tap"
                  style={{ ...fareBtn, opacity: checking === o.id ? 0.55 : 1 }}
                >
                  {checking === o.id ? t('Checking…') : t('Still live?')}
                </div>
                <div
                  {...pressable(() => (isSaved(o, state.query) ? null : saveOffer(o, state.query)))}
                  className="press tap"
                  aria-pressed={isSaved(o, state.query)}
                  style={{ ...fareBtn, ...(isSaved(o, state.query) ? { background: 'var(--grad-accent)', color: '#fff', border: '1px solid transparent' } : {}) }}
                >
                  {isSaved(o, state.query) ? t('Saved ✓') : t('Save')}
                </div>
                <div
                  {...pressable(() => shareOffer(o))}
                  className="press tap"
                  aria-label={t('Send this fare to someone')}
                  style={fareBtn}
                >
                  {t('Share')}
                </div>
              </div>

              {/* BOOK IT. Absent entirely when the fare has expired — a
                  checkout opened from a dead price is a complaint waiting to
                  happen. Two taps: the first fetches the link and shows the
                  fee, the second leaves the app. */}
              {!dead && (
                hop?.available && hop.url ? (
                  <a
                    href={hop.url}
                    target="_blank"
                    rel="noreferrer"
                    className="press tap"
                    style={{
                      display: 'grid', placeItems: 'center', minHeight: 40, marginTop: 8, borderRadius: 999, padding: '0 12px', textDecoration: 'none',
                      fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em',
                      background: 'var(--grad-accent)', color: '#fff',
                    }}
                  >
                    CONTINUE TO {String(hop.partner ?? 'the partner').toUpperCase()} →
                  </a>
                ) : hop ? null : (
                  <div
                    {...pressable(() => void startBooking(o))}
                    className="press tap"
                    style={{
                      cursor: 'pointer', minHeight: 40, display: 'grid', placeItems: 'center', marginTop: 8, borderRadius: 999, padding: '0 12px', textAlign: 'center',
                      fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em',
                      background: 'var(--money)', color: '#fff',
                      opacity: opening === o.id ? 0.55 : 1,
                    }}
                  >
                    {opening === o.id ? 'ONE MOMENT…' : 'SEE THE FULL PRICE'}
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 8, lineHeight: 1.5 }}>
        Real fares from Sabre. NUM prices and re-checks them; the ticket is issued by whoever you continue to.
      </div>
    </div>
  );
}
