// MEMORY tab — the shelf of past trips; rows expand to show the kept note.
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { memTag } from '../../lib/derive';
import { MEMORY_GROUPS } from '../../lib/data';
import { Scene } from '../../lib/scenes';
import { CameraIcon } from '../../lib/icons';
import type { MemoryItem } from '../../lib/types';
import { t } from '../../lib/i18n';

function MemoryRow({ m }: { m: MemoryItem }) {
  const exp = useApp((s) => s.expanded === m.id);
  const photosOn = useApp((s) => s.photosOn);
  return (
    <div
      {...pressable(() => store.set((s) => ({ expanded: s.expanded === m.id ? null : m.id })))}
      aria-expanded={exp}
      className="glass lift msg-in"
      style={{ cursor: 'pointer', margin: '6px 12px', borderRadius: 'var(--r-lg)', padding: 12 }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Scene title={m.title} kind="memory" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.3, color: 'var(--ink)' }}>{m.title}</div>
          <div style={{ fontSize: 10.5, color: 'var(--ink-60)', marginTop: 3 }}>
            {m.date + ' · ' + m.time + ' · ' + m.place}
            {photosOn && m.photos ? (
              <>
                {' · '}
                <CameraIcon size={11} style={{ verticalAlign: '-1px' }} />
                {m.photos + ' photos'}
              </>
            ) : null}
          </div>
        </div>
        <span style={memTag}>{t('MEMORY')}</span>
      </div>
      {exp && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--ink-08)', fontSize: 12, lineHeight: 1.5, color: 'var(--ink)' }}>
          {m.note}
        </div>
      )}
    </div>
  );
}

export default function MemoryView() {
  const memories = useApp((s) => s.memories);
  const demo = useApp((s) => s.demo);
  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 20 }}>
      <div className="glass" style={{ margin: '10px 12px 4px', borderRadius: 'var(--r-md)', padding: '12px 14px', fontSize: 12, color: 'var(--ink)', lineHeight: 1.55 }}>
        Everything you’ve done, kept quietly — not a cluster, a shelf. Ask the thread —{' '}
        <span style={{ color: 'var(--color-accent-700)', fontWeight: 600 }}>{t('“when was that omakase?”')}</span>{' '}{t('— and it comes back.')}</div>
      {!demo && memories.length === 0 && (
        <div className="glass" style={{ margin: '10px 12px', borderRadius: 'var(--r-md)', padding: '14px 16px', fontSize: 12, color: 'var(--ink-60)', lineHeight: 1.55 }}>
          <svg width="120" height="84" viewBox="0 0 120 84" fill="none" aria-hidden="true" style={{ display: 'block', margin: '0 auto 10px' }}><path d="M14 66c18-10 30-2 46-14s26-12 46-2" stroke="var(--ink-12)" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 8"/><path d="M60 14c-9 0-16 7-16 16 0 12 16 30 16 30s16-18 16-30c0-9-7-16-16-16Z" fill="var(--color-accent)"/><circle cx="60" cy="30" r="6" fill="#fff"/><circle cx="104" cy="62" r="7" fill="var(--color-accent)" opacity=".35"/><circle cx="16" cy="62" r="5" fill="var(--color-accent)" opacity=".25"/></svg>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15, color: 'var(--ink)', textAlign: 'center' }}>{t('Your shelf is empty')}</div>
          <div style={{ textAlign: 'center', marginTop: 4 }}>{t('Every dinner, boat and night out files here by itself. Ask NUM later: “when was that omakase?”')}</div>
        </div>
      )}
      {/* The demo's shelf headings are the demo's. A real account with nothing
          on it shows the empty line above and nothing else — TOKYO and LISBON
          were appearing under "Your shelf is empty" (audit B1, 17 Sep). */}
      {(demo ? MEMORY_GROUPS : [...new Set(memories.map((m) => m.trip))].map((t) => [t, ''] as const)).map(([name, dates]) => (
        <div key={name}>
          <div style={{ padding: '18px 18px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 14, letterSpacing: '.05em' }}>
              {name}
              <span style={{ display: 'block', width: 28, height: 3, borderRadius: 999, background: 'var(--grad-accent)', marginTop: 3 }} />
            </span>
            <span style={{ fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-60)' }}>{dates}</span>
          </div>
          {memories.filter((m) => m.trip === name).map((m) => (
            <MemoryRow key={m.id} m={m} />
          ))}
        </div>
      ))}
    </div>
  );
}
