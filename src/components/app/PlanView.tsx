import { useEffect, useRef, useState } from 'react';
// PLAN tab — a tab per plan (18 Sep 2026), and MY DIARY: bookings grouped by
// city, expandable rows with note, cost, receipt, and the ASK TO CHANGE /
// SHARE actions. A plan tab opens the plan board inline (PlanBoard.tsx).
import { store, useApp } from '../../lib/store';
import PlanBoard from './PlanBoard';
import InviteRail from './InviteRail';
import { refreshRequests } from '../../lib/requests';
import { refreshAgenda } from '../../lib/agenda';
import { openPlan, setAttendee } from '../../lib/social';
import { pressable } from '../../lib/a11y';
import { tagOf, bookingMetaLine, monthName } from '../../lib/derive';
import { askToChange } from '../../lib/concierge';
import { PLAN_GROUPS } from '../../lib/data';
import { Scene } from '../../lib/scenes';
import { BookedCheck, ChevronRightIcon, UsersIcon } from '../../lib/icons';
import FlightCard from './FlightCard';
import { CalendarStrip, NextUp, TripCheck } from './DayWidgets';
import type { Booking } from '../../lib/types';
import { t } from '../../lib/i18n';
import { loadDraft, draftLine, NEW } from '../../lib/plandraft';

const sortB = (a: Booking, b: Booking) => a.mo - b.mo || a.day - b.day || a.time.localeCompare(b.time);

/**
 * Who is on this reservation.
 *
 * The shared plan item is matched by normalised title, the same way bookings
 * are pushed into the plan — the client-side Booking and the server-side
 * PlanItem are two views of one thing and the title is what ties them.
 *
 * Only shown once a plan exists: attendees are a SHARED concept, and offering
 * to add guests to something nobody else can see would be a lie about what
 * the feature does.
 */
function Attendees({ title }: { title: string }) {
  const item = useApp((s) => {
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    return s.planItems.find((i) => norm(i.title) === norm(title));
  });
  const me = useApp((s) => s.me);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  if (!item) return null;
  const list = item.attendees ?? [];
  const going = item.party_size ?? list.filter((a) => a.rsvp !== 'out').length;

  const change = async (n: string, opts: Parameters<typeof setAttendee>[2]) => {
    setBusy(true);
    await setAttendee(item.id, n, opts);
    setBusy(false);
  };

  const add = async () => {
    if (!name.trim()) return;
    await change(name.trim(), {});
    setName('');
    setAdding(false);
  };

  return (
    <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--ink-08)' }} onClick={(e) => e.stopPropagation()}>
      <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 }}>
        WHO'S COMING · TABLE FOR {going}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
        {list.map((a) => {
          // A member owns their own answer; a plain-name guest is answered for
          // by whoever added them. The UI only offers the tap where the server
          // will actually allow it, so nobody meets a 403 they can see coming.
          const mine = a.member_id ? a.member_id === me?.id : true;
          const out = a.rsvp === 'out';
          const next = a.rsvp === 'going' ? 'maybe' : a.rsvp === 'maybe' ? 'out' : 'going';
          return (
            <span
              key={a.name}
              {...(mine ? pressable(() => void change(a.name, { rsvp: next as 'going' })) : {})}
              title={mine ? t('Tap to change') : `${a.name} answers for themselves`}
              style={{
                borderRadius: 999, padding: '5px 11px', fontSize: 11, fontWeight: 600,
                border: '1px solid var(--ink-12)',
                cursor: mine ? 'pointer' : 'default',
                opacity: busy ? 0.6 : out ? 0.45 : 1,
                textDecoration: out ? 'line-through' : 'none',
                background: a.rsvp === 'going' ? 'var(--field-bg)' : 'transparent',
                color: a.rsvp === 'maybe' ? 'var(--color-accent-700)' : 'var(--ink)',
                // A guest with no NUM account is shown lighter rather than
                // annotated — a trailing mark next to a name reads as a typo.
                borderStyle: a.member_id ? 'solid' : 'dashed',
              }}
            >
              {a.name}
              {a.rsvp === 'maybe' ? ' · maybe' : ''}
            </span>
          );
        })}
        {adding ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => (e.key === 'Enter' ? void add() : e.key === 'Escape' ? setAdding(false) : null)}
            onBlur={() => (name.trim() ? void add() : setAdding(false))}
            placeholder={t('Name')}
            style={{
              borderRadius: 999, padding: '5px 11px', fontSize: 11, width: 110,
              border: '1px solid var(--color-accent)', background: 'var(--field-bg)',
              outline: 'none', color: 'var(--color-text)', fontFamily: 'var(--font-body)',
            }}
          />
        ) : (
          <span
            {...pressable(() => setAdding(true))}
            style={{
              borderRadius: 999, padding: '5px 11px', fontSize: 11, fontWeight: 700,
              border: '1px dashed var(--ink-12)', color: 'var(--ink-60)', cursor: 'pointer',
            }}
          >
            + ADD
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 6, lineHeight: 1.45 }}>{t('A name with no account still counts toward the table. Anyone who drops out frees their seat.')}</div>
    </div>
  );
}

