// The live tab, as everyone at the table sees it.
//
// Three states in one sheet, because a tab has three moments and switching
// screens between them is how you lose people at a loud bar:
//
//   nothing open  → start one, or type the code someone just read out
//   open          → the running total, who bought what, what you owe
//   settling      → one tap, and the Stars move
//
// The number that matters is YOUR number. Everyone else's split is there to
// be checked, but it is quieter — you came here to find out what you owe.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { StarIcon, XIcon } from '../../lib/icons';
import { addItem, closeTab, joinTab, openTab, settleTab, startTabSync } from '../../lib/tabs';

const field: React.CSSProperties = {
  width: '100%', height: 46, borderRadius: 14, border: '1px solid var(--ink-12)', padding: '0 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const button: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center',
};
const ghost: React.CSSProperties = {
  ...button, background: 'transparent', color: 'var(--ink-60)', border: '1px solid var(--ink-12)', boxShadow: 'none',
};

export default function TabSheet() {
  const tab = useApp((s) => s.tabOpen);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(!!tab, ref);

  const [label, setLabel] = useState('');
  const [stars, setStars] = useState('');
  const [only, setOnly] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Other people are buying rounds while this is on screen, so the split has
  // to move on its own.
  useEffect(() => (tab ? startTabSync() : undefined), [tab?.tab.id]);

  if (!tab) return null;
  const close = () => store.set({ tabOpen: null });
  const mine = tab.split.find((s) => s.member_id === me?.id);
  const live = tab.tab.state === 'open';

  const log = async () => {
    const n = Math.floor(Number(stars));
    if (!label.trim() || !Number.isFinite(n) || n <= 0) return;
    setBusy(true);
    setMsg(null);
    try {
      await addItem(label.trim(), n, only.length ? only : undefined);
      setLabel('');
      setStars('');
      setOnly([]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'That didn’t go on.');
    }
    setBusy(false);
  };

  const settle = async () => {
    setBusy(true);
    const out = await settleTab();
    setMsg(out.message);
    setBusy(false);
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" className="glass-strong" style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: '90%', overflowY: 'auto' }}>
      <div style={grabberStyle} />
      <div {...pressable(close)} aria-label="Close" className="glass press" style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>

      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>
          {live ? 'LIVE TAB' : 'TAB CLOSED'}
        </div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>{tab.tab.title}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 3 }}>
          {tab.tab.venue ? `${tab.tab.venue} · ` : ''}★{tab.total.toLocaleString()} on the tab · {tab.members.length} {tab.members.length === 1 ? 'person' : 'people'}
        </div>

        {/* The code is the whole join flow — read it out, they are on. */}
        {live && (
          <div className="glass" style={{ borderRadius: 14, padding: '11px 14px', marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 }}>ANYONE CAN JOIN WITH</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, letterSpacing: '.18em', marginTop: 2 }}>{tab.tab.code}</div>
            </div>
            <div {...pressable(() => void navigator.clipboard?.writeText(tab.tab.code).then(() => setMsg('Code copied.')))} style={{ ...ghost, padding: '9px 14px', fontSize: 10.5 }}>
              COPY
            </div>
          </div>
        )}

        {/* Your number, big. Everyone else's is below and smaller. */}
        {mine && (
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 }}>
              {mine.net < 0 ? 'YOU OWE' : mine.net > 0 ? 'YOU’RE OWED' : 'YOU’RE SQUARE'}
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 38, lineHeight: 1.1, marginTop: 2, color: mine.net < 0 ? 'var(--color-accent)' : 'var(--color-text)' }}>
              ★{Math.abs(mine.net).toLocaleString()}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 2 }}>
              you put in ★{mine.paid.toLocaleString()} · your share ★{mine.owes.toLocaleString()}
            </div>
          </div>
        )}

        {/* What is on the tab, newest last — the order it was bought in. */}
        {tab.items.length > 0 && (
          <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
            {tab.items.map((it) => (
              <div key={it.id} className="glass" style={{ borderRadius: 12, padding: '9px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 1 }}>
                    {it.paid_by_name || 'Someone'} paid
                    {it.shared_with ? ` · split ${(JSON.parse(it.shared_with) as string[]).length} ways` : ' · everyone'}
                  </div>
                </div>
                <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap' }}>★{it.stars.toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}

        {/* Add a round. "Everyone" is the default, so it costs no taps. */}
        {live && (
          <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...field, flex: 1 }} placeholder="What was it?" value={label} onChange={(e) => setLabel(e.target.value)} />
              <input style={{ ...field, width: 96 }} inputMode="numeric" placeholder="★" value={stars} onChange={(e) => setStars(e.target.value.replace(/[^\d]/g, ''))} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <div
                {...pressable(() => setOnly([]))}
                style={{ cursor: 'pointer', borderRadius: 999, padding: '6px 12px', fontSize: 11, fontWeight: 600, border: '1px solid var(--ink-12)', background: only.length ? 'transparent' : 'var(--grad-accent)', color: only.length ? 'var(--ink-60)' : '#fff' }}
              >
                Everyone
              </div>
              {tab.members.map((m) => {
                const on = only.includes(m.member_id);
                return (
                  <div
                    key={m.member_id}
                    {...pressable(() => setOnly((prev) => (on ? prev.filter((x) => x !== m.member_id) : [...prev, m.member_id])))}
                    style={{ cursor: 'pointer', borderRadius: 999, padding: '6px 12px', fontSize: 11, fontWeight: 600, border: '1px solid var(--ink-12)', background: on ? 'var(--grad-accent)' : 'transparent', color: on ? '#fff' : 'var(--ink-60)' }}
                  >
                    {m.name || 'Guest'}
                  </div>
                );
              })}
            </div>
            <div {...pressable(log)} style={{ ...button, opacity: busy || !label.trim() || !stars ? 0.55 : 1 }}>
              {busy ? 'ADDING…' : 'PUT IT ON THE TAB'}
            </div>
          </div>
        )}

        {/* Where everyone stands. Quiet, but checkable. */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 }}>WHERE EVERYONE STANDS</div>
          <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
            {tab.split.map((s) => (
              <div key={s.member_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5, padding: '5px 2px' }}>
                <div style={{ fontWeight: s.member_id === me?.id ? 700 : 500 }}>
                  {s.name || 'Guest'}
                  {/* "settled" only holds while it is still true — a round
                      bought after someone paid up puts them back in the red. */}
                  {s.settled_at && s.net === 0 ? <span style={{ color: 'var(--ink-40)', fontWeight: 500 }}> · settled</span> : null}
                </div>
                <div style={{ color: s.net < 0 ? 'var(--color-accent)' : s.net > 0 ? 'var(--ink-60)' : 'var(--ink-40)', fontWeight: 600 }}>
                  {s.net === 0 ? 'square' : s.net < 0 ? `owes ★${Math.abs(s.net).toLocaleString()}` : `up ★${s.net.toLocaleString()}`}
                </div>
              </div>
            ))}
          </div>
        </div>

        {msg && <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 12, lineHeight: 1.5 }}>{msg}</div>}

        <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
          {mine && mine.net < 0 && (
            <div {...pressable(settle)} style={{ ...button, opacity: busy ? 0.55 : 1 }}>
              {busy ? 'SETTLING…' : `SETTLE UP — ★${Math.abs(mine.net).toLocaleString()}`}
            </div>
          )}
          {live && tab.tab.owner_id === me?.id && (
            <div {...pressable(() => void closeTab())} style={ghost}>CLOSE THE TAB</div>
          )}
        </div>

        <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 12, lineHeight: 1.5 }}>
          Stars are in-app credit, not money. Settling moves them between Num accounts straight away — check the split above first, because it can’t be undone from here.
        </div>
      </div>
    </div>
  );
}

