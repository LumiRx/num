// TONIGHT — what is on, where to eat and where to drink, near you, before
// you ask.
//
// Most people have no idea what is on three streets away, or which of the
// forty restaurants between them and the hotel is the good one; knowing is
// NUM's job. One call to /api/discover?mode=tonight brings back three feeds —
// events, restaurants, bars — each ranked by the same rules the concierge
// uses (real ratings first, open now first, not the same three as last time)
// and each drawn by the same rail (NearbyRail).
//
// Every listing says where it came from: Checked by NUM, or Listed on
// Ticketmaster with the poster credited. Tapping an event opens it INSIDE
// NUM (EventDetailSheet), where tickets are a labelled second tap on the
// seller's own page — NUM never says booked for a ticket it cannot sell.
// Tapping a place asks NUM, which is how a listing becomes a night: a table
// before, a car home.
import { useEffect, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { apiUrl } from '../../lib/apibase';
import { askNum } from '../../lib/concierge';
import { openShareCard } from '../../lib/sharecard';
import { fixPosition } from '../../lib/whereami';
import { t } from '../../lib/i18n';
import { openEventCard } from '../../lib/eventview';
import NearbyRail, { near, type RailItem } from './NearbyRail';

interface Event {
  source: 'num' | 'ticketmaster'; id: string; title: string; sub: string; image: string | null;
  price: number | null; currency: string | null; price_note?: string | null; url: string | null; distance_km?: number | null;
  starts_on: string | null; ends_on?: string | null; starts_at: string | null; venue: string | null; label: string; why?: string | null;
}
interface Place {
  source: 'num'; id: string; title: string; sub: string; image: string | null;
  rating: number | null; reviews: number | null; open_now?: boolean | null; distance_km?: number | null;
}

/** The phone's own date — the worker's clock is UTC, and Bangkok is already tomorrow at 17:00 UTC. */
const localDay = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** "Doors in 1h 42m" / "On now" / "Tomorrow" — from the listing's own start. */
export function countdown(i: Event, now = Date.now()): string {
  if (i.starts_at) {
    const at = Date.parse(i.starts_at);
    if (Number.isFinite(at)) {
      const m = Math.round((at - now) / 60000);
      if (m <= 0 && m > -180) return t('On now');
      if (m < 0) return t('Earlier today');
      if (m < 60 * 24) {
        return t('Doors in {when}', { when: m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min` });
      }
    }
  }
  if (i.starts_on) {
    const today = localDay(now);
    if (i.starts_on <= today) return i.ends_on && i.ends_on > today ? t('On now') : t('On today');
    const d = Math.round((Date.parse(i.starts_on) - Date.parse(today)) / 86400000);
    return d === 1 ? t('Tomorrow') : t('In {n} days', { n: d });
  }
  return '';
}

const money = (i: Event) => (i.price != null && i.currency ? `${i.currency} ${i.price}` : i.price_note ?? null);

export default function TonightStrip() {
  const place = useApp((s) => s.place);
  const here = useApp((s) => s.here);
  const me = useApp((s) => s.me);
  const demo = useApp((s) => s.demo);
  const [events, setEvents] = useState<Event[]>([]);
  const [restaurants, setRestaurants] = useState<Place[]>([]);
  const [bars, setBars] = useState<Place[]>([]);
  const [now, setNow] = useState(Date.now());
  const [locating, setLocating] = useState(false);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(id); }, []);

  useEffect(() => {
    if (demo || (!place && !here)) { setEvents([]); setRestaurants([]); setBars([]); return; }
    const qs = new URLSearchParams({ mode: 'tonight', day: localDay() });
    if (place) qs.set('place', place);
    if (here) { qs.set('lat', String(here.lat)); qs.set('lng', String(here.lng)); }
    if (me?.id) qs.set('me', me.id);
    let dead = false;
    fetch(`${apiUrl('/api/discover')}?${qs}`)
      .then((r) => r.json())
      .then((b: { ok: boolean; items?: Event[]; restaurants?: Place[]; bars?: Place[] }) => {
        if (dead) return;
        setEvents(b.ok ? (b.items ?? []) : []);
        setRestaurants(b.ok ? (b.restaurants ?? []) : []);
        setBars(b.ok ? (b.bars ?? []) : []);
      })
      .catch(() => { if (!dead) { setEvents([]); setRestaurants([]); setBars([]); } });
    return () => { dead = true; };
  }, [place, here?.lat, here?.lng, me?.id, demo]);

  // Tonight is about what is CLOSE. Without a fix the rails work from the
  // city's centre; one tap asks the phone, and from then on everything is
  // within a short ride, nearest first, with the distance printed.
  const nearMe = async () => {
    if (locating) return;
    setLocating(true);
    const fix = await fixPosition();
    setLocating(false);
    if (fix) store.set((s) => ({ here: fix, place: s.place ?? t('Near me') }));
  };

  const asEvent = (i: Event): RailItem => ({
    id: i.id, title: i.title, sub: i.venue ?? i.sub, image: i.image, source: i.source,
    when: countdown(i, now), distance_km: i.distance_km ?? null, url: i.url, price: money(i),
  });
  const asPlace = (p: Place): RailItem => ({
    id: p.id, title: p.title, sub: p.sub, image: p.image, source: 'num',
    when: p.open_now === true ? t('Open now') : p.open_now === false ? t('Closed now') : null,
    distance_km: p.distance_km ?? null, rating: p.rating ?? null,
  });

  // TAPPING AN EVENT OPENS THE EVENT, INSIDE NUM.
  //
  // It used to do one of two things and both were wrong. A listing with a
  // ticket URL opened a Ticketmaster tab immediately — you had not asked to
  // leave, and getting back was the same trap the flights tab was. A listing
  // without one put a question in the thread, so you read NUM's answer
  // instead of looking at the event. Now the card you tapped becomes a sheet
  // built from the listing already in hand: no fetch, no wait. Tickets, the
  // evening around it, keeping it and sending it are all one tap from there.
  const openEvent = (i: RailItem) => {
    const e = events.find((x) => x.id === i.id);
    if (!e) return;
    openEventCard({
      source: e.source, id: e.id, title: e.title, sub: e.sub || null, image: e.image, label: e.label,
      when: countdown(e, now), starts_on: e.starts_on, venue: e.venue, distance_km: e.distance_km ?? null,
      cost: money(e), why: e.why ?? null, url: e.url,
    });
  };
  const openPlace = (i: RailItem) => {
    store.set({ threadOpen: true });
    void askNum(`Tell me about ${i.title}${i.sub ? ` — ${i.sub}` : ''} and get me a table tonight.`);
  };
  const send = (i: RailItem) => openShareCard({
    kind: 'idea',
    title: i.title,
    summary: [i.title, i.sub, i.when, near(i.distance_km)].filter(Boolean).join(' · '),
    place: i.sub,
    day: null,
    cost: i.price ?? null,
    link: i.url ?? null,
  });

  if (!events.length && !restaurants.length && !bars.length) return null;

  const where = String(here ? t('YOU') : (place ?? t('YOU'))).toUpperCase();
  const nearMeChip = here ? null : (
    <span
      {...pressable(() => void nearMe())}
      className="tap press"
      style={{ cursor: 'pointer', flex: 'none', color: 'var(--color-accent)', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 4px', opacity: locating ? 0.6 : 1 }}
    >
      <svg width="11" height="11" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="3" fill="currentColor" />
        <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 0v4M10 16v4M0 10h4M16 10h4" stroke="currentColor" strokeWidth="1.6" />
      </svg>
      {locating ? t('FINDING YOU…') : t('NEAR ME')}
    </span>
  );

  return (
    <>
      <NearbyRail
        title={t('TONIGHT NEAR {place}', { place: where })}
        count={t('{n} ON', { n: events.length })}
        items={events.map(asEvent)}
        onOpen={openEvent}
        onSend={send}
        trailing={nearMeChip}
      />
      <NearbyRail
        title={t('EAT NEARBY')}
        count={t('{n} CHECKED', { n: restaurants.length })}
        items={restaurants.map(asPlace)}
        onOpen={openPlace}
        onSend={send}
        action="Get a table"
      />
      <NearbyRail
        title={t('DRINKS NEARBY')}
        count={t('{n} CHECKED', { n: bars.length })}
        items={bars.map(asPlace)}
        onOpen={openPlace}
        onSend={send}
        action="Ask NUM"
        // Clubs and the late shift live on their own screen (NightlifeSheet),
        // nearest first; this rail is the drink before, and it says where the
        // rest of the night is.
        trailing={(
          <span {...pressable(() => store.set({ nightlifeOpen: true }))} className="tap press" style={{ cursor: 'pointer', flex: 'none', color: 'var(--color-accent)', fontWeight: 800, fontSize: 10, letterSpacing: '.1em', padding: '0 4px' }}>
            {t('ALL NIGHTLIFE')}
          </span>
        )}
      />
    </>
  );
}