function BookingRow({ b }: { b: Booking }) {
  const exp = useApp((s) => s.expanded === b.id);
  const demo = useApp((s) => s.demo);
  const tag = tagOf(b);
  const cancelled = b.status === 'cancelled';
  return (
    <div
      {...pressable(() => store.set((s) => ({ expanded: s.expanded === b.id ? null : b.id })))}
      aria-expanded={exp}
      className="glass lift msg-in"
      style={{ cursor: 'pointer', margin: '6px 12px', borderRadius: 'var(--r-lg)', padding: 12 }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Scene title={b.title} photo={b.photo} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.3,
              textDecoration: cancelled ? 'line-through' : 'none',
              color: cancelled ? 'var(--ink-40)' : 'var(--ink)',
            }}
          >
            {b.title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>{bookingMetaLine(demo, b)}</div>
        </div>
        {b.status === 'confirmed' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><BookedCheck size={18} /><span style={tag.st}>{tag.label}</span></span> : <span style={tag.st}>{tag.label}</span>}
      </div>
      {exp && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--ink-08)' }}>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink)' }}>{b.note}</div>
          <Attendees title={b.title} />
          {/* What this cost, in the money colour — see --money in themes.css. */}
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--money)', marginTop: 4 }}>{b.cost}</div>
          {b.receipt && (
            <div style={{ fontSize: 10, letterSpacing: '.08em', fontWeight: 700, color: 'var(--color-accent-700)', marginTop: 4 }}>
              RECEIPT FILED · {b.receipt}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <span
              {...pressable((e) => { e.stopPropagation(); askToChange(b.title); })}
              className="press"
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em',
                background: 'var(--grad-accent)', color: '#fff', cursor: 'pointer',
                boxShadow: '0 3px 12px var(--accent-30)',
              }}
            >
              ASK TO CHANGE
            </span>
            <span
              {...pressable((e) => { e.stopPropagation(); store.set({ shareOpen: true }); })}
              className="press"
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em',
                background: 'var(--field-bg)', border: '1px solid var(--ink-12)', color: 'var(--ink)', cursor: 'pointer',
              }}
            >
              SHARE
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Demo: the scripted city groups. Real: groups derived from the bookings the
 *  AI creates — grouped by its coined `grp` code, titled by the city in the
 *  first booking's place ("Shibuya, Tokyo" → TOKYO), dated from its range. */
function groupsFor(demo: boolean, bookings: Booking[]) {
  if (demo) {
    return PLAN_GROUPS.map(([name, dates, grp]) => ({
      key: grp,
      name,
      dates,
      items: bookings.filter((b) => b.grp === grp).sort(sortB),
    }));
  }
  const by = new Map<string, Booking[]>();
  for (const b of bookings) {
    const k = b.grp || '·';
    const arr = by.get(k);
    if (arr) arr.push(b);
    else by.set(k, [b]);
  }
  const cityFrom = (place: string, fallback: string) => {
    const tail = place.includes(',') ? place.slice(place.lastIndexOf(',') + 1).trim() : place.trim();
    return (tail || fallback).toUpperCase();
  };
  return [...by.entries()]
    .map(([grp, items]) => {
      items.sort(sortB);
      const first = items[0];
      const last = items[items.length - 1];
      const span =
        first.mo === last.mo && first.day === last.day
          ? `${monthName(first.mo).toUpperCase()} ${first.day}`
          : `${monthName(first.mo).toUpperCase()} ${first.day} – ${monthName(last.mo).toUpperCase()} ${last.day}`;
      return { key: grp, name: cityFrom(first.place ?? '', grp), dates: span, items };
    })
    .sort((a, b) => a.items[0].mo - b.items[0].mo || a.items[0].day - b.items[0].day);
}

