// A feature's own page: cover, promise, two or three fields, one button —
// then NUM takes it in the thread with the details already in the ask.
// See src/lib/features.ts for why the page does not book anything itself.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { XIcon } from '../../lib/icons';
import { featureById } from '../../lib/features';
import { askNum } from '../../lib/concierge';
import { forgetSaved, researchAsk } from '../../lib/savedflights';
import { duration, stopsLabel } from '../../lib/flights';
import { t } from '../../lib/i18n';

const field: React.CSSProperties = {
  width: '100%', height: 46, borderRadius: 14, border: '1px solid var(--ink-12)', padding: '0 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const label: React.CSSProperties = { fontSize: 10.5, letterSpacing: '.08em', fontWeight: 700, color: 'var(--ink-60)', marginBottom: 5 };
const primary: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 800,
  fontSize: 12.5, letterSpacing: '.06em', padding: '14px 16px', textAlign: 'center',
};
const secondaryBtn: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--field-bg)', border: '1px solid var(--ink-12)', color: 'var(--ink)',
  fontWeight: 700, fontSize: 12, letterSpacing: '.04em', padding: '12px 16px', textAlign: 'center',
};

export default function FeaturePage() {
  const id = useApp((s) => s.featureOpen);
  const place = useApp((s) => s.place);
  const saved = useApp((s) => s.savedFlights);
  const f = featureById(id);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(!!f, ref);
  const [values, setValues] = useState<Record<string, string>>({});
  const [lane, setLane] = useState<string | null>(null);

  // A fresh page each time it opens; the place NUM already knows is filled in.
  useEffect(() => {
    if (!f) return;
    const v: Record<string, string> = {};
    for (const fl of f.fields ?? []) v[fl.id] = fl.fromPlace && place ? place : '';
    setValues(v);
    setLane(f.lanes?.[0]?.id ?? null);
  }, [f?.id]);

  if (!f) return null;
  const close = () => store.set({ featureOpen: null });
  const required = (f.fields ?? []).filter((fl) => !fl.optional);
  const ready = required.every((fl) => (values[fl.id] ?? '').trim().length > 0);

  const go = () => {
    if (!f.compose) return;
    if (!ready) {
      // A tap on a not-yet-ready button does something visible: the first
      // field still needed gets the cursor. Silence is what reads as broken.
      const missing = (f.fields ?? []).find((fl) => !fl.optional && !(values[fl.id] ?? '').trim());
      if (missing) document.getElementById(`feat-${f.id}-${missing.id}`)?.focus();
      return;
    }
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) clean[k] = v.trim();
    const ask = f.compose(clean, lane);
    store.set({ featureOpen: null, threadOpen: true, unread: 0 });
    void askNum(ask);
  };
  const research = (sid: string) => {
    const s = saved.find((x) => x.id === sid);
    if (!s) return;
    store.set({ featureOpen: null, threadOpen: true, unread: 0 });
    void askNum(researchAsk(s));
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={t(f.title)} className="glass-strong sheet-in" style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(94%, calc(100% - var(--safe-top, 0px)))', overflowY: 'auto' }}>
      <div style={grabberStyle} />
      <div {...pressable(close)} aria-label={t('Close')} className="glass press tap" style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, borderRadius: 999, cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>

      {/* The cover carries over from the tile, so the page reads as the same thing opened up. */}
      <div style={{ position: 'relative', height: 168, overflow: 'hidden' }}>
        <img src={f.cover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,.05) 0%, rgba(0,0,0,.35) 55%, rgba(0,0,0,.8) 100%)' }} />
        <div style={{ position: 'absolute', left: 16, right: 16, bottom: 14, color: '#fff' }}>
          <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, opacity: 0.85 }}>{t(f.kicker)}</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, lineHeight: 1.1, marginTop: 4, letterSpacing: '-.01em' }}>{t(f.title)}</div>
        </div>
      </div>

      <div style={{ padding: 16, display: 'grid', gap: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--ink-60)', lineHeight: 1.55 }}>{t(f.promise)}</div>

        {/* LANES. Up to three share the row as a segmented control. Four or
            more — ERRANDS has five — become a scrolling chip row, because a
            fifth of a phone is 60px and "Groceries" does not fit in 60px
            (18 Sep 2026 audit: it read "Grocerie / s"). Words never wrap;
            the row slides. 44px tall either way. */}
        {f.lanes && (() => {
          const many = f.lanes.length > 3;
          return (
            <div role="tablist" className={many ? 'no-scrollbar' : 'glass'} style={many
              ? { display: 'flex', gap: 6, overflowX: 'auto', margin: '0 -16px', padding: '0 16px 2px', scrollSnapType: 'x proximity' }
              : { display: 'flex', borderRadius: 999, padding: 4 }}
            >
              {f.lanes.map((l) => (
                <div
                  key={l.id}
                  {...pressable(() => setLane(l.id), 'tab')}
                  aria-selected={lane === l.id}
                  className={many ? 'glass' : undefined}
                  style={{
                    flex: many ? 'none' : 1, textAlign: 'center', cursor: 'pointer', borderRadius: 999,
                    minHeight: many ? 44 : 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: many ? '0 16px' : '0 4px', whiteSpace: 'nowrap', scrollSnapAlign: 'start',
                    fontSize: 12, fontWeight: 800, letterSpacing: '.04em',
                    background: lane === l.id ? 'var(--grad-accent)' : many ? undefined : 'transparent', color: lane === l.id ? '#fff' : 'var(--ink)',
                    border: many && lane !== l.id ? '1px solid var(--ink-08)' : '1px solid transparent',
                  }}
                >
                  {t(l.label)}
                </div>
              ))}
            </div>
          );
        })()}

        {f.fields && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {f.fields.map((fl) => (
              <div key={fl.id} style={{ gridColumn: fl.half ? 'span 1' : '1 / -1' }}>
                <div style={label}>{t(fl.label)}</div>
                <input
                  id={`feat-${f.id}-${fl.id}`}
                  type={fl.type ?? 'text'}
                  inputMode={fl.type === 'number' ? 'numeric' : undefined}
                  value={values[fl.id] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [fl.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
                  placeholder={t(fl.placeholder)}
                  style={field}
                  aria-label={t(fl.label)}
                />
              </div>
            ))}
          </div>
        )}

        {f.compose && (
          <div {...pressable(go)} className="press" role="button" aria-disabled={!ready} style={{ ...primary, opacity: ready ? 1 : 0.8 }}>
            {t(f.cta)} · {t('NUM takes it')}
          </div>
        )}
        {f.honest && <div style={{ fontSize: 11.5, color: 'var(--ink-40)', lineHeight: 1.5, marginTop: -6 }}>{t(f.honest)}</div>}
        {f.secondary && (
          <div {...pressable(f.secondary.open)} className="press" style={secondaryBtn}>{t(f.secondary.label)}</div>
        )}

        {f.id === 'flights' && (
          <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
            <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>{t('SAVED FLIGHTS')}</div>
            {saved.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--ink-60)', lineHeight: 1.5 }}>
                {t('Nothing saved yet. On any live fare, tap Save and it lands here — one tap to check the price again.')}
              </div>
            )}
            {saved.map((s) => (
              <div key={s.id} style={{ borderRadius: 14, border: '1px solid var(--ink-08)', padding: '11px 12px', display: 'grid', gap: 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                  <div style={{ fontWeight: 800, fontSize: 14.5 }}>{s.route} <span style={{ color: 'var(--ink-60)', fontWeight: 600, fontSize: 12 }}>· {s.day}</span></div>
                  <div style={{ fontWeight: 800, fontSize: 14.5, color: 'var(--money)' }}>{s.currency} {s.price}</div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-60)' }}>
                  {s.window ?? ''}{s.carrier ? ` · ${s.carrier}` : ''} · {stopsLabel(s.stops)} · {duration(s.durationMin)}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--ink-40)' }}>{t('Price seen')} {s.seenAt.slice(0, 10)} — {t('fares move; NUM re-checks it.')}</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <div {...pressable(() => research(s.id))} className="press tap" style={{ ...secondaryBtn, flex: 1, padding: '10px 12px', fontSize: 11 }}>{t('Check price again')}</div>
                  <div {...pressable(() => forgetSaved(s.id))} className="press tap" aria-label={t('Remove')} style={{ ...secondaryBtn, padding: '10px 14px', fontSize: 11, color: 'var(--ink-60)' }}>{t('Remove')}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
