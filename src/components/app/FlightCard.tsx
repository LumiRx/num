// The Flight Watch card — a boarding-pass stub that is alive.
//
// A dotted arc between the two airport codes; the plane rides it in real
// time and the dots behind it fill in. The sky behind everything is the local
// time where the plane is, so "they are flying through the night" reads
// without a word. A delay turns the pill amber and the arrival time flips.
// Landing flips the card to arrivals: belt, terminal, and the one button that
// matters ("Car from the airport", which asks NUM — it does not book).
//
// Everything printed here came from the airline via AeroDataBox. Nothing is
// computed except progress along the arc, which is drawn, not stated.
import { useEffect, useState } from 'react';
import { pressable } from '../../lib/a11y';
import { askNum } from '../../lib/concierge';
import { headline, hhmm, progress, sky, stopWatching, type FlightWatch } from '../../lib/flightwatch';
import { t } from '../../lib/i18n';

const SKY: Record<ReturnType<typeof sky>, [string, string]> = {
  dawn: ['#F2A07B', '#F6D5B8'], day: ['#2F78C4', '#91CBEB'], dusk: ['#4B3B8F', '#C77C9B'], night: ['#06131C', '#173447'],
};

export default function FlightCard({ w, compact = false }: { w: FlightWatch; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  const f = w.flight;
  if (!f) return null;
  const p = progress(f, now), s = sky(f, now), h = headline(f, now);
  const landed = h.pill === 'Landed';
  const [c1, c2] = SKY[s];
  // Arc geometry (viewBox 300×110): a quadratic from (24,96) to (276,96).
  const q = p, x = 24 + 252 * q, y = (1 - q) * (1 - q) * 96 + 2 * (1 - q) * q * -18 + q * q * 96;
  const dx = 252, dy = 2 * (1 - q) * (-18 - 96) + 2 * q * (96 + 18);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const pillBg = h.tone === 'late' ? '#E9A23B' : h.tone === 'bad' ? '#D9534F' : 'rgba(255,255,255,.22)';

  return (
    <div className="rise-in" style={{ borderRadius: 22, overflow: 'hidden', color: '#fff', background: landed ? 'var(--ink)' : `linear-gradient(170deg, ${c1}, ${c2})`, position: 'relative', transition: 'background 1.2s' }}>
      {s === 'night' && !landed && (
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, opacity: 0.8, backgroundImage: 'radial-gradient(1px 1px at 20% 30%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 70% 20%,#fff 50%,transparent 51%),radial-gradient(1.5px 1.5px at 40% 60%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 85% 55%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 10% 70%,#fff 50%,transparent 51%)' }} />
      )}
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px 0', fontSize: 11.5, fontWeight: 600 }}>
        <span>{f.airline ? `${f.airline} · ` : ''}{f.number}</span>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: pillBg, color: h.tone === 'late' ? '#2A1B00' : '#fff', transition: 'background .4s' }}>{h.pill}</span>
      </div>
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', padding: '2px 14px 0', fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 34, lineHeight: 1 }}>
        <div>{f.dep.iata ?? '—'}<small style={{ display: 'block', fontSize: 11, fontWeight: 500, opacity: 0.85, fontFamily: 'var(--font-body)', marginTop: 3 }}>{f.dep.name?.split(' ')[0] ?? ''} {hhmm(f.dep.est_local ?? f.dep.sched_local)}</small></div>
        <div style={{ textAlign: 'right' }}>{f.arr.iata ?? '—'}<small style={{ display: 'block', fontSize: 11, fontWeight: 500, opacity: 0.85, fontFamily: 'var(--font-body)', marginTop: 3 }}>{f.arr.name?.split(' ')[0] ?? ''} {hhmm(f.arr.est_local ?? f.arr.sched_local)}</small></div>
      </div>
      <div className="glass-strong" style={{ position: 'relative', margin: '8px 14px 0', display: 'inline-block', fontSize: 12, fontWeight: 700, padding: '5px 10px', borderRadius: 999, color: 'var(--ink)' }}>{h.chip}</div>
      {!compact && (
        <div style={{ position: 'relative', height: 96, margin: '0 0 -6px' }}>
          <svg viewBox="0 0 300 110" style={{ width: '100%', height: '100%', overflow: 'visible' }} aria-hidden="true">
            <path d="M24 96 Q150 -18 276 96" fill="none" stroke="rgba(255,255,255,.45)" strokeWidth={2} strokeDasharray="2 6" strokeLinecap="round" />
            <path d="M24 96 Q150 -18 276 96" fill="none" stroke="#3CE0AE" strokeWidth={3} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} style={{ transition: 'stroke-dashoffset 1.2s' }} />
            <circle cx={24} cy={96} r={4} fill="#fff" /><circle cx={276} cy={96} r={4} fill="#fff" />
            <g transform={`translate(${x} ${y}) rotate(${angle})`} style={{ transition: 'transform 1.2s' }}>
              <path d={t('M12 0 L-6 -7 L-3 0 L-6 7 Z M-2 -2 L-8 -12 L-5 -12 L4 -2 Z M-2 2 L-8 12 L-5 12 L4 2 Z')} fill="#fff" transform="scale(.9)" />
            </g>
          </svg>
        </div>
      )}
      <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', padding: '10px 14px 12px', borderTop: '1px dashed rgba(255,255,255,.45)', fontSize: 11 }}>
        {landed ? (
          <>
            <div>{t('Belt')}<b style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 16 }}>{f.arr.belt ?? '—'}</b></div>
            <div>{t('Terminal')}<b style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 16 }}>{f.arr.terminal ?? '—'}</b></div>
            <div {...pressable(() => void askNum(`I've just landed at ${f.arr.name ?? f.arr.iata}. Get me a car.`))} className="tap" style={{ cursor: 'pointer', alignSelf: 'center', textAlign: 'center', background: 'var(--color-accent)', borderRadius: 10, padding: '0 6px', fontWeight: 700, fontSize: 11.5 }}>{t('Car from the airport')}</div>
          </>
        ) : (
          <>
            <div>{t('Gate')}<b style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 16 }}>{f.dep.gate ?? '—'}</b></div>
            <div>{t('Terminal')}<b style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 16 }}>{f.dep.terminal ?? '—'}</b></div>
            <div>{t('Lands')}<b style={{ display: 'block', fontFamily: 'var(--font-heading)', fontSize: 16 }}>{hhmm(f.arr.est_local ?? f.arr.sched_local)}</b></div>
          </>
        )}
      </div>
      {!compact && (
        <div {...pressable(() => void stopWatching(w.id))} style={{ position: 'absolute', top: 8, right: 8, opacity: 0, width: 1, height: 1, overflow: 'hidden' }} aria-label={`Stop watching ${f.number}`} />
      )}
    </div>
  );
}