/** Which plan tab is showing: the diary, or one plan by id. */
type PlanTab = 'diary' | string;

/**
 * The tab strip across the top of PLAN: MY DIARY, then one tab per plan, then
 * NEW. Selecting a plan opens its board right here (PlanBoard) — the sheet
 * (PartySheet) is now the group chat and the plan's settings, one tap away
 * from the board. Still the ONLY place a new plan starts.
 */
function PlanTabs({ tab, setTab }: { tab: PlanTab; setTab: (t: PlanTab) => void }) {
  const plans = useApp((s) => s.plans);
  const partyOpen = useApp((s) => s.partyOpen);
  // A plan you started naming and never created. Read each time the sheet
  // closes, because that is the moment it can have changed.
  const [unfinished, setUnfinished] = useState<string | null>(null);
  useEffect(() => { if (!partyOpen) setUnfinished(draftLine(loadDraft(NEW))); }, [partyOpen]);
  const seg = (on: boolean): React.CSSProperties => ({
    cursor: 'pointer', flex: 'none', minHeight: 44, padding: '0 14px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', gap: 6,
    fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', whiteSpace: 'nowrap', scrollSnapAlign: 'start',
    background: on ? 'var(--grad-accent)' : 'transparent', color: on ? '#fff' : 'var(--ink)',
    boxShadow: on ? t('0 4px 14px var(--accent-30)') : 'none',
  });
  return (
    <div style={{ margin: '10px 12px 4px' }}>
      <div role="tablist" aria-label={t('Your plans')} className="glass no-scrollbar" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 999, overflowX: 'auto', scrollSnapType: 'x proximity' }}>
        <div {...pressable(() => setTab('diary'), 'tab')} aria-selected={tab === 'diary'} style={seg(tab === 'diary')}>{t('MY DIARY')}</div>
        {plans.map((p) => (
          <div key={p.id} {...pressable(() => setTab(p.id), 'tab')} aria-selected={tab === p.id} style={{ ...seg(tab === p.id), maxWidth: 180 }}>
            <UsersIcon size={12} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</span>
            {p.locked_at ? <span aria-label={t('Locked')} style={{ fontSize: 9, opacity: 0.85 }}>●</span> : null}
          </div>
        ))}
        <div {...pressable(() => store.set({ planId: null, partyOpen: true }))} aria-label={t('New plan')} style={{ ...seg(false), color: 'var(--color-accent-700)' }}>+ {t('NEW')}</div>
      </div>
      {unfinished && tab === 'diary' && (
        <div
          {...pressable(() => store.set({ planId: null, partyOpen: true }))}
          className="glass lift"
          style={{ cursor: 'pointer', marginTop: 8, borderRadius: 'var(--r-lg)', padding: 12, display: 'flex', gap: 11, alignItems: 'center' }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>{t('PICK UP WHERE YOU LEFT OFF')}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{unfinished}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 2 }}>{t('A plan you started naming. Tap to finish it.')}</div>
          </div>
          <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)' }} />
        </div>
      )}
      {plans.length === 0 && tab === 'diary' && (
        <div style={{ fontSize: 11, color: 'var(--ink-60)', margin: '10px 4px 0', lineHeight: 1.5 }}>{t('No dates and no bookings needed — start a plan, pull friends in, decide together.')}</div>
      )}
    </div>
  );
}

