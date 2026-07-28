// MEMORY tab — the shelf of past trips; rows expand to show the kept note.
import { store, useApp } from '../../lib/store';
import { memTag } from '../../lib/derive';
import { MEMORY_GROUPS } from '../../lib/data';
import type { MemoryItem } from '../../lib/types';

function MemoryRow({ m }: { m: MemoryItem }) {
  const exp = useApp((s) => s.expanded === m.id);
  const photosOn = useApp((s) => s.photosOn);
  const metaLine = m.date + ' · ' + m.time + ' · ' + m.place + (photosOn && m.photos ? ' · ' + m.photos + ' photos' : '');
  return (
    <div
      onClick={() => store.set((s) => ({ expanded: s.expanded === m.id ? null : m.id }))}
      className="hov-neutral-100"
      style={{ cursor: 'pointer', borderBottom: '1px solid var(--color-neutral-300)', padding: '10px 16px' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13 }}>{m.title}</div>
        <span style={memTag}>MEMORY</span>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--color-neutral-600)', marginTop: 3 }}>{metaLine}</div>
      {exp && (
        <div style={{ marginTop: 8, borderLeft: '2px solid var(--color-neutral-400)', paddingLeft: 10, fontSize: 12, lineHeight: 1.5, color: 'var(--color-neutral-800)' }}>
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
      <div style={{ padding: '14px 16px', borderBottom: '2px solid var(--color-divider)', fontSize: 12, color: 'var(--color-neutral-700)', lineHeight: 1.55 }}>
        Everything you’ve done, kept quietly — not a cluster, a shelf. Ask the thread —{' '}
        <span style={{ color: 'var(--color-accent-700)', fontWeight: 600 }}>“when was that omakase?”</span> — and it comes back.
      </div>
      {MEMORY_GROUPS.map(([name, dates]) => (
        <div key={name}>
          <div style={{ padding: '16px 16px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '2px solid var(--color-text)' }}>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 15, letterSpacing: '.06em' }}>{name}</span>
            <span style={{ fontSize: 10.5, letterSpacing: '.1em', color: 'var(--color-neutral-600)' }}>{dates}</span>
          </div>
          {memories.filter((m) => m.trip === name).map((m) => (
            <MemoryRow key={m.id} m={m} />
          ))}
        </div>
      ))}
    </div>
  );
}
