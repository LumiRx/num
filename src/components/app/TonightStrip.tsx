// TONIGHT — what is on near you, on the TODAY tab, before you ask.
//
// Most people have no idea what is on three streets away; knowing is NUM's
// job. The strip appears after 15:00 local, or right after a flight lands,
// or whenever there is something within reach today, and each card carries a
// countdown that ticks ("Doors in 1h 42m"). Every listing says where it came
// from: Checked by NUM, or Listed on Ticketmaster with the poster credited.
// Tickets open on Ticketmaster — NUM never says booked for a ticket it cannot
// sell. "Ask NUM" turns a listing into a night: dinner before, a car home.
import { useEffect, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { apiUrl } from '../../lib/apibase';
import { askNum } from '../../lib/concierge';
import { openShareCard } from '../../lib/sharecard';
import { fixPosition } from '../../lib/whereami';
import { t } from '../../lib/i18n';

interface TonightItem {
  source: 'num' | 'ticketmaster'; id: string; title: string; sub: string; image: string | null;
  price: number | null; currency: string | null; price_note?: string | null; url: string | null; distance_km?: number | null;
  starts_on: string | null; ends_on?: string | null; starts_at: string | null; venue: string | null; label: string; why?: string | null;
}

/** The phone's own date — the worker's clock is UTC, and Bangkok is already tomorrow at 17:00 UTC. */
const localDay = (now = Date.now()) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 };

