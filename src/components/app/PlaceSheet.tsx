// "Where are you?" — the one control a first-timer needs, without typing it
// into the thread.
//
// Two ways to answer, in the order people reach for them: the phone's own fix
// (one tap, and it is a real position rather than a claim), or a typed place
// ("Kata, Phuket"). Either way the answer goes where the concierge already
// reads it — `place` and `here` in state — so nothing downstream changes.
//
// Audit B3, 17 Sep 2026: the header said "Where to?" with a chevron and opened
// the calendar. This is what the chevron opens now until a place is known.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { fixPosition } from '../../lib/whereami';
import { XIcon } from '../../lib/icons';

const field: React.CSSProperties = {
  width: '100%', height: 46, borderRadius: 14, border: '1px solid var(--ink-12)', padding: '0 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const button: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center',
};
const ghost: React.CSSProperties = { ...button, background: 'transparent', color: 'var(--color-text)', border: '1px solid var(--ink-12)' };

/** The places NUM is deepest in, as one-tap chips. */
const QUICK = ['Patong, Phuket', 'Kata, Phuket', 'Phuket Town', 'Bangkok', 'Edinburgh', 'London'];

export default function PlaceSheet() {
  const open = useApp((s) => s.placeOpen);
  const current = useApp((s) => s.place);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (open) { setText(current ?? ''); setNote(null); } }, [open, current]);
  if (!open) return null;

  const close = () => store.set({ placeOpen: false });
  const commit = (place: string) => {
    const p = place.trim();
    if (!p) return;
    store.set({ place: p, onboarded: true, placeOpen: false });
  };
  const locate = async () => {
    setBusy(true); setNote(null);
    const fix = await fixPosition();
    setBusy(false);
    if (!fix) { setNote('No fix from the phone. Type where you are instead.'); return; }
    // The coordinate is what the concierge and Suggest use; the name is for
    // the header, and "Near me" is honest until NUM has resolved it.
    store.set({ here: fix, place: current ?? 'Near me', onboarded: true, placeOpen: false });
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" className="glass-strong" style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(80%, calc(100% - var(--safe-top, 0px)))', overflowY: 'auto' }}>
      <div style={grabberStyle} />
      <div {...pressable(close)} aria-label="Close" className="glass press tap" style={{ position: 'absolute', top: 4, right: 4, width: 44, height: 44, borderRadius: 999, cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>WHERE ARE YOU?</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>Tell NUM where you are</div>
        <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>
          Everything NUM suggests starts from here. Your position is never shown to anyone.
        </div>
        <div {...pressable(() => { if (!busy) void locate(); })} className="press" style={{ ...button, marginTop: 14, opacity: busy ? 0.7 : 1 }}>
          {busy ? 'Finding you…' : 'Use my location'}
        </div>
        {note && <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 10 }}>{note}</div>}
        <div style={{ ...ghost, marginTop: 8, padding: 0, border: 0 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(text); }}
            placeholder="Or type it: Kata, Phuket"
            enterKeyHint="done"
            style={field}
          />
        </div>
        <div className="no-scrollbar" style={{ display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto' }}>
          {QUICK.map((q) => (
            <div key={q} {...pressable(() => commit(q))} className="glass lift" style={{ cursor: 'pointer', borderRadius: 999, padding: '7px 12px', fontSize: 11.5, fontWeight: 600, flex: 'none', whiteSpace: 'nowrap' }}>{q}</div>
          ))}
        </div>
        {text.trim() && text.trim() !== current && (
          <div {...pressable(() => commit(text))} className="press" style={{ ...button, marginTop: 12 }}>I’m in {text.trim()}</div>
        )}
      </div>
    </div>
  );
}
