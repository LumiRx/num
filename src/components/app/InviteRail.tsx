// INVITES — everything someone wants you at, answered in a tap.
//
// One component, two places. On TODAY it is WAITING ON YOU (since 9 Sep):
// a connection request, a dinner invite, a plan that moved. On PLAN (19 Sep
// 2026) it is the INVITES rail at the top of the tab — the same cards, plus
// "are you in?" for a plan you're on but haven't answered — because that is
// where people go to feel connected, and until today none of it showed there.
//
// Every card answers the same way: I'M IN · MAYBE · CAN'T. Invites can pile
// up, so past three the rail folds ("and 4 more"), and any source — this
// friend, this plan, this host — can be muted with one tap. Muting is yours
// alone (kept on this phone); it hides, it never declines for you.
import { useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { respond } from '../../lib/requests';
import { openPlan } from '../../lib/social';
import { guestMessage } from '../../lib/saferr';
import { t } from '../../lib/i18n';
import { cardsOf, muteKeyOf, FOLD_AT } from '../../lib/invites';
import type { InviteCard } from '../../lib/invites';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 13 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };
const h: React.CSSProperties = { fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 };
const inputStyle: React.CSSProperties = {
  width: '100%', height: 40, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 12px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};

export default function InviteRail({ variant }: { variant: 'today' | 'plan' }) {
  const inbox = useApp((s) => s.inbox);
  const me = useApp((s) => s.me);
  const muted = useApp((s) => s.mutedInvites ?? []);
  const seen = useApp((s) => s.seenPlanNews ?? {});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [when, setWhen] = useState('');
  const [open, setOpen] = useState(false);

  /**
   * This plan's news is read. The card goes, and stays gone until something
   * new happens in the plan. Recorded per plan rather than as a blanket
   * "hide", so the next real change still reaches the home screen.
   */
  const markRead = (planId: string) => {
    const latest = inbox.plans.find((p) => p.id === planId)?.latest;
    if (!latest) return;
    store.set((s) => ({ seenPlanNews: { ...(s.seenPlanNews ?? {}), [planId]: latest } }));
  };

  /**
   * ── WHERE "I'M IN" LANDS (20 Sep 2026, Dre's call) ────────────────────
   *
   * "After you click I'm in it should go to plans."
   *
   * It used to answer the card and leave you on TODAY, looking at the same
   * card. Saying yes to a plan IS joining it, and the thing you just joined
   * is a tab away — so we open it and go there. `openPlan` loads the board;
   * `view: 'plan'` is what actually moves the person. Only from TODAY: on
   * the PLAN tab you are already there, and yanking the view would throw
   * away whichever plan you had open.
   */
  const goToPlan = (planId: string) => {
    void openPlan(planId);
    if (variant === 'today') store.set({ view: 'plan' });
  };

  const act = async (kind: 'connect' | 'plan' | 'event', id: string, action: 'accept' | 'decline' | 'propose' | 'message', extra = {}) => {
    setBusy(id);
    try {
      // Read BEFORE the refresh: respond() re-reads the inbox, and `latest`
      // usually changes when you answer ("Dre is in"), so recording it after
      // would mark the new line read as well and swallow the next card.
      if (kind === 'plan') markRead(id);
      setNote(await respond(kind, id, action, extra));
      setReplyTo(null); setDraft(''); setWhen('');
      if (kind === 'plan' && action === 'accept') goToPlan(id);
      // Saying yes to a friend's plan makes it yours — open it, and go there.
      if (kind === 'connect' && action === 'accept') {
        const c = inbox.connects.find((x) => x.id === id);
        if (c?.plan_id) goToPlan(c.plan_id);
      }
    } catch (err) {
      setNote(guestMessage(err, t('That didn’t go through.')));
    } finally {
      setBusy(null);
    }
  };
  /**
   * × on a card. For a friend or a host this mutes the SOURCE — everything
   * from them, until they are unmuted. For a plan that is too blunt: the ×
   * on a news card means "I've read this", not "never tell me about this
   * plan again", and muting the plan would hide the next real change too.
   * So a news card is marked read and a plan still waiting on a vote is the
   * only plan the mute key is used for.
   */
  const dismiss = (c: { kind: InviteCard['kind']; from?: string | null; id: string; needsVote?: boolean }) => {
    if (c.kind === 'plan' && !c.needsVote) { markRead(c.id); return; }
    const key = muteKeyOf(c);
    store.set((s) => ({ mutedInvites: [...new Set([...(s.mutedInvites ?? []), key])] }));
  };

  const cards = cardsOf(inbox, muted, { newsToo: variant === 'today', seen });
  const pending = cards.filter((c) => c.kind !== 'plan' || c.needsVote).length;
  if (!me || cards.length === 0) return null;
  const shown = variant === 'plan' && !open && cards.length > FOLD_AT ? cards.slice(0, FOLD_AT) : cards;

  const Btn = ({ label, onClick, primary: p, quiet }: { label: string; onClick: () => void; primary?: boolean; quiet?: boolean }) => (
    <span
      {...pressable(onClick)}
      className={p ? 'press' : t('glass press')}
      style={{
        cursor: 'pointer', borderRadius: 999, minHeight: 36, padding: '0 13px', display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 700, letterSpacing: '.04em',
        ...(p ? { background: 'var(--grad-accent)', color: '#fff' } : { color: quiet ? 'var(--ink-40)' : 'var(--ink)' }),
      }}
    >
      {label}
    </span>
  );

  return (
    <div className="glass" style={{ ...card, borderLeft: pending ? '3px solid var(--color-accent)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={kicker}>{variant === 'plan' ? t('INVITES') : t('WAITING ON YOU')}</div>
        {pending > 0 && (
          <span style={{ background: 'var(--grad-accent)', color: '#fff', fontSize: 9, fontWeight: 800, borderRadius: 999, padding: '2px 7px' }}>{pending}</span>
        )}
      </div>

      {shown.map((c) => (
        <div key={`${c.kind}:${c.id}`} style={{ marginTop: 11, paddingTop: 11, borderTop: '1px solid var(--ink-08)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={h}>{c.title}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3, lineHeight: 1.45 }}>{c.sub}</div>
              {c.kind === 'event' && inbox.events.find((e) => e.token === c.id)?.via === 'agent' && (
                <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 3 }}>{t('Their NUM asked yours — answer here or in your messages.')}</div>
              )}
            </div>
            <span {...pressable(() => dismiss(c))} aria-label={c.kind === 'plan' && !c.needsVote ? t('Mark as read') : t('Mute invites from here')} className="tap" style={{ cursor: 'pointer', flex: 'none', minWidth: 36, minHeight: 36, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-40)', fontSize: 16, lineHeight: 1 }}>×</span>
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
            {c.kind === 'connect' && (
              <>
                <Btn label={busy === c.id ? '…' : t('I’M IN')} primary onClick={() => void act('connect', c.id, 'accept')} />
                <Btn label={t('NOT NOW')} onClick={() => void act('connect', c.id, 'decline')} />
              </>
            )}
            {c.kind === 'event' && (
              <>
                <Btn label={busy === c.id ? '…' : t('I’M IN')} primary onClick={() => void act('event', c.id, 'accept')} />
                <Btn label={t('MAYBE')} onClick={() => void act('event', c.id, 'propose')} />
                <Btn label={t('CAN’T')} onClick={() => void act('event', c.id, 'decline')} />
                <Btn label={t('REPLY')} quiet onClick={() => setReplyTo(replyTo === c.id ? null : c.id)} />
              </>
            )}
            {/* A plan you are ALREADY IN does not get asked again. Until
              * today every plan card carried I'M IN · ANOTHER TIME · CAN'T,
              * including the news cards for plans you had joined weeks ago —
              * three answers to a question nobody asked, and the reason the
              * card looked broken when tapping the obvious button changed
              * nothing on screen. News gets one action: open it. */}
            {c.kind === 'plan' && c.needsVote && (
              <>
                <Btn label={busy === c.id ? '…' : t('I’M IN')} primary onClick={() => void act('plan', c.id, 'accept')} />
                <Btn label={t('ANOTHER TIME')} onClick={() => setReplyTo(replyTo === c.id ? null : c.id)} />
                <Btn label={t('CAN’T')} onClick={() => void act('plan', c.id, 'decline')} />
              </>
            )}
            {c.kind === 'plan' && !c.needsVote && (
              <Btn label={t('OPEN')} primary onClick={() => { markRead(c.id); goToPlan(c.id); }} />
            )}
            {c.kind === 'plan' && c.needsVote && (
              <Btn label={t('OPEN')} quiet onClick={() => { markRead(c.id); goToPlan(c.id); }} />
            )}
          </div>
          {replyTo === c.id && c.kind === 'event' && (
            <div style={{ display: 'grid', gap: 7, marginTop: 9 }}>
              <input style={inputStyle} placeholder={t('A note back to the host…')} value={draft} onChange={(ev) => setDraft(ev.target.value)} />
              <Btn label={t('SEND')} primary onClick={() => void act('event', c.id, 'accept', { message: draft })} />
            </div>
          )}
          {replyTo === c.id && c.kind === 'plan' && (
            <div style={{ display: 'grid', gap: 7, marginTop: 9 }}>
              <input style={inputStyle} placeholder={t('When suits you? e.g. Friday 8pm')} value={when} onChange={(ev) => setWhen(ev.target.value)} />
              <input style={inputStyle} placeholder={t('Add a note (optional)')} value={draft} onChange={(ev) => setDraft(ev.target.value)} />
              <Btn label={t('SUGGEST IT')} primary onClick={() => void act('plan', c.id, 'propose', { time: when, message: draft })} />
            </div>
          )}
        </div>
      ))}

      {variant === 'plan' && cards.length > FOLD_AT && (
        <div {...pressable(() => setOpen((v) => !v))} className="tap" style={{ cursor: 'pointer', marginTop: 10, minHeight: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--color-accent-700)' }}>
          {open ? t('SHOW FEWER') : t('AND {n} MORE', { n: cards.length - FOLD_AT })}
        </div>
      )}
      {note && <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 10 }}>{note}</div>}
    </div>
  );
}
