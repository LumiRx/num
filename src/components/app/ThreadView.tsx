// THREAD tab — the conversation: messages, cards, typing dots, chips, input bar.
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { tagOf } from '../../lib/derive';
import { askNum, sendChip, openVoice } from '../../lib/concierge';
import { MicIcon, SparklesIcon } from '../../lib/icons';
import { Scene } from '../../lib/scenes';
import type { Msg } from '../../lib/types';

function MsgBubble({ m }: { m: Msg }) {
  const u = m.who === 'u';
  const ct = m.card ? tagOf(m.card.tag) : null;
  return (
    <div className="msg-in" style={{ display: 'flex', justifyContent: u ? 'flex-end' : 'flex-start', padding: '0 16px' }}>
      <div
        className={u ? undefined : 'glass'}
        style={{
          maxWidth: '82%', fontSize: 13, lineHeight: 1.5, padding: '10px 13px',
          borderRadius: 18,
          ...(u
            ? { borderBottomRightRadius: 6, background: 'var(--grad-accent)', color: '#fff', boxShadow: '0 4px 14px rgba(236,48,19,.25)' }
            : { borderBottomLeftRadius: 6, color: 'var(--ink)' }),
        }}
      >
        <div style={{ whiteSpace: 'pre-line' }}>{m.text}</div>
        {m.card && ct && (
          <div
            style={{
              marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 10, padding: 10,
              background: 'rgba(255,255,255,.85)', border: '1px solid var(--ink-08)',
              borderRadius: 'var(--r-md)', boxShadow: '0 4px 12px rgba(32,30,29,.08)', color: 'var(--ink)',
            }}
          >
            <Scene title={m.card.title} size={42} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5 }}>{m.card.title}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>{m.card.meta}</div>
            </div>
            <span style={ct.st}>{ct.label}</span>
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
          <div className="msg-in" style={{ padding: '0 16px' }}>
            <div className="glass" style={{ display: 'inline-flex', gap: 5, borderRadius: 999, padding: '10px 14px' }}>
              {[0, 0.18, 0.36].map((d) => (
                <span key={d} style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--color-text)', animation: `tdot 1.1s ${d}s infinite` }} />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="glass-bar" style={{ padding: '10px 14px 14px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {chips.map((c) => (
            <div
              key={c.id}
              {...pressable(() => sendChip(c.id, c.label))}
              className="glass lift"
              style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 600, padding: '8px 13px', borderRadius: 999, display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <SparklesIcon size={12} style={{ color: 'var(--color-accent)' }} />
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
            style={{ flex: 1, borderRadius: 999, border: '1px solid var(--glass-border)', padding: '11px 16px', fontSize: 13, color: 'var(--color-text)', background: 'rgba(255,255,255,.7)', outline: 'none', fontFamily: 'var(--font-body)', minWidth: 0 }}
          />
          <div
            {...pressable(openVoice)}
            aria-label="Talk to Num"
            className="press"
            style={{ cursor: 'pointer', width: 44, height: 44, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(236,48,19,.35)', flex: 'none' }}
            title="Talk to Num"
          >
            <MicIcon size={17} />
          </div>
        </div>
      </div>
    </>
  );
}
