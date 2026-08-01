// Party sheet — the plan a group builds together. It exists before any
// reservation does: items start as ideas, anyone in the plan can add one, and
// the same row becomes the booking when someone locks it in.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, SparklesIcon, XIcon } from '../../lib/icons';
import { addPlanItem, commentOnPlan, confirmPlanItem, createPlan, openPlan, startInvite, syncPlan } from '../../lib/social';
import { askNum } from '../../lib/concierge';

const label: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 };
const field: React.CSSProperties = {
  width: '100%', height: 44, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '12px 16px', display: 'flex', gap: 7, alignItems: 'center',
  justifyContent: 'center', boxShadow: '0 4px 14px rgba(236,48,19,.3)',
};

const STATUS: Record<string, { text: string; bg: string; fg: string }> = {
  idea: { text: 'IDEA', bg: 'rgba(32,30,29,.07)', fg: 'var(--ink-60)' },
  proposed: { text: 'PROPOSED', bg: 'rgba(32,30,29,.07)', fg: 'var(--ink-60)' },
  held: { text: 'HELD', bg: 'rgba(236,48,19,.12)', fg: 'var(--color-accent-700)' },
  confirmed: { text: 'BOOKED', bg: 'rgba(22,140,90,.14)', fg: '#0e6b45' },
  cancelled: { text: 'DROPPED', bg: 'rgba(32,30,29,.07)', fg: 'var(--ink-60)' },
};

