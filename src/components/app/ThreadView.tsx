// THREAD tab — the conversation: messages, cards, typing dots, chips, input bar.
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../lib/store';
import { tagOf } from '../../lib/derive';
import { askNum, sendChip, openVoice } from '../../lib/concierge';
import type { Msg } from '../../lib/types';

function MsgBubble({ m }: { m: Msg }) {
  const u = m.who === 'u';
  const ct = m.card ? tagOf(m.card.tag) : null;
  return (
    <div style={{ display: 'flex', justifyContent: u ? 'flex-end' : 'flex-start', padding: '0 16px' }}>
      <div
        style={{
          maxWidth: '82%', fontSize: 13, lineHeight: 1.5, padding: '10px 13px',
          background: u ? 'var(--color-text)' : '#fff',
          color: u ? '#fff' : 'var(--color-text)',
          border: u ? 'none' : '2px solid var(--color-neutral-300)',
        }}
      >
        <div style={{ whiteSpace: 'pre-line' }}>{m.text}</div>
        {m.card && ct && (
          <div style={{ marginTop: 10, background: '#fff', border: '2px solid var(--color-text)', padding: '10px 12px' }}>
            <span style={ct.st}>{ct.label}</span>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14, marginTop: 7 }}>{m.card.title}</div>
            <div style={{ fontSize: 11.5, color: 'var(--color-neutral-700)', marginTop: 3 }}>{m.card.meta}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ThreadView() {
  // Whole-state subscription on purpose: the design's componentDidUpdate snaps
  // the thread to the bottom after EVERY state change while the thread is
  // visible (sheets opening, notifications, chips), not just on new messages.
  const { msgs, typing, chips } = useApp((s) => s);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');

  const send = () => {
    const text = draft.trim();
    if (!text || typing) return;
    setDraft('');
    void askNum(text);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  return (
    <>
      <div ref={scrollRef} className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '16px 0 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {msgs.map((m, i) => (
          <MsgBubble key={i} m={m} />
        ))}
        {typing && (
          <div style={{ padding: '0 16px' }}>
            <div style={{ display: 'inline-flex', gap: 5, background: '#fff', border: '2px solid var(--color-neutral-300)', padding: '12px 14px' }}>
              {[0, 0.18, 0.36].map((d) => (
                <span key={d} style={{ width: 6, height: 6, background: 'var(--color-text)', animation: `tdot 1.1s ${d}s infinite` }} />
              ))}
            </div>
          </div>
        )}
      </div>
      <div style={{ borderTop: '2px solid var(--color-divider)', padding: '10px 16px 12px', background: 'var(--color-bg)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {chips.map((c) => (
            <div
              key={c.id}
              onClick={() => sendChip(c.id, c.label)}
              className="hov-accent-100"
              style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 600, padding: '7px 11px', border: '2px solid var(--color-text)', background: '#fff' }}
            >
              {c.label}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder="Message Num…"
            style={{ flex: 1, border: '2px solid var(--color-neutral-300)', padding: '10px 12px', fontSize: 13, color: 'var(--color-text)', background: '#fff', outline: 'none', fontFamily: 'var(--font-body)', minWidth: 0 }}
          />
          <div
            onClick={openVoice}
            className="hov-accent"
            style={{ cursor: 'pointer', width: 41, border: '2px solid var(--color-text)', background: 'var(--color-text)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Talk to Num"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <rect x="9" y="2" width="6" height="12" />
              <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" />
            </svg>
          </div>
        </div>
      </div>
    </>
  );
}
