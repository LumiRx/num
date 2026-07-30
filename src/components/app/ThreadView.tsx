// THREAD tab — the conversation: messages, cards, typing dots, chips, input bar.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { tagOf } from '../../lib/derive';
import { askNum, cleanText, sendChip, openVoice } from '../../lib/concierge';
import { MicIcon, SendIcon, SparklesIcon } from '../../lib/icons';
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
        <div style={{ whiteSpace: 'pre-line' }}>{u ? m.text : cleanText(m.text)}</div>
        {m.card && ct && (
          <div
            style={{
              marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 11, padding: 10,
              background: 'rgba(255,255,255,.85)', border: '1px solid var(--ink-08)',
              borderRadius: 'var(--r-md)', boxShadow: '0 4px 12px rgba(32,30,29,.08)', color: 'var(--ink)',
            }}
          >
            {/* A real venue photo earns more room than the icon fallback does. */}
            <Scene title={m.card.title} size={m.card.photo ? 58 : 42} photo={m.card.photo} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, lineHeight: 1.25 }}>{m.card.title}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>{m.card.meta}</div>
              {/* The status pill sits under the text so it never squeezes the title. */}
              <span style={{ ...ct.st, display: 'inline-flex', marginTop: 7 }}>{ct.label}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Live-mode capability discovery — a strip of fun starters above the chips.
const DISCOVER: Array<[emoji: string, label: string, prompt: string]> = [
  ['🚗', 'Request a car', 'Get me a car to the airport tomorrow morning'],
  ['🍜', 'Order food', 'Order dinner to my hotel tonight'],
  ['💆', 'Book a massage', 'Book me a massage nearby tomorrow afternoon'],
  ['🍽️', 'Table tonight', 'Book me a great dinner table tonight'],
  ['🎉', 'Club table', 'Get me a table at the best club this weekend'],
  ['₿', 'Check crypto', 'What are bitcoin and ethereum at right now?'],
  ['🤝', 'Meet Num users', 'Set up a meeting with another Num user'],
  ['🛠️', 'Hire help · 5arz', 'I need to hire someone for a small job through 5arz'],
];

export default function ThreadView() {
  // Whole-state subscription on purpose: the design's componentDidUpdate snaps
  // the thread to the bottom after EVERY state change while the thread is
  // visible (sheets opening, notifications, chips), not just on new messages.
  const { msgs, typing, chips, demo } = useApp((s) => s);
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
        {!demo && (
          <div className="no-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '2px 2px 8px' }}>
            {DISCOVER.map(([emoji, label, prompt]) => (
              <div
                key={label}
                {...pressable(() => { if (!store.get().typing) void askNum(prompt); })}
                className="glass lift"
                style={{ cursor: 'pointer', borderRadius: 999, padding: '7px 12px', fontSize: 11.5, fontWeight: 600, flex: 'none', display: 'flex', gap: 6, alignItems: 'center', ...(typing ? { pointerEvents: 'none' as const, opacity: 0.55 } : {}) }}
              >
                <span aria-hidden="true">{emoji}</span>
                {label}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {chips.map((c) => (
            <div
              key={c.id}
              {...pressable(() => sendChip(c.id, c.label))}
              className="glass lift"
              style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 600, padding: '8px 13px', borderRadius: 999, display: 'flex', alignItems: 'center', gap: 6, ...(typing ? { pointerEvents: 'none' as const, opacity: 0.55 } : {}) }}
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
          {draft.trim() ? (
            <div
              {...pressable(send)}
              aria-label="Send"
              className="press"
              style={{ cursor: 'pointer', width: 44, height: 44, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(236,48,19,.35)', flex: 'none' }}
              title="Send"
            >
              <SendIcon size={17} />
            </div>
          ) : (
            <div
              {...pressable(openVoice)}
              aria-label="Talk to Num"
              className="press"
              style={{ cursor: 'pointer', width: 44, height: 44, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(236,48,19,.35)', flex: 'none' }}
              title="Talk to Num"
            >
              <MicIcon size={17} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
