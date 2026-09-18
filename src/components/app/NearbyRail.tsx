// One rail, any feed.
//
// TONIGHT, EAT NEARBY and DRINKS NEARBY are the same object three times: a
// heading, a count, and a row of cards that slides. Writing it once means a
// fourth rail — experiences, markets, whatever /api/discover grows next — is
// a line in a list rather than another component to keep in step.
//
// TWO AT A TIME, AND NOTHING WRITTEN ON THE PICTURE (18 Sep 2026).
// The first version showed 2.2 cards of 172px with the countdown and the
// distance floated over the poster, and both were unreadable against a busy
// photo. Facts moved under the image; the row then went to three across,
// which made every card 108px wide — a poster too small to recognise and a
// title clipped at two lines. Now it is two across, the same width as the
// feature tiles above it, so the whole screen reads in one column rhythm
// instead of three sizes of card. The row snaps by the page, so sliding left
// brings the next two.
import { pressable } from '../../lib/a11y';
import { t } from '../../lib/i18n';
import { near } from '../../lib/near';
import { kindOf } from '../../lib/railkind';
import { atThePlace } from '../../lib/placephoto';

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

/** 400 m / 1.2 km — the unit a person would say out loud. Defined in
 *  lib/near.ts so plain modules can use it; re-exported here because this is
 *  where every caller already imports it from. */
export { near };

const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 };

/** The kind line on a photoless cover, from lib/railkind.ts. */
export { kindOf };

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

export default function NearbyRail({ title, count, items, onOpen, onSend, onPhoto, action = 'Ask NUM', trailing }: {
  /** Already translated — the caller knows whether the place name belongs in it. */
  title: string;
  count?: string | null;
  items: RailItem[];
  /** Tapping the card: the caller decides whether that asks NUM or opens tickets. */
  onOpen: (item: RailItem) => void;
  onSend?: (item: RailItem) => void;
  /** "Add a photo" — shown on a card only when the member is standing at that place (lib/placephoto.ts). */
  onPhoto?: (item: RailItem) => void;
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
      {/* Two across, page by page. `basis` is half the row minus the one gap
          between them, so the second card ends exactly at the edge and the
          third is the first thing a slide brings in. */}
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
                flex: '0 0 calc((100% - 8px) / 2)', minWidth: 0, scrollSnapAlign: 'start',
                borderRadius: 16, overflow: 'hidden', animationDelay: `${Math.min(n, 5) * 50}ms`,
                display: 'flex', flexDirection: 'column',
              }}
            >
              <div
                {...pressable(() => onOpen(i))}
                className="tap"
                style={{
                  cursor: 'pointer', aspectRatio: '1 / 1', width: '100%', position: 'relative', overflow: 'hidden',
                  ...(i.image
                    ? { background: 'var(--field-bg)' }
                    : {
                      // NOT THE ACCENT GRADIENT. A photoless card used to fill
                      // this square with the same green gradient as the button
                      // underneath it, so the card read as two stacked buttons
                      // and people could not tell what they were looking at
                      // ("the buttons are so big... I'm confused what it's
                      // for", 18 Sep). A place with no picture should look
                      // like a place with no picture: quiet panel, its
                      // initial, and what kind of thing it is.
                      background: 'var(--field-bg)',
                      borderBottom: '1px solid var(--ink-08)',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7,
                    }),
                }}
                aria-label={i.title}
              >
                {/* AN <img>, NOT A CSS BACKGROUND (18 Sep 2026). A background
                    image loads the moment the card exists, and a rail has ten
                    cards of which two are on screen — so TONIGHT was pulling
                    thirty posters before anyone had scrolled. loading="lazy"
                    on a real image element waits until the card is near the
                    viewport, which the horizontal scroller reports correctly. */}
                {i.image && (
                  <img
                    src={i.image}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                )}
                {!i.image && (
                  <>
                    <span style={{
                      width: 42, height: 42, borderRadius: 999, border: '1px solid var(--ink-12)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, color: 'var(--ink-40)',
                    }}>
                      {(i.title.trim()[0] ?? '·').toUpperCase()}
                    </span>
                    {kindOf(i) && (
                      <span style={{ fontSize: 9.5, letterSpacing: '.12em', fontWeight: 800, color: 'var(--ink-40)', textAlign: 'center', padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                        {kindOf(i)!.toUpperCase()}
                      </span>
                    )}
                  </>
                )}
                {/* YOU'RE HERE — ADD A PHOTO. Only when the fix says so: a
                    camera on every card would be noise; on the one place you
                    are standing in it is the whole point. 44px tap target;
                    stops the press so it does not also open the card. */}
                {onPhoto && i.source === 'num' && atThePlace(i.distance_km) && (
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={t('Add a photo of {place}', { place: i.title })}
                    className="tap glass press"
                    onClick={(e) => { e.stopPropagation(); onPhoto(i); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onPhoto(i); } }}
                    style={{
                      position: 'absolute', top: 6, right: 6, width: 44, height: 44, borderRadius: 999,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                      color: i.image ? '#fff' : 'var(--ink-60)', background: i.image ? 'rgba(0,0,0,.35)' : undefined,
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.7l1.3-2h5l1.3 2h1.7A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                      <circle cx="12" cy="12.5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
                    </svg>
                  </div>
                )}
              </div>
              <div style={{ padding: '9px 10px 10px', display: 'grid', gap: 4, minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 13.5, lineHeight: 1.2,
                  overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                }}>{i.title}</div>
                {meta && (
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--color-accent)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {meta}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--ink-40)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
                    style={{ cursor: 'pointer', textAlign: 'center', borderRadius: 9, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 11.5, padding: '9px 2px' }}
                  >
                    {i.url ? t('Tickets') : t(action)}
                  </div>
                  {onSend && (
                    <div
                      {...pressable(() => onSend(i))}
                      aria-label={t('Send')}
                      className="tap glass press"
                      style={{ cursor: 'pointer', textAlign: 'center', borderRadius: 9, fontWeight: 700, fontSize: 11.5, padding: '9px 9px' }}
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
