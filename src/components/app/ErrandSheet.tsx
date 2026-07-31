// The errand board — "someone go and get this", and "I'll go".
//
// Two audiences in one sheet, because they are the same people at different
// moments: the person who needs something, and the person willing to fetch it.
// Splitting them into separate screens would mean nobody ever discovers the
// half they are not currently in.
//
// The design decision that runs through this: **say what happens to the money
// before the tap, not after.** Posting an errand takes Stars out of your
// balance immediately. That is the feature — it is what makes a stranger
// willing to walk twenty minutes — but only if the person posting understands
// it, so the button itself carries the number.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import type { AppState } from '../../lib/types';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { StarIcon, XIcon } from '../../lib/icons';
import { act, loadBoard, nextActions, postErrand, startErrandSync, stateLine, type Errand } from '../../lib/errands';

const field: React.CSSProperties = {
  width: '100%', height: 46, borderRadius: 14, border: '1px solid var(--ink-12)', padding: '0 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const button: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center',
};
const ghost: React.CSSProperties = {
  ...button, background: 'transparent', color: 'var(--ink-60)', border: '1px solid var(--ink-12)',
};
const kicker: React.CSSProperties = { fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 };

export default function ErrandSheet() {
  const open = useApp((s) => s.errandsOpen);
  const board = useApp((s) => s.errands);
  const mine = useApp((s) => s.myErrands);
  const balance = useApp((s) => s.stars);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  const draft = useApp((s) => s.errandDraft);
  const [tab, setTab] = useState<'board' | 'mine' | 'new'>('board');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Arriving from the concierge means there is already a proposal — land on
    // the form with it filled in, not on a board they did not ask for.
    if (draft) setTab('new');
    void loadBoard(store.get().place);
    return startErrandSync();
  }, [open, draft]);

  if (!open) return null;
  const close = () => store.set({ errandsOpen: false });
  const list = tab === 'mine' ? mine : board;

  return (
    <div ref={ref} role="dialog" aria-modal="true" className="glass-strong" style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: '90%', overflowY: 'auto' }}>
      <div style={grabberStyle} />
      <div {...pressable(close)} aria-label="Close" className="glass press" style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>

      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>ERRANDS</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>
          {tab === 'new' ? 'What do you need?' : 'Someone nearby can go'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>
          {tab === 'new'
            ? 'Say what it is, where it’s going, and what it’s worth. The Stars are held until it’s in your hands.'
            : 'Post something you need fetched, or earn Stars fetching for someone else.'}
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
          {(['board', 'mine', 'new'] as const).map((t) => (
            <div
              key={t}
              {...pressable(() => { setTab(t); setMsg(null); })}
              style={{
                cursor: 'pointer', borderRadius: 999, padding: '7px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em',
                border: '1px solid var(--ink-12)',
                background: tab === t ? 'var(--grad-accent)' : 'transparent',
                color: tab === t ? '#fff' : 'var(--ink-60)',
              }}
            >
              {t === 'board' ? 'NEARBY' : t === 'mine' ? 'MINE' : 'POST ONE'}
            </div>
          ))}
        </div>

        {msg && <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 12, lineHeight: 1.5 }}>{msg}</div>}

        {tab === 'new' ? (
          <NewErrand balance={balance} hasAccount={!!me} draft={draft} onDone={(m) => { setMsg(m); setTab('mine'); }} />
        ) : (
          <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
            {list.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--ink-40)', lineHeight: 1.6, padding: '10px 2px' }}>
                {tab === 'mine'
                  ? 'Nothing of yours yet. Post something you need, or take one from Nearby.'
                  : 'Nothing nearby right now. Post the first one — it’s how the board starts.'}
              </div>
            )}
            {list.map((e) => <Card key={e.id} e={e} onMsg={setMsg} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ e, onMsg }: { e: Errand; onMsg: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handoff, setHandoff] = useState('');
  const [spent, setSpent] = useState('');

  const run = async (action: string, extra?: Record<string, unknown>) => {
    setBusy(true);
    const out = await act(e.id, action, extra as never);
    if (!out.ok) onMsg(out.message);
    setBusy(false);
    setConfirming(false);
  };

  const actions = nextActions(e);
  const live = !['settled', 'cancelled'].includes(e.state);

  return (
    <div className="glass" style={{ borderRadius: 14, padding: '12px 13px', opacity: live ? 1 : 0.6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{e.title}</div>
          {e.detail && <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 2, lineHeight: 1.45 }}>{e.detail}</div>}
          <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 4 }}>
            {e.where_from ? `${e.where_from} → ` : ''}{e.deliver_to}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 3 }}>{stateLine(e)}</div>
        </div>
        <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 17 }}>★{e.bounty.toLocaleString()}</div>
          {e.spend_cap > 0 && <div style={{ fontSize: 10, color: 'var(--ink-40)' }}>+ up to ★{e.spend_cap} to spend</div>}
        </div>
      </div>

      {/* The handoff code is the proof of delivery — shown only to the two
          people it concerns, and only while it still means something. */}
      {e.handoff_code && ['claimed', 'collected', 'delivered'].includes(e.state) && (
        <div style={{ marginTop: 9, padding: '7px 10px', borderRadius: 10, background: 'var(--field-bg)', border: '1px solid var(--ink-08)' }}>
          <div style={kicker}>{e.is_mine ? 'GIVE THIS CODE ON HANDOVER' : 'ASK FOR THIS ON HANDOVER'}</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 17, letterSpacing: '.16em', marginTop: 2 }}>{e.handoff_code}</div>
        </div>
      )}

      {confirming ? (
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          <input style={{ ...field, height: 42, letterSpacing: '.14em' }} placeholder="Handoff code" maxLength={6}
            value={handoff} onChange={(ev) => setHandoff(ev.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())} />
          {e.spend_cap > 0 && (
            <input style={{ ...field, height: 42 }} inputMode="numeric" placeholder={`What did it cost? (up to ★${e.spend_cap})`}
              value={spent} onChange={(ev) => setSpent(ev.target.value.replace(/[^\d]/g, ''))} />
          )}
          <div style={{ fontSize: 10.5, color: 'var(--ink-40)', lineHeight: 1.5 }}>
            Confirming releases ★{(e.bounty + Math.min(e.spend_cap, Number(spent) || 0)).toLocaleString()} to {e.runner_name ?? 'them'}. Anything unspent comes back to you. This can’t be undone.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div {...pressable(() => run('confirm', { handoff_code: handoff, spent: Number(spent) || 0 }))}
              style={{ ...button, flex: 1, opacity: busy || handoff.length !== 6 ? 0.55 : 1 }}>
              {busy ? 'PAYING…' : 'CONFIRM & PAY'}
            </div>
            <div {...pressable(() => setConfirming(false))} style={{ ...ghost, flex: 'none', padding: '13px 16px' }}>BACK</div>
          </div>
        </div>
      ) : actions.length > 0 ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {actions.map((a) => (
            <div key={a.action}
              {...pressable(() => (a.action === 'confirm' ? setConfirming(true) : run(a.action)))}
              style={{ ...(a.primary ? button : ghost), flex: 1, minWidth: 110, padding: '11px 14px', opacity: busy ? 0.55 : 1 }}>
              {a.label.toUpperCase()}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NewErrand({ balance, hasAccount, draft, onDone }: {
  balance: number; hasAccount: boolean;
  draft: AppState['errandDraft'];
  onDone: (m: string) => void;
}) {
  const [title, setTitle] = useState(draft?.title ?? '');
  const [detail, setDetail] = useState(draft?.detail ?? '');
  const [from, setFrom] = useState(draft?.where_from ?? '');
  const [to, setTo] = useState(draft?.deliver_to ?? '');
  // Pre-filled from the concierge's proposal, and still requiring the tap that
  // names the number — the model suggests a bounty, the person agrees to it.
  const [bounty, setBounty] = useState(draft?.bounty ? String(draft.bounty) : '');
  const [cap, setCap] = useState(draft?.spend_cap ? String(draft.spend_cap) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const held = (Number(bounty) || 0) + (Number(cap) || 0);
  const affordable = held > 0 && held <= balance;
  const ready = title.trim() && to.trim() && affordable;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setErr(null);
    const out = await postErrand({
      title: title.trim(),
      detail: detail.trim() || undefined,
      where_from: from.trim() || undefined,
      deliver_to: to.trim(),
      bounty: Number(bounty),
      spend_cap: Number(cap) || 0,
    });
    setBusy(false);
    if (out.ok) {
      store.set({ errandDraft: null });
      onDone(out.message);
    }
    else setErr(out.message);
  };

  if (!hasAccount) {
    return (
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--ink-60)', lineHeight: 1.55 }}>
          Add your name and number first — errands move real Stars between people, so we need to know whose they are.
        </div>
        <div {...pressable(() => store.set({ errandsOpen: false, inviteOpen: {} }))} style={{ ...button, marginTop: 14 }}>
          INTRODUCE YOURSELF
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 9, marginTop: 14 }}>
      <input style={field} placeholder="What do you need?" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input style={field} placeholder="Any detail that matters (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} />
      <input style={field} placeholder="Where from? (optional)" value={from} onChange={(e) => setFrom(e.target.value)} />
      <input style={field} placeholder="Deliver to — address or room" value={to} onChange={(e) => setTo(e.target.value)} />
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ ...field, flex: 1 }} inputMode="numeric" placeholder="Bounty ★" value={bounty} onChange={(e) => setBounty(e.target.value.replace(/[^\d]/g, ''))} />
        <input style={{ ...field, flex: 1 }} inputMode="numeric" placeholder="Spend cap ★" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d]/g, ''))} />
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--ink-40)', lineHeight: 1.55 }}>
        The <b>bounty</b> is what they earn. The <b>spend cap</b> is what they’re allowed to lay out on the thing itself — they get that back too, and anything unspent returns to you.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--ink-60)' }}>
        <StarIcon size={12} style={{ color: 'var(--color-accent)' }} /> You have ★{balance.toLocaleString()}
      </div>

      <div {...pressable(submit)} style={{ ...button, opacity: busy || !ready ? 0.55 : 1 }}>
        {busy
          ? 'POSTING…'
          : held > balance
            ? `NEED ★${held.toLocaleString()} — YOU HAVE ★${balance.toLocaleString()}`
            : held > 0
              ? `POST IT — HOLDS ★${held.toLocaleString()}`
              : 'SET A BOUNTY'}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--ink-40)', lineHeight: 1.55 }}>
        ★{held.toLocaleString() || '0'} leaves your balance the moment you post and is held by Num until you confirm delivery. That’s what makes a stranger willing to go. Cancel before anyone claims it and you get all of it back.
      </div>
      {err && <div style={{ fontSize: 11.5, color: 'var(--color-accent)' }}>{err}</div>}
    </div>
  );
}