export default function PlanView() {
  const bookings = useApp((s) => s.bookings);
  const demo = useApp((s) => s.demo);
  const groups = groupsFor(demo, bookings);
  const flights = useApp((s) => s.flights);
  const plans = useApp((s) => s.plans);
  const planId = useApp((s) => s.planId);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The tab follows the open plan: openPlan() from anywhere (an event kept
  // into a plan, a join link, the sheet's ALL PLANS list) lands here on that
  // plan's board. Picking a tab opens that plan so the sheet agrees.
  const [tab, setTab] = useState<PlanTab>(planId ?? 'diary');
  useEffect(() => { if (planId && plans.some((p) => p.id === planId)) setTab(planId); }, [planId, plans]);
  const pick = (next: PlanTab) => {
    setTab(next);
    if (next !== 'diary' && next !== planId) void openPlan(next);
  };
  const plan = tab !== 'diary' ? plans.find((p) => p.id === tab) ?? null : null;
  useEffect(() => { if (tab !== 'diary' && !plan) setTab('diary'); }, [tab, plan]);

  // INVITES sit above everything on PLAN — this is where people come to feel
  // connected, and until 19 Sep none of what friends, hosts and plans were
  // asking showed here. Re-read on every visit to the tab.
  const me = useApp((s) => s.me);
  useEffect(() => { if (me) { void refreshRequests(); void refreshAgenda(); } }, [me?.id]);

  if (!demo && plan) {
    return (
      <div ref={scrollRef} className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 20 }}>
        <InviteRail variant="plan" />
        <PlanTabs tab={tab} setTab={pick} />
        <PlanBoard plan={plan} scrollRef={scrollRef} />
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 20 }}>
      {!demo && <InviteRail variant="plan" />}
      {!demo && <PlanTabs tab={tab} setTab={pick} />}
      {/* YOUR DAY, at the top of your plan (18 Sep 2026). These three came off
          TODAY, which had become the concierge's screen and your diary at the
          same time. The fortnight leads, because it is the shape of the week
          that everything below is read against; then the next thing that
          actually happens; then whether anything needs you.

          NextUp is told the flights are already on this screen — the FLIGHTS
          section is directly below, and its watching branch would otherwise
          draw the same flight card twice. */}
      <CalendarStrip />
      <NextUp withWatchedFlights={false} />
      <TripCheck />
      {flights.length > 0 && (
        <div>
          <div style={{ padding: '18px 18px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 14, letterSpacing: '.05em' }}>{t('FLIGHTS')}<span style={{ display: 'block', width: 28, height: 3, borderRadius: 999, background: 'var(--grad-accent)', marginTop: 3 }} />
            </span>
            <span {...pressable(() => store.set({ flightWatchOpen: true }))} className="tap" style={{ fontSize: 10, letterSpacing: '.1em', color: 'var(--color-accent)', fontWeight: 700, cursor: 'pointer', padding: '0 4px' }}>{t('WATCH ANOTHER')}</span>
          </div>
          <div style={{ display: 'grid', gap: 8, margin: '0 12px' }}>{flights.map((w) => <FlightCard key={w.id} w={w} compact />)}</div>
        </div>
      )}
      {groups.map(({ key, name, dates, items }) => (
        <div key={key}>
          <div style={{ padding: '18px 18px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 14, letterSpacing: '.05em' }}>
              {name}
              <span style={{ display: 'block', width: 28, height: 3, borderRadius: 999, background: 'var(--grad-accent)', marginTop: 3 }} />
            </span>
            <span style={{ fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-60)' }}>{dates}</span>
          </div>
          {items.map((b) => (
            <BookingRow key={b.id} b={b} />
          ))}
        </div>
      ))}
      <div style={{ padding: '12px 20px 16px', fontSize: 11.5, color: 'var(--ink-60)', lineHeight: 1.5, textAlign: 'center' }}>
        {groups.length === 0 ? (
          <div className="rise-in">
            <svg width="120" height="84" viewBox="0 0 120 84" fill="none" aria-hidden="true" style={{ display: 'block', margin: '0 auto 10px' }}><path d="M14 66c18-10 30-2 46-14s26-12 46-2" stroke="var(--ink-12)" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 8"/><path d="M60 14c-9 0-16 7-16 16 0 12 16 30 16 30s16-18 16-30c0-9-7-16-16-16Z" fill="var(--color-accent)"/><circle cx="60" cy="30" r="6" fill="#fff"/><circle cx="104" cy="62" r="7" fill="var(--color-accent)" opacity=".35"/><circle cx="16" cy="62" r="5" fill="var(--color-accent)" opacity=".25"/></svg>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15, color: 'var(--ink)' }}>{t('Nothing planned yet')}</div>
            <div style={{ marginTop: 4 }}>{t('Ask NUM for a table, a car or a whole evening. It lands here by itself.')}</div>
            <div {...pressable(() => store.set({ threadOpen: true }))} className="press tap" style={{ display: 'inline-flex', marginTop: 12, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '0 18px', cursor: 'pointer' }}>{t('ASK NUM')}</div>
          </div>
        ) : t('Nothing to add here — new plans come from the thread. Ask, and it appears.')}
      </div>
    </div>
  );
}
