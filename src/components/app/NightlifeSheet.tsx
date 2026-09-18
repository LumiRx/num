// NIGHTLIFE — where everyone is going, nearest first.
//
// Its own screen, not a rail on TONIGHT (18 Sep 2026: "clubs and nightlife is
// its own tab, also we should populate that closest to wherever the user is").
// TONIGHT answers "what should I do"; this answers "where is everyone going",
// and that answer is ordered by how far away it is right now, with the
// distance printed on every card.
//
// Four shelves from one call to /api/discover?mode=nightlife: tonight's
// ticketed nights (Ticketmaster, credited, tickets on their page), clubs,
// late bars, live music. Every place row is one the concierge would stand
// behind — real ratings first, unrated dropped where the neighbourhood has
// rated ones. Nothing here promises entry, a table, or a cover charge NUM was
// never told.
//
// Without a device fix it works from the named place and says so; one tap on
// NEAR ME and everything re-ranks around the phone.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { XIcon } from '../../lib/icons';
import { apiUrl } from '../../lib/apibase';
import { askNum } from '../../lib/concierge';
import { openShareCard } from '../../lib/sharecard';
import { fixPosition } from '../../lib/whereami';
import { openEventCard } from '../../lib/eventview';
import { t } from '../../lib/i18n';
import NearbyRail, { near, type RailItem } from './NearbyRail';
import { countdown } from './TonightStrip';

interface Night {
  source: 'num' | 'ticketmaster'; id: string; title: string; sub: string; image: string | null;
  price: number | null; currency: string | null; url: string | null; distance_km?: number | null;
  starts_on: string | null; starts_at: string | null; venue: string | null; label: string; genre?: string | null;
}
interface Place {
  id: string; title: string; sub: string; image: string | null; rating: number | null;
  open_now?: boolean | null; distance_km?: number | null;
}
interface Answer { ok: boolean; clubs?: Place[]; bars?: Place[]; live?: Place[]; nights?: Night[]; near?: boolean; error?: string }

const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** "Opens tonight" before six; "On now" after. The shelf changes with the clock. */
const hourWord = (now = new Date()) => (now.getHours() < 18 ? t('Opens tonight') : t('On now'));