export default function PartySheet() {
  const open = useApp((s) => s.partyOpen);
  const me = useApp((s) => s.me);
  const plans = useApp((s) => s.plans);
  const planId = useApp((s) => s.planId);
  const items = useApp((s) => s.planItems);
  const members = useApp((s) => s.planMembers);
  const place = useApp((s) => s.place);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  const feed = useApp((s) => s.planFeed);
  const [title, setTitle] = useState('');
  const [idea, setIdea] = useState('');
  const [say, setSay] = useState('');
  const [busy, setBusy] = useState(false);

  const plan = plans.find((p) => p.id === planId) ?? null;
  const close = () => store.set({ partyOpen: false });

  // A chat that only updates when you poke it isn't a chat. Poll while the
  // sheet is open — 8s matches the "everyone sees this within the minute"
  // promise without hammering the worker — and stop the moment it closes.
  useEffect(() => {
    if (!open || !planId) return;
    const t = setInterval(() => void syncPlan(), 8000);
    return () => clearInterval(t);
  }, [open, planId]);

  const newPlan = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await createPlan(title.trim(), place);
      setTitle('');
    } finally {
      setBusy(false);
    }
  };

  const addIdea = async () => {
    if (!idea.trim()) return;
    setBusy(true);
    try {
      // status stays 'idea' — nothing is reserved, and that is allowed.
      await addPlanItem({ title: idea.trim(), kind: 'idea', status: 'idea' });
      setIdea('');
      await syncPlan();
    } finally {
      setBusy(false);
    }
  };

  const sendComment = async () => {
    if (!say.trim()) return;
    setBusy(true);
    try {
      if (await commentOnPlan(say)) setSay('');
    } finally {
      setBusy(false);
    }
  };

  /**
   * The bridge from "we've decided" to "it's booked": close the sheet and put
   * the request straight into the Num thread, where the booking flow already
   * lives (provider tray, confirmation, mirror back onto this plan). No second
   * booking path to maintain — the group decides here, Num books where Num
   * books.
   */
  const bookWithNum = (itemTitle: string, day?: string | null, place?: string | null) => {
    close();
    void askNum(
      `Book ${itemTitle} for our group plan "${plan?.title ?? 'our plan'}"` +
        `${day ? ` on ${day}` : ''}${place ? ` at ${place}` : ''} — ${members.length || 'a few'} of us.`,
    );
  };

  return (
    <div
      ref={ref}
      className="glass-strong"
      style={{ ...sheetBase, visibility: open ? 'visible' : 'hidden', transform: open ? 'translateY(0)' : 'translateY(105%)', maxHeight: '86%', overflowY: 'auto' }}
    >
      <div style={grabberStyle} />
      <div
        {...pressable(close)}
        aria-label="Close"
        className="glass press"
        style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>

      {!me ? (
        <div style={{ padding: 16 }}>
          <div style={label}>GROUP PLANS</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>Plan it with your friends</div>
          <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 6, lineHeight: 1.55 }}>
            A plan doesn’t need a single reservation to start — drop in ideas, pull friends in, book it when you’ve agreed. You just need an account first so the group knows who’s who.
          </div>
          <div {...pressable(() => store.set({ partyOpen: false, inviteOpen: {} }))} style={{ ...primary, marginTop: 14 }}>
            SET UP MY ACCOUNT
          </div>
        </div>
      ) : !plan ? (
        <div style={{ padding: 16 }}>
          <div style={label}>NEW PLAN</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>What are we planning?</div>
          <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 6, lineHeight: 1.55 }}>
            No dates or bookings needed. Name it, add whoever’s coming, and we’ll firm it up together.
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            <input style={field} placeholder="e.g. Sam’s birthday weekend" value={title} onChange={(e) => setTitle(e.target.value)} />
            <div {...pressable(newPlan)} style={{ ...primary, opacity: busy || !title.trim() ? 0.6 : 1 }}>
              {busy ? 'ONE SEC…' : 'START THE PLAN'}
            </div>
          </div>
          {!!plans.length && (
            <div style={{ marginTop: 18 }}>
              <div style={{ ...label, color: 'var(--ink-60)' }}>YOUR PLANS</div>
              {plans.map((p) => (
                <div
                  key={p.id}
                  {...pressable(() => void openPlan(p.id))}
                  className="glass lift"
                  style={{ cursor: 'pointer', marginTop: 8, padding: '11px 13px', borderRadius: 'var(--r-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{p.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>
                      {p.members ?? 1} in · {p.items ?? 0} {p.items === 1 ? 'item' : 'items'}
                    </div>
                  </div>
                  <SparklesIcon size={13} style={{ color: 'var(--color-accent)' }} />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ padding: 16, borderBottom: '1px solid var(--ink-08)' }}>
            <div style={label}>GROUP PLAN</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>{plan.title}</div>
            <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', marginTop: 3 }}>
              {/* Pluralise off the number actually shown: before the first sync
                  members is empty and the count falls back to 1. */}
              {(members.length || 1) === 1 ? '1 person' : `${members.length} people`}
              {plan.dest ? ` · ${plan.dest}` : ''} · {items.filter((i) => i.status === 'confirmed').length} booked
              {plan.join_code ? ` · code ${plan.join_code}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <div {...pressable(() => { close(); startInvite({ planId: plan.id }); })} style={{ ...primary, flex: 1 }}>
                INVITE FRIENDS
              </div>
              <div
                {...pressable(() => { store.set({ planId: null }); void syncPlan(); })}
                className="glass press"
                style={{ cursor: 'pointer', borderRadius: 999, padding: '12px 16px', fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em' }}
              >
                ALL PLANS
              </div>
            </div>
          </div>

          <div style={{ padding: '12px 16px' }}>
            {items.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', lineHeight: 1.55, padding: '8px 0 14px' }}>
                Nothing in here yet. Drop an idea below — a restaurant, a neighbourhood, “somewhere with a view”. Booking comes later.
              </div>
            )}
            {items.map((i) => {
              const st = STATUS[i.status] ?? STATUS.idea;
              return (
                <div key={i.id} className="glass" style={{ marginBottom: 8, padding: '11px 13px', borderRadius: 'var(--r-md)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.3 }}>{i.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-neutral-600)', marginTop: 3 }}>
                        {[i.day, i.time, i.address || i.place].filter(Boolean).join(' · ') || 'no date yet'}
                        {i.by_name ? ` · ${i.by_name}` : ''}
                      </div>
                    </div>
                    <span style={{ flex: 'none', fontSize: 9, fontWeight: 800, letterSpacing: '.1em', padding: '4px 8px', borderRadius: 999, background: st.bg, color: st.fg }}>
                      {st.text}
                    </span>
                  </div>
                  {i.status !== 'confirmed' && i.status !== 'cancelled' && (
                    <div style={{ marginTop: 9, display: 'flex', gap: 14, alignItems: 'center' }}>
                      <div
                        {...pressable(() => bookWithNum(i.title, i.day, i.address || i.place))}
                        style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-accent-700)', cursor: 'pointer', display: 'flex', gap: 5, alignItems: 'center' }}
                      >
                        <SparklesIcon size={12} /> ASK NUM TO BOOK
                      </div>
                      <div
                        {...pressable(() => void confirmPlanItem(i.id))}
                        title="Already reserved it yourself? Mark it booked."
                        style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', color: 'var(--ink-60)', cursor: 'pointer', display: 'flex', gap: 5, alignItems: 'center' }}
                      >
                        <CheckIcon size={12} /> IT’S BOOKED
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <input
                style={{ ...field, flex: 1 }}
                placeholder="Add an idea…"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void addIdea(); }}
              />
              <div {...pressable(addIdea)} style={{ ...primary, padding: '12px 18px', opacity: busy || !idea.trim() ? 0.6 : 1 }}>ADD</div>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--color-neutral-500)', lineHeight: 1.55, marginTop: 10 }}>
              Everyone in the plan sees this within the minute — their Num tells them what changed, and anything booked lands on all your calendars.
            </div>

            {/* The group's own thread: comments from people, one-liners from
                their Nums, in the order they happened. Same feed the server
                pushes on — nothing here is a second timeline. */}
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--ink-08)' }}>
              <div style={{ ...label, color: 'var(--ink-60)' }}>GROUP CHAT</div>
              <div style={{ marginTop: 8, display: 'grid', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                {feed.length === 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--color-neutral-500)', lineHeight: 1.5 }}>
                    Nothing said yet. Anything you type here reaches everyone on the plan.
                  </div>
                )}
                {feed.map((e) =>
                  e.kind === 'comment' ? (
                    <div
                      key={e.id}
                      className="glass"
                      style={{
                        padding: '8px 11px', borderRadius: 'var(--r-md)',
                        border: e.by_id === me?.id ? '1px solid var(--color-accent)' : '1px solid var(--ink-08)',
                        justifySelf: e.by_id === me?.id ? 'end' : 'start', maxWidth: '88%',
                      }}
                    >
                      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-accent-700)' }}>
                        {e.by_id === me?.id ? 'YOU' : (e.by_name || 'FRIEND').toUpperCase()}
                      </div>
                      <div style={{ fontSize: 12.5, lineHeight: 1.45, marginTop: 2 }}>{e.summary}</div>
                    </div>
                  ) : (
                    <div key={e.id} style={{ fontSize: 10.5, color: 'var(--color-neutral-500)', textAlign: 'center', lineHeight: 1.4 }}>
                      {e.summary}
                    </div>
                  ),
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input
                  style={{ ...field, flex: 1 }}
                  placeholder="Say it to the group…"
                  value={say}
                  onChange={(e) => setSay(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void sendComment(); }}
                />
                <div {...pressable(sendComment)} style={{ ...primary, padding: '12px 18px', opacity: busy || !say.trim() ? 0.6 : 1 }}>
                  SEND
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
