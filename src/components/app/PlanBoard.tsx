// THE PLAN BOARD (18 Sep 2026) — a plan, inline on the PLAN tab.
//
// A plan is a set of days; a day is a set of hours; an hour holds the things
// the group has put there. Everything on the board is a real row on the
// server (num_plan_items), read back every eight seconds, so six phones see
// the same day. What this file adds over the old PartySheet list:
//
//   · a tab per plan (PlanView) and a chip per day here, with an hourly grid
//   · drag a card to another hour or day — pointer events, so it works with a
//     thumb; one reorder call per drop; optimistic, reconciled by the answer
//   · comments ON an item, not only in the group chat
//   · a lock only the owner holds — while it is on, nothing else moves
//   · money: an amount per item in the plan's currency, who paid, who it is
//     split across; the total, per head, and who owes whom; settle in Stars
//     (USD plans, ★1 = $1) or mark it paid outside
//
// Nothing here is a second source of truth: the server computes the money
// from the items on every read (worker/social.mjs planMoney), and the board
// only shows it.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { CheckIcon, ChevronRightIcon, SparklesIcon, UsersIcon } from '../../lib/icons';
import {
  addPlanItem, commentOnItem, confirmPlanItem, lockPlan, patchPlanItem, reorderPlanItems,
  setPlanSpan, settlePlan, startInvite, syncPlan,
} from '../../lib/social';
import { askNum } from '../../lib/concierge';
import { t } from '../../lib/i18n';
import { HOURS, addDays, dayLabel, fmtMinor, hourLabel, hourOf, inOrder, initials, landing, spanDays } from '../../lib/planboard';
import type { PartyPlan, PlanItem, PlanMoney } from '../../lib/types';

// ── shared bits ────────────────────────────────────────────────────────────

const kicker: CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' };
const quiet: CSSProperties = { fontSize: 11, color: 'var(--ink-60)' };
const field: CSSProperties = {
  width: '100%', height: 44, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 12px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const chip = (on: boolean): CSSProperties => ({
  cursor: 'pointer', flex: 'none', minHeight: 40, padding: '0 14px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', gap: 6,
  fontSize: 11.5, fontWeight: 700, letterSpacing: '.04em', whiteSpace: 'nowrap',
  background: on ? 'var(--grad-accent)' : 'var(--field-bg)', color: on ? '#fff' : 'var(--ink)',
  border: on ? '1px solid transparent' : '1px solid var(--ink-12)',
  boxShadow: on ? '0 4px 14px rgba(14,164,131,.28)' : 'none',
});
const primary: CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', minHeight: 44, padding: '0 16px', display: 'inline-flex', gap: 7, alignItems: 'center',
  justifyContent: 'center', boxShadow: '0 4px 14px rgba(14,164,131,.3)',
};
const ghost: CSSProperties = { ...primary, background: 'var(--field-bg)', color: 'var(--ink)', border: '1px solid var(--ink-12)', boxShadow: 'none' };

const STATUS: Record<string, { text: string; bg: string; fg: string }> = {
  idea: { text: 'IDEA', bg: 'rgba(32,30,29,.07)', fg: 'var(--ink-60)' },
  proposed: { text: 'PROPOSED', bg: 'rgba(32,30,29,.07)', fg: 'var(--ink-60)' },
  held: { text: 'HELD', bg: 'rgba(14,164,131,.12)', fg: 'var(--color-accent-700)' },
  confirmed: { text: 'BOOKED', bg: 'rgba(22,140,90,.14)', fg: '#0e6b45' },
  cancelled: { text: 'DROPPED', bg: 'rgba(32,30,29,.07)', fg: 'var(--ink-60)' },
};


// ── the board ──────────────────────────────────────────────────────────────

/** A drag in flight: which card, and where the thumb is over right now. */
interface Drag { id: string; title: string; x: number; y: number; over: string | null; before: string | null }

