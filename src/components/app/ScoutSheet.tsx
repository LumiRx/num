// What a scout sees after a day on the street.
//
// Built around one refusal: this sheet does not add anything up. Every figure
// comes from the server, and the money shown is what has actually been earned
// — not the number of businesses times the finder fee. A scout who walks Sunset
// signing up eleven shops has eleven introductions and, quite possibly, zero
// dollars, and the honest version of that screen is the one that keeps them.
//
// So the states are shown separately and each carries the server's own
// sentence explaining what it means. "Introduced" and "earning" are different
// words on purpose.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { XIcon } from '../../lib/icons';
import { scoutDashboard, money, pct } from '../../lib/scout';
import type { ScoutDashboard, ScoutState } from '../../lib/scout';

const label: React.CSSProperties = {
  fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700,
};
const card: React.CSSProperties = {
  borderRadius: 14, padding: 13, marginTop: 10, border: '1px solid var(--ink-08)',
};
const muted: React.CSSProperties = { fontSize: 11.5, color: 'var(--ink-55)', lineHeight: 1.5 };

/** The order a scout cares about, not alphabetical. */
const ORDER: ScoutState[] = ['activated', 'verified', 'introduced', 'rejected', 'void'];
const TITLE: Record<ScoutState, string> = {
  activated: 'Earning',
  verified: 'Confirmed',
  introduced: 'Introduced',
  rejected: 'Not accepted',
  void: 'Reversed',
};

export default function ScoutSheet() {
  const open = useApp((s) => s.scoutOpen);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  const [data, setData] = useState<ScoutDashboard | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || !me) return;
    setLoaded(false);
    void scoutDashboard(me.id).then((d) => { setData(d); setLoaded(true); });
  }, [open, me?.id]);

  if (!open) return null;
  const close = () => store.set({ scoutOpen: false });

  return (
    <div
      ref={ref}
      className="glass-strong"
      style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(88%, calc(100% - var(--sat, 0px) - 8px))', overflowY: 'auto' }}
    >
      <div style={grabberStyle} />
      <div
        {...pressable(close)}
        aria-label="Close"
        className="glass press"
        style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>

      <div style={{ padding: 16 }}>
        <div style={label}>NUM EXPERT</div>

        {!loaded && <div style={{ ...muted, marginTop: 12 }}>Loading your round…</div>}

        {loaded && !data && (
          <>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>
              Become a NUM Expert
            </div>
            <div style={{ ...muted, marginTop: 8 }}>
              You are not a NUM Expert yet. Experts get a code and a card: tap it at the counter,
              the business signs up against your name, and you earn once they start producing.
            </div>
            <a
              href="/scout"
              className="glass lift"
              style={{ ...card, display: 'block', textDecoration: 'none', color: 'inherit', textAlign: 'center', fontWeight: 700, fontSize: 13 }}
            >
              Become a NUM Expert
            </a>
          </>
        )}

        {loaded && data && (
          <>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>
              {data.scout.name}
            </div>
            <div style={{ ...muted, marginTop: 2 }}>
              Your code is <b style={{ letterSpacing: '.12em', fontSize: 13 }}>{data.scout.code}</b> — it is on your card.
            </div>

            {/* Money first, because it is what they opened this for — and it is
                the server's earned figure, never a sum of introductions. */}
            <div className="glass" style={card}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 26, color: 'var(--money, var(--color-accent))' }}>
                  {money(data.money.accrued_minor + data.money.payable_minor + data.money.paid_minor)}
                </div>
                <div style={{ ...muted, flex: 1 }}>earned so far</div>
              </div>
              <div style={{ ...muted, marginTop: 8 }}>{data.money.note}</div>
              {data.money.paid_minor > 0 && (
                <div style={{ ...muted, marginTop: 4 }}>{money(data.money.paid_minor)} already paid out.</div>
              )}
            </div>

            <div className="glass" style={card}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Your businesses</div>
              {ORDER.map((st) => {
                const n = data.businesses.byState?.[st] ?? 0;
                if (!n) return null;
                return (
                  <div key={st} style={{ marginTop: 9 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <b style={{ fontSize: 15 }}>{n}</b>
                      <span style={{ fontSize: 12.5 }}>{TITLE[st]}</span>
                    </div>
                    <div style={muted}>{data.businesses.meaning?.[st]}</div>
                  </div>
                );
              })}
              {!data.businesses.total && (
                <div style={{ ...muted, marginTop: 8 }}>
                  Nothing yet. Tap your card at a counter, or add one from the web dashboard.
                </div>
              )}
            </div>

            <div className="glass" style={card}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Friends you brought</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 6 }}>
                <b style={{ fontSize: 15 }}>{data.friends.count}</b>
                <span style={{ fontSize: 12.5 }}>joined NUM through you</span>
              </div>
              {data.friends.note && <div style={{ ...muted, marginTop: 4 }}>{data.friends.note}</div>}
            </div>

            <div className="glass" style={card}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Your terms</div>
              <div style={{ ...muted, marginTop: 6 }}>
                {money(data.terms.finder_cents)} per business, released once they have produced{' '}
                {money(data.terms.finder_gate_minor)} to NUM. Then {pct(data.terms.share_bps)} of what NUM
                earns on their bookings and {pct(data.terms.sub_share_bps)} of their subscription, for{' '}
                {data.terms.term_months} months.
              </div>
              <div style={{ ...muted, marginTop: 6 }}>{data.terms.note}</div>
            </div>

            <div style={{ ...muted, marginTop: 12 }}>
              {data.cap.left} of this month&rsquo;s {data.cap.monthly} introductions left.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
