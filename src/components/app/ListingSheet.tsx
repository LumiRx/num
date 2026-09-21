// THE RESULTS A WIDGET OPENS INTO.
//
// Dre, 20 Sep 2026: "in the widget we should let it open into a custom page
// with all the related listing — if it's flights it'll be flights, if it's
// hotels it's hotels or clubs, etc."
//
// Before this, every feature page composed a sentence and posted it to the
// concierge. Right for "collect a package from the post office on Sathorn";
// wrong for "flights BKK→NRT on the 4th", which is a search and has a list
// for an answer. The concierge was being asked to narrate a table.
//
// What this surfaced, in passing: `searchStays()` had NO CALLER anywhere in
// the app. A complete hotel search — nightly and total, refundability,
// cancel-by, pay-at-hotel, check-in windows, the loyalty warning — written,
// typed, and unreachable. This page is its first door.
//
// The concierge is not removed. Every row keeps ASK NUM, so judgement about
// WHICH ONE — the thing NUM is actually for — is one tap from the list
// rather than the only way to see it.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { XIcon } from '../../lib/icons';
import { featureById } from '../../lib/features';
import { askNum } from '../../lib/concierge';
import { closeListing, placeQuery } from '../../lib/listing';
import { discover, type DiscoverItem } from '../../lib/discover';
import { searchStays, type StayOption, type StayQuery, parseChildAges } from '../../lib/stays';
import { runFlightSearch } from '../../lib/flights';
import { fetchPack, routeCodes, type TravelPack, type PackItem } from '../../lib/paperwork';
import { near } from '../../lib/near';
import { t, currentLang } from '../../lib/i18n';
import FlightTray from './FlightTray';

const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };
const row: React.CSSProperties = {
  borderTop: '1px solid var(--ink-08)', padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'flex-start',
};
const rowTitle: React.CSSProperties = { fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14, lineHeight: 1.25 };
const rowSub: React.CSSProperties = { fontSize: 11.5, color: 'var(--ink-60)', marginTop: 3, lineHeight: 1.45 };
const ask: React.CSSProperties = {
  cursor: 'pointer', flex: 'none', minHeight: 36, padding: '0 12px', borderRadius: 999, display: 'inline-flex',
  alignItems: 'center', fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em',
  background: 'var(--field-bg)', border: '1px solid var(--ink-12)', color: 'var(--ink)',
};

/**
 * One line about how many and from where. Shown because a list with no
 * provenance is a list you cannot judge — and on this directory that matters
 * more than usual: 581 of 2.7M places carry a rating, so "here are nine" is
 * often the honest limit of what we know.
 */
function Count({ n, note }: { n: number; note?: string | null }) {
  return (
    <div style={{ ...rowSub, padding: '0 16px 10px' }}>
      {n ? t('{n} found', { n }) : t('Nothing came back for that one.')}{note ? ` · ${note}` : ''}
    </div>
  );
}