export default function PlanBoard({ plan, scrollRef }: { plan: PartyPlan; scrollRef?: React.RefObject<HTMLDivElement | null> }) {
  const me = useApp((s) => s.me);
  const items = useApp((s) => s.planItems);
  const members = useApp((s) => s.planMembers);
  const money = useApp((s) => s.planMoney);
  const feed = useApp((s) => s.planFeed);
  const owner = !!me && plan.owner_id === me.id;
  const locked = !!plan.locked_at;
  const canEdit = !!me && (!locked || owner);
  const currency = plan.currency || 'USD';

  // Keep the board live while it is on screen — same cadence as the sheet.
  useEffect(() => {
    void syncPlan();
    const id = setInterval(() => void syncPlan(), 8000);
    return () => clearInterval(id);
  }, [plan.id]);

  // DAYS: the span the plan covers, plus any day an item was put on outside
  // it, plus ANYTIME for whatever has no day yet.
  const live = useMemo(() => items.filter((i) => i.status !== 'cancelled'), [items]);
  const days = useMemo(() => {
    const set = new Set(spanDays(plan.starts_on, plan.ends_on));
    for (const i of live) if (i.day) set.add(i.day);
    return [...set].sort();
  }, [plan.starts_on, plan.ends_on, live]);
  const undated = live.filter((i) => !i.day);
  const [day, setDay] = useState<string | 'any'>(() => days[0] ?? 'any');
  useEffect(() => { if (day !== 'any' && !days.includes(day)) setDay(days[0] ?? 'any'); }, [days, day]);
  useEffect(() => { if (day === 'any' && days.length && !undated.length) setDay(days[0]); }, [days, day, undated.length]);

  const [showMoney, setShowMoney] = useState(false);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const addDay = async () => {
    if (!plan.starts_on) return;
    const last = plan.ends_on ?? plan.starts_on;
    if (await setPlanSpan({ ends_on: addDays(last, 1) })) setDay(addDays(last, 1));
  };
  const flipLock = async () => { await lockPlan(!locked); };
  const addPeople = () => startInvite({ planId: plan.id, intent: 'plan', returnTo: { view: 'plan' } });

  // ── DRAG. Pointer events on the handle; the card's ghost follows the thumb;
  // the slot under the thumb lights up; on release one reorder call moves it.
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const startDrag = (it: PlanItem) => (e: React.PointerEvent) => {
    if (!canEdit) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const d: Drag = { id: it.id, title: it.title, x: e.clientX, y: e.clientY, over: null, before: null };
    dragRef.current = d; setDrag(d);
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    // What is under the thumb: a slot (hour row) and maybe a card inside it.
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const slot = el?.closest?.('[data-slot]') as HTMLElement | null;
    const card = el?.closest?.('[data-item]') as HTMLElement | null;
    const next: Drag = { ...d, x: e.clientX, y: e.clientY, over: slot?.dataset.slot ?? d.over, before: card && card.dataset.item !== d.id ? card.dataset.item ?? null : null };
    dragRef.current = next; setDrag(next);
    // Auto-scroll the board when the thumb nears the top or bottom edge.
    const sc = scrollRef?.current;
    if (sc) {
      const r = sc.getBoundingClientRect();
      if (e.clientY < r.top + 70) sc.scrollBy(0, -12);
      else if (e.clientY > r.bottom - 90) sc.scrollBy(0, 12);
    }
  };
  const endDrag = async () => {
    const d = dragRef.current;
    dragRef.current = null; setDrag(null);
    if (!d || !d.over) return;
    // Where it landed and what order the slot takes — lib/planboard.ts landing().
    // itemsRef, not items: the window listener that calls this was bound when
    // the drag began, and an 8-second sync may have refreshed the list since.
    const { moves, changed } = landing(itemsRef.current, d.id, d.over, d.before);
    if (changed) await reorderPlanItems(moves);
  };
  // A drag that leaves the window still ends.
  useEffect(() => {
    if (!drag) return;
    const up = () => { void endDrag(); };
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag]);

  const dayItems = (d: string | 'any') => live.filter((i) => (d === 'any' ? !i.day : i.day === d));
  const shown = dayItems(day);
  const anytime = shown.filter((i) => !hourOf(i.time)).sort(inOrder);
  const byHour = (hh: string) => shown.filter((i) => hourOf(i.time) === hh).sort(inOrder);
  const spend = (d: string | 'any') => dayItems(d).reduce((s, i) => s + (Number(i.cost_minor) || 0), 0);

  return (
    <div style={{ padding: '0 12px 8px', touchAction: drag ? 'none' : undefined }} onPointerMove={drag ? moveDrag : undefined}>
      {/* ── header ── */}
      <div className="glass" style={{ borderRadius: 'var(--r-lg)', padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={kicker}>{locked ? t('LOCKED PLAN') : t('GROUP PLAN')}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 4, lineHeight: 1.2 }}>{plan.title}</div>
            <div style={{ ...quiet, marginTop: 4 }}>
              {plan.starts_on ? `${dayLabel(plan.starts_on)}${plan.ends_on && plan.ends_on !== plan.starts_on ? ` – ${dayLabel(plan.ends_on)}` : ''}` : t('No date yet')}
              {plan.dest ? ` · ${plan.dest}` : ''} · {members.length || 1} {members.length === 1 ? t('person') : t('people')} · {currency}
            </div>
          </div>
          {owner ? (
            <div {...pressable(() => void flipLock())} aria-label={locked ? t('Unlock the plan') : t('Lock the plan')} className="press tap" style={{ ...chip(locked), minHeight: 40 }}>
              <LockGlyph open={!locked} /> {locked ? t('LOCKED') : t('LOCK')}
            </div>
          ) : locked ? (
            <span style={{ ...chip(true), cursor: 'default' }}><LockGlyph open={false} /> {t('LOCKED')}</span>
          ) : null}
        </div>
        {locked && !owner && (
          <div style={{ ...quiet, marginTop: 8 }}>{t('Whoever started the plan has locked it. You can still comment and vote; nothing moves until they unlock it.')}</div>
        )}

        {/* people */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          {members.map((m) => (
            <span key={m.member_id} title={m.name ?? ''} style={{ width: 32, height: 32, borderRadius: 999, background: m.member_id === me?.id ? 'var(--grad-accent)' : 'var(--field-bg)', color: m.member_id === me?.id ? '#fff' : 'var(--ink)', border: '1px solid var(--ink-12)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800 }}>
              {initials(m.member_id === me?.id ? (me?.name ?? m.name) : m.name)}
            </span>
          ))}
          <div {...pressable(addPeople)} className="press tap" style={{ ...chip(false), minHeight: 32, padding: '0 12px', fontSize: 11 }}>
            <UsersIcon size={12} /> {t('ADD PEOPLE')}
          </div>
          <div {...pressable(() => store.set({ partyOpen: true }))} className="press tap" style={{ ...chip(false), minHeight: 32, padding: '0 12px', fontSize: 11, marginLeft: 'auto' }}>
            {t('GROUP CHAT')} <ChevronRightIcon size={12} />
          </div>
        </div>

        {/* money strip */}
        <div {...pressable(() => setShowMoney((v) => !v))} className="tap" style={{ cursor: 'pointer', marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 'var(--r-md)', background: 'var(--field-bg)', border: '1px solid var(--ink-08)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 800, color: 'var(--ink-40)' }}>{t('TOTAL SPEND')}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 17, color: 'var(--money)', marginTop: 2 }}>
              {fmtMinor(money?.total_minor ?? live.reduce((s, i) => s + (Number(i.cost_minor) || 0), 0), currency)}
              <span style={{ ...quiet, fontFamily: 'var(--font-body)', fontWeight: 600, marginLeft: 8 }}>
                {money && members.length > 1 ? `${fmtMinor(money.per_head_minor, currency)} ${t('each')}` : ''}
              </span>
            </div>
          </div>
          <span style={{ ...kicker, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{showMoney ? t('HIDE') : t('SPLIT & SETTLE')} <ChevronRightIcon size={12} style={{ transform: showMoney ? 'rotate(90deg)' : 'none' }} /></span>
        </div>
        {showMoney && money && <MoneyPanel money={money} meId={me?.id ?? null} currency={currency} onNote={setNote} />}
        {note && <div style={{ ...quiet, marginTop: 8, color: 'var(--color-accent-700)', fontWeight: 600 }}>{note}</div>}
      </div>

      {/* ── days ── */}
      {!plan.starts_on ? (
        <div className="glass" style={{ marginTop: 10, borderRadius: 'var(--r-lg)', padding: 14 }}>
          <div style={kicker}>{t('WHEN')}</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14, marginTop: 4 }}>{t('Pick the first day and the hours open up.')}</div>
          <input type="date" aria-label={t('First day')} disabled={!canEdit} style={{ ...field, marginTop: 10, fontSize: 14 }} onChange={(e) => { if (e.target.value) void setPlanSpan({ starts_on: e.target.value }); }} />
        </div>
      ) : (
        <div className="no-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '12px 2px 4px', scrollSnapType: 'x proximity' }}>
          {days.map((d) => {
            const n = dayItems(d).length;
            const cost = spend(d);
            return (
              <div key={d} {...pressable(() => setDay(d))} role="tab" aria-selected={day === d} className="tap" data-slot={drag ? `${d}|` : undefined}
                style={{ ...chip(day === d), flexDirection: 'column', alignItems: 'flex-start', gap: 1, minHeight: 48, padding: '6px 14px', scrollSnapAlign: 'start', outline: drag?.over === `${d}|` ? '2px solid var(--color-accent)' : 'none' }}>
                <span>{dayLabel(d)}</span>
                <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.8 }}>{n ? `${n} ${n === 1 ? t('thing') : t('things')}` : t('empty')}{cost ? ` · ${fmtMinor(cost, currency)}` : ''}</span>
              </div>
            );
          })}
          {undated.length > 0 && (
            <div {...pressable(() => setDay('any'))} role="tab" aria-selected={day === 'any'} className="tap" style={{ ...chip(day === 'any'), minHeight: 48, scrollSnapAlign: 'start' }}>
              {t('ANYTIME')} · {undated.length}
            </div>
          )}
          {canEdit && (
            <div {...pressable(() => void addDay())} aria-label={t('Add a day')} className="tap" style={{ ...chip(false), minHeight: 48, borderStyle: 'dashed' }}>+ {t('DAY')}</div>
          )}
        </div>
      )}

      {/* ── the day, hour by hour ── */}
      {(plan.starts_on || undated.length > 0) && (
        <div className="glass" style={{ marginTop: 6, borderRadius: 'var(--r-lg)', padding: '6px 0 10px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '8px 14px 6px' }}>
            <span style={kicker}>{day === 'any' ? t('NO DAY YET') : dayLabel(day).toUpperCase()}</span>
            <span style={quiet}>{shown.length ? `${shown.length} · ${fmtMinor(spend(day), currency)}` : t('Nothing here yet')}</span>
          </div>

          {/* no set time */}
          <Slot slot={`${day}|`} label={t('Anytime')} drag={drag} items={anytime} openItem={openItem} setOpenItem={setOpenItem}
            canEdit={canEdit} startDrag={startDrag} members={members} meId={me?.id ?? null} currency={currency} feed={feed} plan={plan} day={day} hour={null} always={day === 'any' || anytime.length > 0} />

          {day !== 'any' && HOURS.map((hh) => (
            <Slot key={hh} slot={`${day}|${hh}`} label={hourLabel(hh)} drag={drag} items={byHour(hh)} openItem={openItem} setOpenItem={setOpenItem}
              canEdit={canEdit} startDrag={startDrag} members={members} meId={me?.id ?? null} currency={currency} feed={feed} plan={plan} day={day} hour={hh} always={false} />
          ))}

          {canEdit && <Composer day={day === 'any' ? null : day} />}
          {!canEdit && !me && (
            <div style={{ padding: '6px 14px 4px' }}>
              <div {...pressable(() => store.set({ inviteOpen: { intent: 'plan', planId: plan.id, returnTo: { view: 'plan' } } }))} style={{ ...primary, width: '100%' }}>{t('SET UP MY ACCOUNT TO JOIN IN')}</div>
            </div>
          )}
        </div>
      )}

      {/* the ghost that follows the thumb */}
      {drag && (
        <div aria-hidden="true" style={{ position: 'fixed', left: drag.x + 12, top: drag.y - 22, zIndex: 80, pointerEvents: 'none', maxWidth: 220, padding: '9px 12px', borderRadius: 12, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12.5, boxShadow: '0 10px 28px rgba(14,164,131,.35)', transform: 'rotate(-2deg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {drag.title}
        </div>
      )}
    </div>
  );
}

function LockGlyph({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      {open ? <path d="M8 11V7a4 4 0 0 1 7.5-2" /> : <path d="M8 11V7a4 4 0 0 1 8 0v4" />}
    </svg>
  );
}

// ── one hour of the day ────────────────────────────────────────────────────

type Member = { member_id: string; name: string | null; role: string };

interface SlotProps {
  slot: string; label: string; drag: Drag | null; items: PlanItem[];
  openItem: string | null; setOpenItem: (id: string | null) => void;
  canEdit: boolean; startDrag: (it: PlanItem) => (e: React.PointerEvent) => void;
  members: Member[]; meId: string | null; currency: string; feed: import('../../lib/types').PlanEvent[];
  plan: PartyPlan; day: string | 'any'; hour: string | null; always: boolean;
}

function Slot(p: SlotProps) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const over = p.drag?.over === p.slot;
  const empty = p.items.length === 0;
  // An empty hour is a thin line with the hour on it — the day reads as a
  // day, not as seventeen boxes. It grows when a card is dragged over it,
  // or when someone taps it to add something right there.
  if (empty && !p.always && !p.drag && !adding) {
    return (
      <div data-slot={p.slot} {...(p.canEdit ? pressable(() => setAdding(true)) : {})} className={p.canEdit ? 'tap' : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', minHeight: 30, cursor: p.canEdit ? 'pointer' : 'default' }}>
        <span style={{ width: 52, fontSize: 10.5, fontWeight: 700, color: 'var(--ink-40)', flex: 'none', lineHeight: 1.1 }}>{p.label}</span>
        <span style={{ flex: 1, height: 1, background: 'var(--ink-08)' }} />
        {p.canEdit && <span style={{ fontSize: 14, color: 'var(--ink-40)', width: 20, textAlign: 'center' }}>+</span>}
      </div>
    );
  }
  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await addPlanItem({ title: text.trim(), kind: 'idea', status: 'idea', day: p.day === 'any' ? null : p.day, time: p.hour ? `${p.hour}:00` : null });
      setText(''); setAdding(false);
      await syncPlan();
    } finally { setBusy(false); }
  };
  return (
    <div data-slot={p.slot} style={{ display: 'flex', gap: 10, padding: '4px 14px', minHeight: 44, background: over ? 'rgba(14,164,131,.10)' : 'transparent', borderLeft: over ? '3px solid var(--color-accent)' : '3px solid transparent', transition: 'background .15s' }}>
      <span style={{ width: 52, paddingTop: 12, fontSize: 10.5, fontWeight: 700, color: p.items.length ? 'var(--ink)' : 'var(--ink-40)', flex: 'none', lineHeight: 1.1 }}>{p.label}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
        {p.items.map((it) => (
          <ItemCard key={it.id} it={it} open={p.openItem === it.id} onToggle={() => p.setOpenItem(p.openItem === it.id ? null : it.id)}
            canEdit={p.canEdit} onDrag={p.startDrag(it)} members={p.members} meId={p.meId} currency={p.currency} feed={p.feed} plan={p.plan} dragging={p.drag?.id === it.id} landing={p.drag?.before === it.id} />
        ))}
        {empty && p.drag && <div style={{ minHeight: 30, borderRadius: 10, border: '1.5px dashed var(--ink-12)' }} />}
        {adding && (
          <div style={{ display: 'flex', gap: 6 }}>
            <input autoFocus style={{ ...field, flex: 1, height: 40, fontSize: 15 }} placeholder={p.hour ? t('Add at {h}…', { h: p.label }) : t('Add an idea…')} value={text}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); if (e.key === 'Escape') setAdding(false); }} onBlur={() => { if (!text.trim()) setAdding(false); }} />
            <div {...pressable(() => void add())} style={{ ...primary, minHeight: 40, padding: '0 14px', opacity: busy || !text.trim() ? 0.6 : 1 }}>{t('ADD')}</div>
          </div>
        )}
        {!empty && !adding && p.canEdit && p.hour && (
          <div {...pressable(() => setAdding(true))} className="tap" style={{ cursor: 'pointer', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--ink-40)', minHeight: 36, display: 'flex', alignItems: 'center' }}>+ {t('ADD HERE')}</div>
        )}
      </div>
    </div>
  );
}

// ── one thing on the plan ──────────────────────────────────────────────────

interface CardProps {
  it: PlanItem; open: boolean; onToggle: () => void; canEdit: boolean; onDrag: (e: React.PointerEvent) => void;
  members: Member[]; meId: string | null; currency: string; feed: import('../../lib/types').PlanEvent[]; plan: PartyPlan;
  dragging: boolean; landing: boolean;
}

function ItemCard(p: CardProps) {
  const { it } = p;
  const st = STATUS[it.status] ?? STATUS.idea;
  const paidBy = it.paid_by ? p.members.find((m) => m.member_id === it.paid_by) : null;
  const sub = [
    it.time && it.time.slice(3) !== '00' ? it.time : null,
    it.address || it.place,
    it.cost_minor ? `${fmtMinor(it.cost_minor, p.currency)}${paidBy ? ` · ${paidBy.member_id === p.meId ? t('you paid') : t('{name} paid', { name: paidBy.name ?? t('a friend') })}` : ''}` : it.cost,
  ].filter(Boolean).join(' · ');
  return (
    <div data-item={it.id} className="glass" style={{ borderRadius: 'var(--r-md)', padding: '9px 10px 9px 6px', opacity: p.dragging ? 0.35 : 1, outline: p.landing ? '2px solid var(--color-accent)' : 'none', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
      {/* the handle — the only place a drag starts, so a tap on the card still opens it */}
      {p.canEdit ? (
        <div onPointerDown={p.onDrag} aria-label={t('Drag to another time')} role="button" tabIndex={0}
          style={{ flex: 'none', width: 28, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab', touchAction: 'none', color: 'var(--ink-40)', userSelect: 'none', WebkitUserSelect: 'none' }}>
          <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.6" /><circle cx="9" cy="3" r="1.6" /><circle cx="3" cy="8" r="1.6" /><circle cx="9" cy="8" r="1.6" /><circle cx="3" cy="13" r="1.6" /><circle cx="9" cy="13" r="1.6" /></svg>
        </div>
      ) : <div style={{ width: 6 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div {...pressable(p.onToggle)} className="tap" aria-expanded={p.open} style={{ cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'flex-start', minHeight: 44 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3, textDecoration: it.status === 'cancelled' ? 'line-through' : 'none' }}>{it.title}</div>
            {sub && <div style={{ ...quiet, marginTop: 3, color: it.cost_minor ? 'var(--money)' : 'var(--ink-60)' }}>{sub}</div>}
          </div>
          <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', padding: '3px 7px', borderRadius: 999, background: st.bg, color: st.fg }}>{t(st.text)}</span>
            {(it.comments ?? 0) > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-accent-700)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" /></svg>
                {it.comments}
              </span>
            )}
          </div>
        </div>
        {p.open && <ItemDetail {...p} />}
      </div>
    </div>
  );
}

/** Everything about one thing: when, how much, who paid, who shares it, what people said. */
function ItemDetail(p: CardProps) {
  const { it, canEdit, members, meId, currency } = p;
  const [amount, setAmount] = useState(it.cost_minor != null ? String(it.cost_minor / 100) : '');
  const [say, setSay] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAmount(it.cost_minor != null ? String(it.cost_minor / 100) : ''); }, [it.cost_minor]);
  const talk = p.feed.filter((e) => e.kind === 'comment' && e.item_id === it.id);
  const split = it.split_with && it.split_with.length ? it.split_with : members.map((m) => m.member_id);
  const done = it.status === 'confirmed' || it.status === 'cancelled';

  const saveAmount = async () => {
    const n = amount.trim() === '' ? null : Math.round(Number(amount.replace(/[^\d.]/g, '')) * 100);
    if (n !== null && !Number.isFinite(n)) return;
    if ((n ?? null) === (it.cost_minor ?? null)) return;
    await patchPlanItem(it.id, { cost_minor: n, cost: n == null ? '' : fmtMinor(n, currency) });
  };
  const flipSplit = async (id: string) => {
    const next = split.includes(id) ? split.filter((x) => x !== id) : [...split, id];
    if (!next.length) return;
    // Everyone selected = no list at all, so a new member joins the split automatically.
    await patchPlanItem(it.id, { split_with: next.length === members.length ? null : next });
  };
  const send = async () => {
    if (!say.trim() || busy) return;
    setBusy(true);
    try { if (await commentOnItem(it.id, say)) setSay(''); } finally { setBusy(false); }
  };
  const book = () => {
    store.set({ threadOpen: true });
    void askNum(`Book ${it.title} for our group plan "${p.plan.title}"${it.day ? ` on ${it.day}` : ''}${it.time ? ` at ${it.time}` : ''}${it.address || it.place ? ` at ${it.address || it.place}` : ''} — ${members.length || 'a few'} of us.`);
  };

  // Labels sit ABOVE their fields: the card is narrow (hour column + handle
  // beside it), and a label column beside a date and a time input left them
  // too thin to read the date in.
  const row: CSSProperties = { display: 'grid', gap: 5 };
  const lab: CSSProperties = { fontSize: 10, letterSpacing: '.12em', fontWeight: 800, color: 'var(--ink-40)' };
  const small: CSSProperties = { ...field, height: 40, fontSize: 14 };

  return (
    <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--ink-08)', display: 'grid', gap: 6 }}>
      {/* when */}
      <div style={row}>
        <span style={lab}>{t('WHEN')}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {/* 13px, not 14: Chrome's native date/time text is wide, and at 14 a
              full date lost its year inside this card. iOS draws its own wheel. */}
          <input type="date" value={it.day ?? ''} disabled={!canEdit} aria-label={t('Day')} style={{ ...small, flex: 1.3, fontSize: 13, padding: '0 8px', minWidth: 0 }} onChange={(e) => void patchPlanItem(it.id, { day: e.target.value || '' })} />
          <input type="time" value={it.time ?? ''} disabled={!canEdit} aria-label={t('Time')} style={{ ...small, flex: 1, fontSize: 13, padding: '0 8px', minWidth: 0 }} onChange={(e) => void patchPlanItem(it.id, { time: e.target.value || '' })} />
        </div>
      </div>
      {/* how much */}
      <div style={row}>
        <span style={lab}>{t('COST')}</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 6, alignItems: 'center' }}>
          <input inputMode="decimal" placeholder={`0.00 ${currency}`} value={amount} disabled={!canEdit} aria-label={t('Amount')} style={{ ...small, minWidth: 0 }}
            onChange={(e) => setAmount(e.target.value)} onBlur={() => void saveAmount()} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          <select value={it.paid_by ?? ''} disabled={!canEdit} aria-label={t('Paid by')} style={{ ...small, minWidth: 0, appearance: 'auto' }} onChange={(e) => void patchPlanItem(it.id, { paid_by: e.target.value || '' })}>
            <option value="">{t('Nobody paid yet')}</option>
            {members.map((m) => <option key={m.member_id} value={m.member_id}>{m.member_id === meId ? t('You paid') : t('{name} paid', { name: m.name ?? t('Friend') })}</option>)}
          </select>
        </div>
      </div>
      {/* who shares it */}
      {members.length > 1 && (
        <div style={row}>
          <span style={lab}>{t('SPLIT')}</span>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {members.map((m) => {
              const on = split.includes(m.member_id);
              return (
                <span key={m.member_id} {...(canEdit ? pressable(() => void flipSplit(m.member_id)) : {})} aria-pressed={on}
                  style={{ ...chip(on), minHeight: 30, padding: '0 10px', fontSize: 10.5, cursor: canEdit ? 'pointer' : 'default', opacity: on ? 1 : 0.6 }}>
                  {m.member_id === meId ? t('You') : m.name ?? t('Friend')}
                </span>
              );
            })}
            {it.cost_minor ? <span style={{ ...quiet, alignSelf: 'center' }}>{fmtMinor(Math.floor(it.cost_minor / split.length), currency)} {t('each')}</span> : null}
          </div>
        </div>
      )}
      {it.note && <div style={{ ...quiet, lineHeight: 1.5 }}>{it.note}</div>}
      {it.by_name && <div style={quiet}>{t('Added by {name}', { name: it.by_name })}</div>}

      {/* actions */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
        {!done && (
          <>
            <div {...pressable(book)} className="tap" style={{ cursor: 'pointer', minHeight: 40, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-accent-700)' }}><SparklesIcon size={12} /> {t('ASK NUM TO BOOK')}</div>
            {canEdit && <div {...pressable(() => void confirmPlanItem(it.id))} className="tap" style={{ cursor: 'pointer', minHeight: 40, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', color: 'var(--ink-60)' }}><CheckIcon size={12} /> {t('IT’S BOOKED')}</div>}
          </>
        )}
        {canEdit && it.status !== 'cancelled' && (
          <div {...pressable(() => void patchPlanItem(it.id, { status: 'cancelled' }))} className="tap" style={{ cursor: 'pointer', minHeight: 40, display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-neutral-500)', marginLeft: 'auto' }}>{t('TAKE IT OFF')}</div>
        )}
        {canEdit && it.status === 'cancelled' && (
          <div {...pressable(() => void patchPlanItem(it.id, { status: 'idea' }))} className="tap" style={{ cursor: 'pointer', minHeight: 40, display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-accent-700)', marginLeft: 'auto' }}>{t('PUT IT BACK')}</div>
        )}
      </div>

      {/* comments on this */}
      <div style={{ marginTop: 4, paddingTop: 8, borderTop: '1px solid var(--ink-08)' }}>
        <div style={lab}>{t('COMMENTS')}{talk.length ? ` · ${talk.length}` : ''}</div>
        <div style={{ display: 'grid', gap: 5, marginTop: 6 }}>
          {talk.length === 0 && <div style={quiet}>{t('Nothing said about this yet.')}</div>}
          {talk.map((e) => (
            <div key={e.id} style={{ fontSize: 12.5, lineHeight: 1.45 }}>
              <span style={{ fontWeight: 800, fontSize: 10.5, letterSpacing: '.06em', color: 'var(--color-accent-700)', marginRight: 6 }}>{e.by_id === meId ? t('YOU') : (e.by_name || t('FRIEND')).toUpperCase()}</span>
              {e.summary}
            </div>
          ))}
        </div>
        {meId && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input style={{ ...small, flex: 1 }} placeholder={t('Say something about this…')} value={say} onChange={(e) => setSay(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} />
            <div {...pressable(() => void send())} style={{ ...primary, minHeight: 40, padding: '0 14px', opacity: busy || !say.trim() ? 0.6 : 1 }}>{t('SEND')}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Add something to the day — with a time if you have one. */
function Composer({ day }: { day: string | null }) {
  const [text, setText] = useState('');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await addPlanItem({ title: text.trim(), kind: 'idea', status: 'idea', day, time: time || null });
      setText(''); setTime('');
      await syncPlan();
    } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', gap: 6, padding: '10px 14px 4px' }}>
      <input style={{ ...field, flex: 1 }} placeholder={day ? t('Add to this day…') : t('Add an idea…')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
      {day && <input type="time" aria-label={t('Time')} value={time} onChange={(e) => setTime(e.target.value)} style={{ ...field, width: 108, flex: 'none', fontSize: 14 }} />}
      <div {...pressable(() => void add())} style={{ ...primary, padding: '0 14px', opacity: busy || !text.trim() ? 0.6 : 1 }}>{t('ADD')}</div>
    </div>
  );
}

// ── the money ──────────────────────────────────────────────────────────────

/**
 * Per person: paid, their share, the net. Then the fewest payments that
 * square everyone, with the button to make yours. Stars only on a USD plan
 * (★1 = $1 — see planSettle); other currencies mark it paid outside.
 */
function MoneyPanel({ money, meId, currency, onNote }: { money: PlanMoney; meId: string | null; currency: string; onNote: (s: string | null) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const usd = currency === 'USD';
  const pay = async (to: string, minor: number, via: 'stars' | 'outside') => {
    const key = `${to}:${via}`;
    setBusy(key);
    const r = await settlePlan(to, minor, via);
    setBusy(null); setConfirm(null);
    onNote(r.message);
  };
  const mine = money.transfers.filter((x) => x.from_id === meId);
  const owedToMe = money.transfers.filter((x) => x.to_id === meId);
  return (
    <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
      <div>
        <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 800, color: 'var(--ink-40)', marginBottom: 6 }}>{t('PER PERSON')}</div>
        <div style={{ display: 'grid', gap: 4 }}>
          {money.people.map((p) => (
            <div key={p.member_id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 10, alignItems: 'center', fontSize: 12, minHeight: 28 }}>
              <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.member_id === meId ? t('You') : p.name ?? t('Friend')}</span>
              <span style={quiet}>{t('paid')} {fmtMinor(p.paid_minor, currency)}</span>
              <span style={quiet}>{t('share')} {fmtMinor(p.owes_minor, currency)}</span>
              <span style={{ fontWeight: 800, color: p.net_minor > 0 ? '#0e6b45' : p.net_minor < 0 ? '#a3271c' : 'var(--ink-40)', minWidth: 64, textAlign: 'right' }}>
                {p.net_minor === 0 ? t('square') : p.net_minor > 0 ? `+${fmtMinor(p.net_minor, currency)}` : `−${fmtMinor(-p.net_minor, currency)}`}
              </span>
            </div>
          ))}
        </div>
      </div>

      {money.transfers.length > 0 && (
        <div>
          <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 800, color: 'var(--ink-40)', marginBottom: 6 }}>{t('SETTLE UP')}</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {money.transfers.map((x) => {
              const isMine = x.from_id === meId;
              const key = `${x.to_id}`;
              return (
                <div key={`${x.from_id}-${x.to_id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, minHeight: 40 }}>
                  <span style={{ flex: 1, minWidth: 140 }}>
                    <b>{isMine ? t('You') : x.from_name ?? t('Friend')}</b> → <b>{x.to_id === meId ? t('you') : x.to_name ?? t('a friend')}</b>
                    <span style={{ color: 'var(--money)', fontWeight: 800, marginLeft: 8 }}>{fmtMinor(x.minor, currency)}</span>
                  </span>
                  {isMine && confirm !== key && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      {usd && <div {...pressable(() => setConfirm(key))} style={{ ...primary, minHeight: 36, padding: '0 12px', fontSize: 11 }}>★ {t('PAY {n}', { n: Math.ceil(x.minor / 100) })}</div>}
                      <div {...pressable(() => void pay(x.to_id, x.minor, 'outside'))} style={{ ...ghost, minHeight: 36, padding: '0 12px', fontSize: 11, opacity: busy ? 0.6 : 1 }}>{t('PAID OUTSIDE')}</div>
                    </div>
                  )}
                  {isMine && confirm === key && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={quiet}>{t('Send ★{n} now?', { n: Math.ceil(x.minor / 100) })}</span>
                      <div {...pressable(() => void pay(x.to_id, x.minor, 'stars'))} style={{ ...primary, minHeight: 36, padding: '0 12px', fontSize: 11, opacity: busy ? 0.6 : 1 }}>{busy ? '…' : t('YES, PAY')}</div>
                      <div {...pressable(() => setConfirm(null))} style={{ ...ghost, minHeight: 36, padding: '0 12px', fontSize: 11 }}>{t('NOT NOW')}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {mine.length === 0 && owedToMe.length === 0 && <div style={{ ...quiet, marginTop: 6 }}>{t('You’re square. This is what the others still owe each other.')}</div>}
          {!usd && mine.length > 0 && <div style={{ ...quiet, marginTop: 6 }}>{t('This plan is in {c}. Stars are dollars, so pay your friend however you usually do and mark it paid here.', { c: currency })}</div>}
        </div>
      )}
      {money.transfers.length === 0 && money.total_minor > 0 && <div style={quiet}>{t('Everyone’s square.')}</div>}
      {money.total_minor === 0 && <div style={quiet}>{t('Put an amount on anything the group pays for and the split appears here.')}</div>}

      {money.settlements.length > 0 && (
        <div>
          <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 800, color: 'var(--ink-40)', marginBottom: 4 }}>{t('ALREADY SETTLED')}</div>
          {money.settlements.map((s) => (
            <div key={s.id} style={{ ...quiet, minHeight: 22, display: 'flex', alignItems: 'center' }}>
              {s.from_id === meId ? t('You') : s.from_name ?? t('Friend')} → {s.to_id === meId ? t('you') : s.to_name ?? t('a friend')} · {fmtMinor(s.minor, currency)} · {s.via === 'stars' ? t('through NUM') : t('outside NUM')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