/** "Doors in 1h 42m" / "On now" / "Tomorrow 19:00" from the listing's own start. */
export function countdown(i: TonightItem, now = Date.now()): string {
  if (i.starts_at) {
    const at = Date.parse(i.starts_at);
    if (Number.isFinite(at)) {
      const m = Math.round((at - now) / 60000);
      if (m <= 0 && m > -180) return t('On now');
      if (m < 0) return t('Earlier today');
      if (m < 60 * 24) return t('Doors in {when}', { when: m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min` });
      return `${i.starts_on} · ${i.starts_at.slice(11, 16)}`;
    }
  }
  if (i.starts_on) {
    const today = localDay(now);
    if (i.starts_on <= today) return i.ends_on && i.ends_on > today ? t('On now · until {date}', { date: i.ends_on.slice(5).replace('-', '/') }) : t('On today');
    const d = Math.round((Date.parse(i.starts_on) - Date.parse(today)) / 86400000);
    return d === 1 ? t('Tomorrow') : t('In {n} days', { n: d });
  }
  return '';
}

/**
 * Where the listing came from, as a small mark in the poster's corner rather
 * than a line of capitals under it. Ticketmaster asks for attribution on
 * every listing; a wordmark the size of a stamp is attribution. NUM's own
 * rows get the check.
 */
function SourceMark({ source }: { source: TonightItem['source'] }) {
  const base: React.CSSProperties = { flex: 'none', borderRadius: 999, padding: '2px 6px', fontSize: 8, fontWeight: 800, letterSpacing: '.02em', display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--ink-60)', background: 'var(--field-bg)', border: '1px solid var(--ink-12)' };
  if (source === 'ticketmaster') {
    return (
      <span style={base} aria-label={t('Listed on Ticketmaster')}>
        <svg width="9" height="9" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2.2a1.8 1.8 0 0 0 0 3.6V14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2.2a1.8 1.8 0 0 0 0-3.6Z" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M8 5v10" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.5 1.5" /></svg>ticketmaster</span>
    );
  }
  return (
    <span style={{ ...base, color: 'var(--color-accent)' }} aria-label={t('Checked by NUM')}>
      <svg width="9" height="9" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5 8.2 14.5 16 6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>NUM</span>
  );
}

export default function TonightStrip() {
  const place = useApp((s) => s.place);
  const here = useApp((s) => s.here);
  const demo = useApp((s) => s.demo);
  const [items, setItems] = useState<TonightItem[] | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (demo || (!place && !here)) { setItems(null); return; }
    const qs = new URLSearchParams({ mode: 'tonight', day: localDay() });
    if (place) qs.set('place', place);
    if (here) { qs.set('lat', String(here.lat)); qs.set('lng', String(here.lng)); }
    let dead = false;
    fetch(`${apiUrl('/api/discover')}?${qs}`).then((r) => r.json()).then((b: { ok: boolean; items?: TonightItem[] }) => {
      if (!dead) setItems(b.ok ? (b.items ?? []) : []);
    }).catch(() => { if (!dead) setItems([]); });
    return () => { dead = true; };
  }, [place, here?.lat, here?.lng, demo]);

  const [locating, setLocating] = useState(false);
  // Tonight is about what is CLOSE. Without a fix the strip works from the
  // city's centre; one tap asks the phone, and from then on the listings are
  // the ones within a short ride, nearest first, with the distance on each.
  const nearMe = async () => {
    if (locating) return;
    setLocating(true);
    const fix = await fixPosition();
    setLocating(false);
    if (fix) store.set((s) => ({ here: fix, place: s.place ?? t('Near me') }));
  };

  if (!items || items.length === 0) return null;

  return (
    <div style={{ margin: '10px 0 2px' }}>
      <div style={{ ...kicker, padding: '0 14px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('TONIGHT NEAR {place}', { place: String(here ? t('YOU') : (place ?? t('YOU'))).toUpperCase() })}</span>
        {here ? (
          <span style={{ color: 'var(--color-accent)', flex: 'none' }}>{items.length} {t('ON')}</span>
        ) : (
          <span {...pressable(() => void nearMe())} className="tap press" style={{ cursor: 'pointer', flex: 'none', color: 'var(--color-accent)', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 4px', opacity: locating ? 0.6 : 1 }}>
            <svg width="11" height="11" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" fill="currentColor" /><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10 0v4M10 16v4M0 10h4M16 10h4" stroke="currentColor" strokeWidth="1.6" /></svg>
            {locating ? t('FINDING YOU…') : t('NEAR ME')}
          </span>
        )}
      </div>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '0 12px 6px', scrollSnapType: 'x mandatory' }}>
        {items.map((i, n) => {
          const cd = countdown(i, now);
          const price = i.price != null && i.currency ? `from ${i.currency} ${i.price}` : i.price_note ?? null;
          return (
            <div key={i.id} className="glass lift rise-in" style={{ flex: '0 0 172px', scrollSnapAlign: 'start', borderRadius: 18, overflow: 'hidden', animationDelay: `${n * 60}ms` }}>
              <div style={{ height: 96, position: 'relative', background: i.image ? `url(${i.image}) center/cover` : 'linear-gradient(135deg, var(--color-accent-300, #9fe3cf), var(--field-bg))' }}>
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(5,15,20,.75) 100%)' }} />
                {cd && <span className="glass-dark" style={{ position: 'absolute', top: 8, left: 8, color: '#fff', borderRadius: 999, padding: '3px 8px', fontSize: 10.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{cd}</span>}
                {i.distance_km != null && <span className="glass-dark" style={{ position: 'absolute', top: 36, left: 8, color: '#9FF0D6', borderRadius: 999, padding: '3px 7px', fontSize: 10, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{i.distance_km < 1 ? `${Math.round(i.distance_km * 1000)} m` : `${i.distance_km} km`}</span>}
                <div style={{ position: 'absolute', left: 8, right: 8, bottom: 8, color: '#fff', fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 13, lineHeight: 1.15, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{i.title}</div>
              </div>
              <div style={{ padding: '7px 9px 9px', display: 'grid', gap: 3, fontSize: 11 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ flex: 1, color: 'var(--ink-60)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{[i.venue ?? i.sub, price].filter(Boolean).join(' · ')}</span>
                  <SourceMark source={i.source} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginTop: 4 }}>
                  {i.url ? (
                    <a href={i.url} target="_blank" rel="noopener noreferrer" className="tap press glow" style={{ textDecoration: 'none', textAlign: 'center', borderRadius: 9, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 10.5 }}>{t('Tickets')}</a>
                  ) : (
                    <div {...pressable(() => { store.set({ threadOpen: true }); void askNum(`Tell me about ${i.title}${i.venue ? ` at ${i.venue}` : ''} tonight and plan the evening around it.`); })} className="tap press glow" style={{ cursor: 'pointer', textAlign: 'center', borderRadius: 9, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 10.5 }}>{t('Ask NUM')}</div>
                  )}
                  <div {...pressable(() => openShareCard({ kind: 'idea', title: i.title, summary: [i.title, i.venue, cd, price, i.label].filter(Boolean).join(' · '), place: i.venue, day: i.starts_on ?? null, cost: price, link: i.url }))} className="tap glass press" style={{ cursor: 'pointer', textAlign: 'center', borderRadius: 9, fontWeight: 700, fontSize: 10.5 }}>{t('Send')}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
