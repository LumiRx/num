// "Watch a flight" — a number and a date, then NUM keeps an eye on it.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { XIcon } from '../../lib/icons';
import { refreshFlights, stopWatching, watchFlight } from '../../lib/flightwatch';
import FlightCard from './FlightCard';

const field: React.CSSProperties = {
  width: '100%', height: 46, borderRadius: 14, border: '1px solid var(--ink-12)', padding: '0 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const button: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center',
};
const today = () => new Date().toISOString().slice(0, 10);

export default function FlightWatchSheet() {
  const open = useApp((s) => s.flightWatchOpen);
  const flights = useApp((s) => s.flights);
  const me = useApp((s) => s.me);
  const prefill = useApp((s) => s.flightWatchPrefill);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);
  const [no, setNo] = useState('');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (open) { setMsg(null); if (prefill) setNo(prefill); void refreshFlights(); } }, [open, prefill]);
  if (!open) return null;
  const close = () => store.set({ flightWatchOpen: false, flightWatchPrefill: null });

  const go = async () => {
    if (!no.trim() || busy) return;
    setBusy(true); setMsg(null);
    const r = await watchFlight(no.trim(), date);
    setBusy(false);
    if (!r.ok) { setMsg(r.error); return; }
    setNo(''); setMsg(`Watching ${r.watch.flight_no}. I’ll only ping you if something changes.`);
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" className="glass-strong sheet-in" style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(92%, calc(100% - var(--safe-top, 0px)))', overflowY: 'auto' }}>
      <div style={grabberStyle} />
      <div {...pressable(close)} aria-label="Close" className="glass press tap" style={{ position: 'absolute', top: 4, right: 4, width: 44, height: 44, borderRadius: 999, cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>
      <div style={{ padding: 16, display: 'grid', gap: 12 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>FLIGHT WATCH</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>Give NUM the flight. It watches.</div>
          <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>One ping when the gate, the time or the plan changes. Nothing otherwise.</div>
        </div>
        {flights.map((w) => (
          <div key={w.id} style={{ display: 'grid', gap: 6 }}>
            <FlightCard w={w} />
            <div {...pressable(() => void stopWatching(w.id))} className="tap" style={{ fontSize: 11, color: 'var(--ink-40)', cursor: 'pointer', justifySelf: 'end', padding: '0 4px' }}>Stop watching {w.flight_no}</div>
          </div>
        ))}
        {!me && <div style={{ fontSize: 12, color: 'var(--ink-60)' }}>Tell NUM who you are first, so it knows who to ping.</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <input value={no} onChange={(e) => setNo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} placeholder="TG917" autoCapitalize="characters" style={field} aria-label="Flight number" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={field} aria-label="Date" />
        </div>
        <div {...pressable(() => void go())} className="press" style={{ ...button, opacity: busy || !me ? 0.6 : 1 }}>{busy ? 'Looking it up…' : 'Watch this flight'}</div>
        {msg && <div style={{ fontSize: 12, color: 'var(--ink-60)', lineHeight: 1.5 }}>{msg}</div>}
      </div>
    </div>
  );
}
