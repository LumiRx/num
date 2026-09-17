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

interface TonightItem {
  source: 'num' | 'ticketmaster'; id: string; title: string; sub: string; image: string | null;
  price: number | null; currency: string | null; price_note?: string | null; url: string | null;
  starts_on: string | null; starts_at: string | null; venue: string | null; label: string; why?: string | null;
}

const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 };

/** "Doors in 1h 42m" / "On now" / "Tomorrow 19:00" from the listing's own start. */
export function countdown(i: TonightItem, now = Date.now()): string {
  if (i.starts_at) {
    const t = Date.parse(i.starts_at);
    if (Number.isFinite(t)) {
      const m = Math.round((t - now) / 60000);
      if (m <= 0 && m > -180) return 'On now';
      if (m < 0) return 'Earlier today';
      if (m < 60 * 24) return `Doors in ${m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`}`;
      return `${i.starts_on} · ${i.starts_at.slice(11, 16)}`;
    }
  }
  if (i.starts_on) {
    const today = new Date(now).toISOString().slice(0, 10);
    if (i.starts_on <= today) return 'On now';
    const d = Math.round((Date.parse(i.starts_on) - Date.parse(today)) / 86400000);
    return d === 1 ? 'Tomorrow' : `In ${d} days`;
  }
  return '';
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
    const qs = new URLSearchParams({ mode: 'tonight' });
    if (place) qs.set('place', place);
    if (here) { qs.set('lat', String(here.lat)); qs.set('lng', String(here.lng)); }
    let dead = false;
    fetch(`${apiUrl('/api/discover')}?${qs}`).then((r) => r.json()).then((b: { ok: boolean; items?: TonightItem[] }) => {
      if (!dead) setItems(b.ok ? (b.items ?? []) : []);
    }).catch(() => { if (!dead) setItems([]); });
    return () => { dead = true; };
  }, [place, here?.lat, here?.lng, demo]);

  if (!items || items.length === 0) return null;

  return (
    <div style={{ margin: '10px 0 2px' }}>
      <div style={{ ...kicker, padding: '0 14px 8px', display: 'flex', justifyContent: 'space-between' }}>
        <span>TONIGHT NEAR {String(place ?? 'YOU').toUpperCase()}</span>
        <span style={{ color: 'var(--color-accent)' }}>{items.length} ON</span>
      </div>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '0 12px 6px', scrollSnapType: 'x mandatory' }}>
        {items.map((i, n) => {
          const cd = countdown(i, now);
          const price = i.price != null && i.currency ? `from ${i.currency} ${i.price}` : i.price_note ?? null;
          return (
            <div key={i.id} className="glass lift rise-in" style={{ flex: '0 0 172px', scrollSnapAlign: 'start', borderRadius: 18, overflow: 'hidden', animationDelay: `${n * 60}ms` }}>
              <div style={{ height: 96, position: 'relative', background: i.image ? `url(${i.image}) center/cover` : 'linear-gradient(135deg, var(--color-accent-300, #9fe3cf), var(--field-bg))' }}>
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(5,15,20,.75) 100%)' }} />
                {cd && <span style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,.55)', color: '#fff', borderRadius: 8, padding: '2px 7px', fontSize: 10.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{cd}</span>}
                {i.source === 'ticketmaster' && <span style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,.45)', color: '#fff', borderRadius: 5, padding: '2px 5px', fontSize: 8.5, fontWeight: 600 }}>Ticketmaster</span>}
                <div style={{ position: 'absolute', left: 8, right: 8, bottom: 8, color: '#fff', fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 13, lineHeight: 1.15, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{i.title}</div>
              </div>
              <div style={{ padding: '7px 9px 9px', display: 'grid', gap: 3, fontSize: 11 }}>
                <span style={{ fontSize: 9, letterSpacing: '.06em', fontWeight: 700, color: i.source === 'num' ? 'var(--color-accent)' : '#2A63C8' }}>{i.label.toUpperCase()}</span>
                <span style={{ color: 'var(--ink-60)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{[i.venue ?? i.sub, price].filter(Boolean).join(' · ')}</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginTop: 4 }}>
                  {i.url ? (
                    <a href={i.url} target="_blank" rel="noopener noreferrer" className="tap" style={{ textDecoration: 'none', textAlign: 'center', borderRadius: 9, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 10.5 }}>Tickets</a>
                  ) : (
                    <div {...pressable(() => { store.set({ threadOpen: true }); void askNum(`Tell me about ${i.title}${i.venue ? ` at ${i.venue}` : ''} tonight and plan the evening around it.`); })} className="tap" style={{ cursor: 'pointer', textAlign: 'center', borderRadius: 9, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 10.5 }}>Ask NUM</div>
                  )}
                  <div {...pressable(() => openShareCard({ kind: 'idea', title: i.title, summary: [i.title, i.venue, cd, price, i.label].filter(Boolean).join(' · '), place: i.venue, day: i.starts_on ?? null, cost: price, link: i.url }))} className="tap" style={{ cursor: 'pointer', textAlign: 'center', borderRadius: 9, border: '1px solid var(--ink-12)', fontWeight: 700, fontSize: 10.5 }}>Send</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