export default function NightlifeSheet() {
  const open = useApp((s) => s.nightlifeOpen);
  const place = useApp((s) => s.place);
  const here = useApp((s) => s.here);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);
  const [data, setData] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(id); }, []);

  useEffect(() => {
    if (!open) return;
    if (!place && !here) { setData({ ok: false, error: 'no_place' }); return; }
    const qs = new URLSearchParams({ mode: 'nightlife', day: localDay() });
    if (place) qs.set('place', place);
    if (here) { qs.set('lat', String(here.lat)); qs.set('lng', String(here.lng)); }
    if (me?.id) qs.set('me', me.id);
    let dead = false;
    setBusy(true);
    fetch(`${apiUrl('/api/discover')}?${qs}`)
      .then((r) => r.json())
      .then((b: Answer) => { if (!dead) { setData(b); setBusy(false); } })
      .catch(() => { if (!dead) { setData({ ok: false, error: 'offline' }); setBusy(false); } });
    return () => { dead = true; };
  }, [open, place, here?.lat, here?.lng, me?.id]);

  if (!open) return null;
  const close = () => store.set({ nightlifeOpen: false });

  const nearMe = async () => {
    if (locating) return;
    setLocating(true);
    const fix = await fixPosition();
    setLocating(false);
    if (fix) store.set((s) => ({ here: fix, place: s.place ?? t('Near me') }));
  };

  const asNight = (i: Night): RailItem => ({
    id: i.id, title: i.title, sub: i.venue ?? i.sub, image: i.image, source: i.source,
    when: countdown(i as never, now), distance_km: i.distance_km ?? null, url: i.url,
    price: i.price != null && i.currency ? `${i.currency} ${i.price}` : null,
  });
  const asPlace = (p: Place): RailItem => ({
    id: p.id, title: p.title, sub: p.sub, image: p.image, source: 'num',
    when: p.open_now === true ? hourWord() : p.open_now === false ? t('Closed now') : null,
    distance_km: p.distance_km ?? null, rating: p.rating ?? null,
  });
  const openNight = (i: RailItem) => {
    const e = (data?.nights ?? []).find((x) => x.id === i.id);
    if (!e) return;
    openEventCard({
      source: e.source, id: e.id, title: e.title, sub: e.sub || null, image: e.image, label: e.label,
      when: countdown(e as never, now), starts_on: e.starts_on, venue: e.venue, distance_km: e.distance_km ?? null,
      cost: e.price != null && e.currency ? `${e.currency} ${e.price}` : null, url: e.url,
    });
  };
  const askAbout = (what: string) => (i: RailItem) => {
    store.set({ nightlifeOpen: false, threadOpen: true, unread: 0 });
    void askNum(`Tell me about ${i.title}${i.sub ? ` — ${i.sub}` : ''} ${what}`);
  };
  const send = (i: RailItem) => openShareCard({
    kind: 'idea', title: i.title,
    summary: [i.title, i.sub, i.when, near(i.distance_km)].filter(Boolean).join(' · '),
    place: i.sub, day: null, cost: i.price ?? null, link: i.url ?? null,
  });

  const where = String(here ? t('YOU') : (place ?? t('YOU'))).toUpperCase();
  const empty = !!data?.ok && !data.clubs?.length && !data.bars?.length && !data.live?.length && !data.nights?.length;

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={t('Nightlife')} className="glass-strong sheet-in no-scrollbar" style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(94%, calc(100% - var(--safe-top, 0px)))', overflowY: 'auto', overscrollBehavior: 'contain' }}>
      <div style={grabberStyle} />
      <div {...pressable(close)} aria-label={t('Close')} className="glass press tap" style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, borderRadius: 999, cursor: 'pointer', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <XIcon size={15} />
      </div>

      <div style={{ padding: '10px 16px 4px' }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>{t('NIGHTLIFE')}</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, lineHeight: 1.12, marginTop: 5, letterSpacing: '-.01em' }}>
          {t('Out tonight, nearest first')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11.5, color: 'var(--ink-60)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>{here ? t('Ranked by distance from where you are.') : t('Ranked from {place}. Tap NEAR ME to rank from your phone.', { place: place ?? '—' })}</span>
          {!here && (
            <span {...pressable(() => void nearMe())} className="tap press" style={{ cursor: 'pointer', flex: 'none', color: 'var(--color-accent)', fontWeight: 800, fontSize: 10.5, letterSpacing: '.08em', opacity: locating ? 0.6 : 1 }}>
              {locating ? t('FINDING YOU…') : t('NEAR ME')}
            </span>
          )}
        </div>
      </div>

      {data?.error === 'no_place' && (
        <div style={{ margin: '12px 16px', fontSize: 12.5, color: 'var(--ink-60)', lineHeight: 1.5 }}>
          {t('Tell NUM where you are first.')}{' '}
          <span {...pressable(() => store.set({ nightlifeOpen: false, placeOpen: true }))} style={{ color: 'var(--color-accent)', fontWeight: 700, cursor: 'pointer' }}>{t('Where am I?')}</span>
        </div>
      )}
      {busy && !data?.ok && <div style={{ margin: '12px 16px', fontSize: 12, color: 'var(--ink-40)' }}>{t('Looking…')}</div>}
      {empty && <div style={{ margin: '12px 16px', fontSize: 12.5, color: 'var(--ink-60)', lineHeight: 1.5 }}>{t('Nothing NUM can stand behind near here tonight. Ask in the thread and it will look wider.')}</div>}

      {!!data?.nights?.length && (
        <NearbyRail title={t('TONIGHT’S NIGHTS NEAR {place}', { place: where })} count={t('{n} ON', { n: data.nights.length })} items={data.nights.map(asNight)} onOpen={openNight} onSend={send} />
      )}
      {!!data?.clubs?.length && (
        <NearbyRail title={t('CLUBS')} count={t('{n} CHECKED', { n: data.clubs.length })} items={data.clubs.map(asPlace)} onOpen={askAbout(t('tonight — door policy, what time it gets going, and whether you can get us in.'))} onSend={send} action="Get us in" />
      )}
      {!!data?.bars?.length && (
        <NearbyRail title={t('LATE BARS')} count={t('{n} CHECKED', { n: data.bars.length })} items={data.bars.map(asPlace)} onOpen={askAbout(t('tonight, and hold us a table if they take them.'))} onSend={send} action="Ask NUM" />
      )}
      {!!data?.live?.length && (
        <NearbyRail title={t('LIVE MUSIC')} count={t('{n} CHECKED', { n: data.live.length })} items={data.live.map(asPlace)} onOpen={askAbout(t('— who is playing tonight and how we get in.'))} onSend={send} action="Ask NUM" />
      )}

      {/* Said once, at the bottom, where the money decision happens. */}
      <div style={{ padding: '6px 16px 18px', fontSize: 10.5, color: 'var(--color-neutral-500)', lineHeight: 1.5 }}>
        {t('Door policy, covers and dress codes are the venue’s. NUM asks; it never promises entry.')}
      </div>
    </div>
  );
}
