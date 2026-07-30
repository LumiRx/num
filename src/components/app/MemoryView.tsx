// MEMORY tab — the shelf of past trips; rows expand to show the kept note.
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { memTag } from '../../lib/derive';
import { MEMORY_GROUPS } from '../../lib/data';
import { Scene } from '../../lib/scenes';
import { CameraIcon } from '../../lib/icons';
import type { MemoryItem } from '../../lib/types';

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
        <span style={memTag}>MEMORY</span>
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
  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 20 }}>
      <div className="glass" style={{ margin: '10px 12px 4px', borderRadius: 'var(--r-md)', padding: '12px 14px', fontSize: 12, color: 'var(--ink)', lineHeight: 1.55 }}>
        Everything you’ve done, kept quietly — not a cluster, a shelf. Ask the thread —{' '}
        <span style={{ color: 'var(--color-accent-700)', fontWeight: 600 }}>“when was that omakase?”</span> — and it comes back.
      </div>
      {MEMORY_GROUPS.map(([name, dates]) => (
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