/**
 * The way in, for when there is no tab yet. Lives in the wallet, because that
 * is where someone looks when they are thinking about what they owe.
 */
export function TabStarter() {
  const me = useApp((s) => s.me);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = async (fn: () => Promise<unknown>) => {
    if (!me) return store.set({ walletOpen: false, inviteOpen: {} });
    setBusy(true);
    setErr(null);
    try {
      await fn();
      store.set({ walletOpen: false });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t work.');
    }
    setBusy(false);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
        <StarIcon size={11} style={{ color: 'var(--color-accent)' }} /> SPLIT A NIGHT OUT
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>
        Open a tab and everyone puts their rounds on it. Num keeps the split honest — you only pay for what you were in on.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          // Uppercase the value, not the placeholder — "JOIN CODE" shouted at
          // someone who has not typed anything reads as an instruction.
          style={{ ...field, flex: 1, ...(code ? { letterSpacing: '.14em', textTransform: 'uppercase' as const } : {}) }}
          placeholder="Join code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())}
        />
        <div
          {...pressable(() => void go(() => (code.length === 6 ? joinTab(code) : openTab('Tonight'))))}
          style={{ ...button, padding: '13px 18px', whiteSpace: 'nowrap', opacity: busy ? 0.55 : 1 }}
        >
          {busy ? '…' : code.length === 6 ? 'JOIN' : 'OPEN A TAB'}
        </div>
      </div>
      {err && <div style={{ fontSize: 11.5, color: 'var(--color-accent)', marginTop: 8 }}>{err}</div>}
    </div>
  );
}