export default function ListingSheet() {
  const draft = useApp((s) => s.listingOpen);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(!!draft, ref);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [places, setPlaces] = useState<DiscoverItem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [stays, setStays] = useState<StayOption[]>([]);
  const [pack, setPack] = useState<TravelPack | null>(null);

  const feature = featureById(draft?.feature);

  // One search per opening. The key is the whole draft, so changing the
  // fields and reopening searches again rather than showing the last answer.
  const key = draft ? JSON.stringify(draft) : null;
  useEffect(() => {
    if (!draft) return;
    let live = true;
    setError(null); setPlaces([]); setStays([]); setNote(null); setPack(null);
    void (async () => {
      setBusy(true);
      try {
        if (draft.source === 'flights') {
          // runFlightSearch writes the store that FlightTray reads, so the
          // fare rows and their two-tap booking flow are the same ones the
          // thread shows. One implementation of a fee disclosure, not two.
          await runFlightSearch({
            fromCode: (draft.values.from ?? '').toUpperCase().slice(0, 3),
            toCode: (draft.values.to ?? '').toUpperCase().slice(0, 3),
            depart: draft.values.date ?? '',
            ret: draft.values.ret || null,
            adults: 1,
            cabin: draft.lane ?? null,
          });
        } else if (draft.source === 'stays') {
          const q: StayQuery = {
            where: draft.values.where ?? '',
            checkin: draft.values.checkin ?? '',
            checkout: draft.values.checkout ?? '',
            adults: Number(draft.values.adults) || 2,
            rooms: Number(draft.values.rooms) || 1,
            childrenAges: parseChildAges(draft.values.kids ?? ''),
            guestNationality: 'US',
            currency: 'USD',
          };
          const out = await searchStays(me, q);
          if (live) setStays(out.options);
        } else if (draft.source === 'paperwork') {
          const out = await fetchPack({
            to: draft.values.to ?? '',
            nationality: draft.values.nationality ?? null,
            date: draft.values.date || null,
            from: routeCodes(draft.values.from),
          });
          if (!live) return;
          if (!out) setError(t('Give me the two-letter country code — TH, JP, FR — and I’ll pull the paperwork.'));
          setPack(out);
        } else {
          const out = await discover({ mode: 'search', q: placeQuery(draft, feature?.title ?? '') });
          if (!live) return;
          if (!out.ok) setError(out.error === 'no_place' ? t('Tell me where you are and I’ll fill this in.') : t('That search didn’t come back — try again in a moment.'));
          setPlaces(out.items);
          setNote(out.note);
        }
      } catch {
        if (live) setError(t('That search didn’t come back — try again in a moment.'));
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!draft || !feature) return null;

  /** Hand this one to the concierge — the judgement half, kept one tap away. */
  const askAbout = (title: string) => {
    closeListing();
    store.set({ threadOpen: true, unread: 0 });
    void askNum(t('Tell me about {title} — is it worth it, and can you get me in?', { title }), { browse: true });
  };

  /** The sentence the widget would have sent, still available in one tap. */
  const askTheWhole = () => {
    closeListing();
    store.set({ threadOpen: true, unread: 0 });
    void askNum(draft.ask, { browse: true });
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={t(feature.title)} className="glass-strong sheet-in"
      style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(94%, calc(100% - var(--safe-top, 0px)))', overflowY: 'auto' }}>
      <div style={grabberStyle} />
      <div {...pressable(closeListing)} aria-label={t('Close')} className="glass press tap"
        style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, borderRadius: 999, cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>

      <div style={{ padding: '14px 16px 8px' }}>
        <div style={kicker}>{t(feature.kicker)}</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 3, letterSpacing: '-.01em' }}>{t(feature.title)}</div>
      </div>

      {busy && <div style={{ ...rowSub, padding: '0 16px 14px' }}>{t('Looking…')}</div>}
      {error && !busy && <div style={{ ...rowSub, padding: '0 16px 14px' }}>{error}</div>}

      {/* FLIGHTS — the tray the thread uses, unchanged. */}
      {draft.source === 'flights' && !busy && (
        <div style={{ padding: '0 14px 8px' }}><FlightTray /></div>
      )}

      {/* STAYS — its first surface anywhere in the app. */}
      {draft.source === 'stays' && !busy && (
        <>
          <Count n={stays.length} />
          {stays.map((o) => (
            <div key={o.id} style={row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitle}>{o.hotel ?? t('A room')}</div>
                <div style={rowSub}>
                  {[o.room, o.board, o.stars ? `${o.stars}★` : null].filter(Boolean).join(' · ')}
                </div>
                <div style={rowSub}>
                  {o.nightly != null && o.currency ? t('{cur} {n} a night', { cur: o.currency, n: Math.round(o.nightly) }) : ''}
                  {o.total != null && o.currency ? ` · ${t('{cur} {n} total', { cur: o.currency, n: Math.round(o.total) })}` : ''}
                </div>
                {/* Said plainly, because it is the thing people are caught by. */}
                <div style={rowSub}>
                  {o.refundable === true
                    ? (o.cancelBy ? t('Free to cancel until {when}', { when: o.cancelBy }) : t('Free to cancel'))
                    : o.refundable === false ? t('Non-refundable') : t('Cancellation terms not stated')}
                </div>
              </div>
              <span {...pressable(() => askAbout(o.hotel ?? t('this one')))} className="tap" style={ask}>{t('ASK NUM')}</span>
            </div>
          ))}
        </>
      )}

      {/* EVERYTHING ELSE — tables, clubs, spas, the errand counters. */}
      {draft.source === 'places' && !busy && (
        <>
          <Count n={places.length} note={note} />
          {places.map((i) => (
            <div key={i.id} style={row}>
              {i.image && <img src={i.image} alt="" style={{ flex: 'none', width: 56, height: 56, borderRadius: 12, objectFit: 'cover' }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitle}>{i.title}</div>
                <div style={rowSub}>{[i.sub, near(i.distance_km)].filter(Boolean).join(' · ')}</div>
                {/* A rating is printed only when there IS one. On this
                    directory 581 of 2.7M rows carry one, so a placeholder
                    star would be a fiction on almost every row. */}
                <div style={rowSub}>{i.rating != null ? `${i.rating}${i.reviews ? ` · ${i.reviews}` : ''}` : i.label}</div>
              </div>
              <span {...pressable(() => askAbout(i.title))} className="tap" style={ask}>{t('ASK NUM')}</span>
            </div>
          ))}
        </>
      )}

      {/* PAPERWORK — five datasets that had no door until today. Every link
          here is an official government host; traveldocs.mjs allows nothing
          else, because searching for any of these returns page after page of
          copycat sites built to be mistaken for the government and to charge
          several times the real fee. */}
      {draft.source === 'paperwork' && !busy && pack?.ok && (
        <>
          <div style={{ ...rowSub, padding: '0 16px 10px' }}>
            {pack.daysOut != null
              ? t('{n} days out — soonest deadline first.', { n: pack.daysOut })
              : t('In the order the deadlines fall.')}
          </div>

          {pack.items.map((i: PackItem, n: number) => (
            <div key={`${i.kind}:${i.title}:${n}`} style={row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitle}>{i.title}</div>
                {i.detail && <div style={rowSub}>{i.detail}</div>}
                {/* Never resolved for them. What somebody needs depends on
                    their passport, their purpose and how long they stay, and
                    the official page is the only thing that decides. */}
                {i.appliesTo && <div style={rowSub}>{i.appliesTo}</div>}
                {i.by && <div style={{ ...rowSub, color: 'var(--color-accent-700)', fontWeight: 700 }}>{i.by}</div>}
              </div>
              {i.url && (
                <a
                  href={i.url} target="_blank" rel="noreferrer"
                  className="tap" style={{ ...ask, textDecoration: 'none' }}
                >{t('OFFICIAL')}</a>
              )}
            </div>
          ))}

          {/* Said where a person can see it, not in a footnote. Somebody who
              is widely told a rule that no government states deserves to
              know which of the two they are reading. */}
          {pack.unverified.length > 0 && (
            <div style={{ ...rowSub, padding: '12px 16px 0', borderTop: '1px solid var(--ink-08)' }}>
              <div style={{ ...kicker, marginBottom: 4 }}>{t('WIDELY SAID, NOT STATED ANYWHERE OFFICIAL')}</div>
              {pack.unverified.map((u) => <div key={u}>{u}</div>)}
            </div>
          )}

          <div style={{ ...rowSub, padding: '12px 16px 0' }}>{pack.promise}</div>
        </>
      )}
      {draft.source === 'paperwork' && !busy && pack && !pack.ok && (
        <div style={{ ...rowSub, padding: '0 16px 14px' }}>
          {t('Nothing on file for that one yet — ask me and I’ll find the official page.')}
        </div>
      )}

      <div style={{ padding: '14px 16px 20px', borderTop: '1px solid var(--ink-08)' }}>
        <div {...pressable(askTheWhole)} className="press tap"
          style={{ cursor: 'pointer', textAlign: 'center', borderRadius: 999, padding: '13px 16px', background: 'var(--grad-accent)', color: '#fff', fontWeight: 800, fontSize: 11.5, letterSpacing: '.06em' }}>
          {t('ASK NUM TO PICK')}
        </div>
        <div style={{ ...rowSub, textAlign: 'center', marginTop: 8 }}>
          {t('The list is everything we hold. NUM is for which one.')}
        </div>
      </div>
    </div>
  );
}
