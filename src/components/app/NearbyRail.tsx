// One rail, any feed.
//
// TONIGHT, EAT NEARBY and DRINKS NEARBY are the same object three times: a
// heading, a count, and a row of cards that slides. Writing it once means a
// fourth rail — experiences, markets, whatever /api/discover grows next — is
// a line in a list rather than another component to keep in step.
//
// THREE AT A TIME, AND NOTHING WRITTEN ON THE PICTURE (18 Sep 2026).
// The first version showed 2.2 cards of 172px with the countdown and the
// distance floated over the poster, and both were unreadable against a busy
// photo. Now the row is exactly three cards wide, whatever the phone, and
// every fact sits under the image in plain text where it can be read. The
// row snaps by the page, so sliding left brings the next three, not the next
// two and a half.
import { pressable } from '../../lib/a11y';
import { t } from '../../lib/i18n';

export interface RailItem {
  id: string;
  title: string;
  /** The line under the title: a venue, a cuisine, an area. */
  sub: string | null;
  image: string | null;
  /** "Doors in 1h 42m", "On now", "Open now" — the one timing fact, in words. */
  when?: string | null;
  distance_km?: number | null;
  rating?: number | null;
  /** Where it came from: shown as a small mark, never as a headline. */
  source: 'num' | 'ticketmaster';
  /** A link that leaves NUM (tickets). When absent the card asks NUM instead. */
  url?: string | null;
  price?: string | null;
}

/** 400 m / 1.2 km — the unit a person would say out loud. */
export const near = (km: number | null | undefined): string | null =>
  km == null ? null : km < 1 ? `${Math.round(km * 1000)} m` : `${Math.round(km * 10) / 10} km`;

const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 };

/**
 * Where it came from. Ticketmaster asks for attribution on every listing, and
 * a stamp beside the venue is attribution; NUM's own rows get the check.
 */
function SourceMark({ source }: { source: RailItem['source'] }) {
  const base: React.CSSProperties = {
    flex: 'none', borderRadius: 999, padding: '2px 5px', fontSize: 7.5, fontWeight: 800, letterSpacing: '.02em',
    display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--ink-40)', background: 'var(--field-bg)', border: '1px solid var(--ink-12)',
  };
  if (source === 'ticketmaster') {
    return (
      <span style={base} aria-label="Listed on Ticketmaster">
        <svg width="8" height="8" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2.2a1.8 1.8 0 0 0 0 3.6V14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2.2a1.8 1.8 0 0 0 0-3.6Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M8 5v10" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.5 1.5" />
        </svg>
        ticketmaster
      </span>
    );
  }
  return (
    <span style={{ ...base, color: 'var(--color-accent)' }} aria-label="Checked by NUM">
      <svg width="8" height="8" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4 10.5 8.2 14.5 16 6" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      NUM
    </span>
  );
}

export default function NearbyRail({ title, count, items, onOpen, onSend, action = 'Ask NUM', trailing }: {
  /** Already translated — the caller knows whether the place name belongs in it. */
  title: string;
  count?: string | null;
  items: RailItem[];
  /** Tapping the card: the caller decides whether that asks NUM or opens tickets. */
  onOpen: (item: RailItem) => void;
  onSend?: (item: RailItem) => void;
  action?: string;
  /** A control on the heading row — "NEAR ME", a filter, nothing. */
  trailing?: React.ReactNode;
}) {
  if (!items.length) return null;
  return (
    <div style={{ margin: '12px 0 2px' }}>
      <div style={{ ...kicker, padding: '0 14px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {trailing ?? (count ? <span style={{ color: 'var(--color-accent)', flex: 'none' }}>{count}</span> : null)}
      </div>
      {/* Three across, page by page. `basis` is a third of the row minus the
          gaps, so the third card ends exactly at the edge and the fourth is
          the first thing a slide brings in. */}
      <div
        className="no-scrollbar"
        style={{
          display: 'flex', gap: 8, overflowX: 'auto', padding: '0 12px 8px',
          scrollSnapType: 'x mandatory', scrollPaddingLeft: 12,
        }}
      >
        {items.map((i, n) => {
          const meta = [i.when, near(i.distance_km), i.price].filter(Boolean).join(' · ');
          return (
            <div
              key={i.id}
              className="glass lift rise-in"
              style={{
                flex: '0 0 calc((100% - 16px) / 3)', minWidth: 0, scrollSnapAlign: 'start',
                borderRadius: 16, overflow: 'hidden', animationDelay: `${Math.min(n, 5) * 50}ms`,
                display: 'flex', flexDirection: 'column',
              }}
            >
              <div
                {...pressable(() => onOpen(i))}
                className="tap"
                style={{
                  cursor: 'pointer', aspectRatio: '1 / 1', width: '100%',
                  background: i.image
                    ? `url(${i.image}) center/cover`
                    : 'linear-gradient(135deg, var(--color-accent-300, #9fe3cf), var(--field-bg))',
                }}
                aria-label={i.title}
              />
              <div style={{ padding: '7px 8px 8px', display: 'grid', gap: 3, minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 11.5, lineHeight: 1.2,
                  overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                }}>{i.title}</div>
                {meta && (
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-accent)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {meta}
                  </div>
                )}
                <div style={{ fontSize: 9.5, color: 'var(--ink-40)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {i.sub}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <SourceMark source={i.source} />
                  {i.rating != null && (
                    <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--ink-60)', fontVariantNumeric: 'tabular-nums' }}>★ {i.rating}</span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: onSend ? '1fr auto' : '1fr', gap: 4, marginTop: 4 }}>
                  <div
                    {...pressable(() => onOpen(i))}
                    className="tap press glow"
                    style={{ cursor: 'pointer', textAlign: 'center', borderRadius: 9, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 10, padding: '6px 2px' }}
                  >
                    {i.url ? t('Tickets') : t(action)}
                  </div>
                  {onSend && (
                    <div
                      {...pressable(() => onSend(i))}
                      aria-label={t('Send')}
                      className="tap glass press"
                      style={{ cursor: 'pointer', textAlign: 'center', borderRadius: 9, fontWeight: 700, fontSize: 10, padding: '6px 7px' }}
                    >
                      <svg width="11" height="11" viewBox="0 0 20 20" aria-hidden="true" style={{ display: 'block' }}>
                        <path d="M18 2 9 11M18 2l-6 16-3-7-7-3Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                      </svg>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
