// The rooms NUM has actually booked for you, and the way out of one.
//
// ── WHY THIS IS IN THE WALLET ────────────────────────────────────────────
//
// A confirmation code is worth nothing in a thread you have scrolled past. It
// is needed at a front desk, at midnight, on a phone with one bar, by somebody
// who is not going to search a conversation for it. The wallet is the screen
// people already open when they want to know what they have.
//
// ── MOUNTED ONLY WHILE THE SHEET IS OPEN ─────────────────────────────────
//
// Carried over from MembershipCard, and the comment there explains why: the
// wallet sheet never unmounts, it hides with `visibility: hidden`. An
// unguarded fetch here would ask for every member's stays on EVERY app load,
// including the nine in ten where nobody opens the wallet — against a rate
// limiter that already answers 429 under light load.
//
// ── THE CANCEL IS TWO TAPS, AND NOT A DIALOG ─────────────────────────────
//
// A browser confirm() blocks the whole page and cannot be styled or read by a
// screen reader properly. And a single-tap cancel on a non-refundable room is
// somebody's money gone. So the button asks once, in place, and says what will
// actually happen — including, when the room is non-refundable, that cancelling
// does not get the money back.
import { useEffect, useState } from 'react';
import { useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { cancelStay, myStays } from '../../lib/stays';
import type { StayReceipt } from '../../lib/stays';
import { t } from '../../lib/i18n';

const label: React.CSSProperties = {
  fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--color-neutral-600)',
};
const quiet: React.CSSProperties = { fontSize: 10.5, color: 'var(--color-neutral-600)', lineHeight: 1.5 };

const money = (n: number | null, ccy: string | null) =>
  n == null ? '—' : `${ccy === 'USD' ? '$' : ccy === 'GBP' ? '£' : ccy === 'EUR' ? '€' : ''}${n.toFixed(2)}${ccy && !['USD', 'GBP', 'EUR'].includes(ccy) ? ` ${ccy}` : ''}`;

const day = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(String(iso).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** Free to cancel only while the deadline is still ahead. */
const stillFree = (r: StayReceipt, now = Date.now()) => {
  if (!r.refundable || !r.cancelBy) return false;
  const by = Date.parse(String(r.cancelBy).replace(' ', 'T'));
  return Number.isFinite(by) && by > now;
};

export default function StaysCard() {
  const me = useApp((s) => s.me);
  const [rows, setRows] = useState<StayReceipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const out = await myStays(me);
        if (live) setRows(out);
      } catch (err) {
        // Said out loud rather than rendered as an empty list. "You have no
        // bookings" to somebody who has one is worse than an error.
        if (live) setError((err as Error).message);
      }
    })();
    return () => { live = false; };
  }, [me]);

  const doCancel = async (r: StayReceipt) => {
    setBusy(r.id);
    setError(null);
    try {
      await cancelStay(me, r.id);
      setRows((prev) => (prev ?? []).map((x) => (x.id === r.id ? { ...x, status: 'cancelled' } : x)));
      setAsking(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Loading is NOT the same as empty. Returning null while the fetch is in
  // flight makes the card appear from nowhere and shove the rest of the wallet
  // down — so a placeholder holds the space it is about to need.
  if (!error && rows === null) {
    return (
      <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--ink-08)' }}>
        <div style={label}>{t('YOUR STAYS')}</div>
        <div className="skel" style={{ height: 13, width: '62%', marginTop: 9 }} />
        <div className="skel" style={{ height: 11, width: '42%', marginTop: 7 }} />
      </div>
    );
  }

  // Nothing to show and nothing wrong: stay out of the way entirely rather
  // than render an empty heading at somebody who has never booked a room.
  if (!error && (rows?.length ?? 0) === 0) return null;

  return (
    <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--ink-08)' }}>
      <div style={label}>{t('YOUR STAYS')}</div>

      {error && <div style={{ ...quiet, color: 'var(--color-danger, #b3261e)', marginTop: 6 }}>{error}</div>}

      {(rows ?? []).map((r, i) => {
        const cancelled = r.status === 'cancelled';
        const free = stillFree(r);
        return (
          <div key={r.id} className="rise-in" style={{
            marginTop: 12, opacity: cancelled ? 0.5 : 1,
            animationDelay: `${i * 45}ms`,
            transition: 'opacity .2s ease',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
              <div style={{ fontWeight: 700, fontSize: 13, minWidth: 0 }}>{r.hotel}</div>
              <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap' }}>{money(r.total, r.currency)}</div>
            </div>

            <div style={{ ...quiet, marginTop: 2 }}>
              {day(r.checkin)} → {day(r.checkout)}
              {r.room ? ` · ${r.room}` : ''}
              {cancelled ? ` · ${t('cancelled')}` : r.status === 'held' ? ` · ${t('not confirmed yet')}` : ''}
            </div>

            {/* The code is the reason this card exists. Big enough to read out
                loud across a desk. */}
            {!cancelled && r.confirmationCode && (
              <div style={{
                marginTop: 6, display: 'inline-block', borderRadius: 10,
                padding: '5px 10px', background: 'var(--ink-04)', border: '1px solid var(--ink-08)',
                fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15, letterSpacing: '.05em',
              }}>
                {r.confirmationCode}
              </div>
            )}

            {!cancelled && r.payAtHotel ? (
              <div style={quiet}>{t('{amount} is paid at the hotel', { amount: money(r.payAtHotel, r.currency) })}</div>
            ) : null}

            {!cancelled && r.status === 'confirmed' && (
              asking === r.id ? (
                <div style={{ marginTop: 6 }}>
                  <div style={{ ...quiet, color: 'var(--color-text)' }}>
                    {free
                      ? t('Cancel this room? It is free to cancel until {date}.', { date: day(r.cancelBy) ?? '' })
                      : t('Cancel this room? It is past the free-cancellation date, so this will not get the money back.')}
                  </div>
                  <div style={{ display: 'flex', gap: 14, marginTop: 6 }}>
                    <div {...pressable(() => { void doCancel(r); })} className="tap"
                      style={{
                        cursor: 'pointer', fontSize: 11, fontWeight: 800, letterSpacing: '.03em',
                        color: 'var(--color-danger, #b3261e)', borderRadius: 999, padding: '7px 12px',
                        border: '1px solid color-mix(in srgb, var(--color-danger, #b3261e) 32%, transparent)',
                      }}>
                      {busy === r.id ? t('Cancelling…') : t('Yes, cancel it')}
                    </div>
                    {/* "Keep it" is the safe choice, so it is the quiet one —
                        a destructive pair where both sides shout is a pair
                        somebody taps wrong at midnight. */}
                    <div {...pressable(() => setAsking(null))} className="tap"
                      style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--ink-60)', padding: '7px 4px' }}>
                      {t('Keep it')}
                    </div>
                  </div>
                </div>
              ) : (
                <div {...pressable(() => setAsking(r.id))}
                  style={{ marginTop: 5, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--ink-60)' }}>
                  {free ? t('Cancel — free until {date}', { date: day(r.cancelBy) ?? '' }) : t('Cancel this room')}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
