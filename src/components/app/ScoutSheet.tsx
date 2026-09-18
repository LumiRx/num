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
import { t } from '../../lib/i18n';

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
      className="glass-strong sheet-in"
      style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(88%, calc(100% - var(--sat, 0px) - 8px))', overflowY: 'auto' }}
    >
      <div style={grabberStyle} />
      <div
        {...pressable(close)}
        aria-label={t('Close')}
        className="glass press"
        style={{ position: 'absolute', top: 6, right: 6, width: 44, height: 44, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>

      <div style={{ padding: 16 }}>
        <div style={label}>{t('NUM EXPERT')}</div>

        {!loaded && <div style={{ ...muted, marginTop: 12 }}>{t('Loading your round…')}</div>}

        {loaded && !data && (
          <>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>{t('Become a NUM Expert')}</div>
            <div style={{ ...muted, marginTop: 8 }}>{t('You are not a NUM Expert yet. Experts get a code and a card: tap it at the counter, the business signs up against your name, and you earn once they start producing.')}</div>
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
            <div style={{ ...muted, marginTop: 2 }}>{t('Your code is')}{' '}<b style={{ letterSpacing: '.12em', fontSize: 13 }}>{data.scout.code}</b>{' '}{t('— it is on your card.')}</div>

            {/* Money first, because it is what they opened this for — and it is
                the server's earned figure, never a sum of introductions. */}
            <div className="glass" style={card}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 26, color: 'var(--money, var(--color-accent))' }}>
                  {money(data.money.accrued_minor + data.money.payable_minor + data.money.paid_minor)}
                </div>
                <div style={{ ...muted, flex: 1 }}>{t('earned so far')}</div>
              </div>
              <div style={{ ...muted, marginTop: 8 }}>{data.money.note}</div>
              {data.money.paid_minor > 0 && (
                <div style={{ ...muted, marginTop: 4 }}>{money(data.money.paid_minor)} already paid out.</div>
              )}
              {/* Why it cannot move yet, beside the number rather than in a
                  FAQ. Without this line "earned so far" quietly reads as
                  "arriving Friday", and the week it does not arrive is the
                  week somebody stops walking. */}
              {data.money.blocked && (
                <div style={{ ...muted, marginTop: 6, color: 'var(--color-accent)' }}>{data.money.blocked}</div>
              )}
            </div>

            {/* What is next. The gate comes first because it is the only thing
                on this sheet that names something to go and do today — and it
                counts revenue a venue actually produced, not signatures. */}
            {data.milestones && (
              <div className="glass" style={card}>
                {data.milestones.gate && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={muted}>{t('Closest to paying you')}</div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15, marginTop: 2 }}>
                      {data.milestones.gate.biz_name}
                    </div>
                    <div style={{ ...muted, marginTop: 2 }}>
                      {money(data.milestones.gate.needs_minor)}{' '}{t('more from them releases your')}{' '}
                      {money(data.milestones.gate.releases_minor)}.
                    </div>
                  </div>
                )}

                {data.milestones.next && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{data.milestones.next.label}</div>
                      <div style={muted}>
                        {data.milestones.next.have} / {data.milestones.next.need}
                      </div>
                    </div>
                    <div style={{ height: 6, borderRadius: 999, background: 'var(--ink-08)', marginTop: 8, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${Math.round((data.milestones.next.have / data.milestones.next.need) * 100)}%`,
                        background: 'var(--color-accent)', borderRadius: 999,
                      }}
                      />
                    </div>
                    <div style={{ ...muted, marginTop: 8 }}>
                      {data.milestones.next.note}
                      {/* A bonus is named only when there is one. "$0.00"
                          beside a milestone reads as a broken promise. */}
                      {data.milestones.next.bonus_cents > 0
                        && ` Worth ${money(data.milestones.next.bonus_cents)}.`}
                    </div>
                  </>
                )}

                {data.milestones.reached.length > 0 && (
                  <div style={{ marginTop: 12, borderTop: '1px solid var(--ink-08)', paddingTop: 10 }}>
                    {data.milestones.reached.map((m) => (
                      <div key={m.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 0' }}>
                        <span style={{ fontSize: 12.5 }}>✓ {m.label}</span>
                        {m.bonus_cents > 0 && <span style={muted}>{money(m.bonus_cents)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="glass" style={card}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{t('Your businesses')}</div>
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
                <div style={{ ...muted, marginTop: 8 }}>{t('Nothing yet. Tap your card at a counter, or add one from the web dashboard.')}</div>
              )}
            </div>

            <div className="glass" style={card}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{t('Friends you brought')}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 6 }}>
                <b style={{ fontSize: 15 }}>{data.friends.count}</b>
                <span style={{ fontSize: 12.5 }}>{t('joined NUM through you')}</span>
              </div>
              {data.friends.note && <div style={{ ...muted, marginTop: 4 }}>{data.friends.note}</div>}
            </div>

            <div className="glass" style={card}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{t('Your terms')}</div>
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
