// Messages with other members — the people list, and one conversation.
//
// Deliberately not a chat app. There is no search, no directory and no way in
// except through someone you are already connected to, because the graph IS
// the spam filter. The list only ever shows friends.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { closeDmThread, loadDmThread, openDm, retryDm, sendDm } from '../../lib/dm';
import { replyToInvite } from '../../lib/events';
import { refreshRequests } from '../../lib/requests';
import { ChevronLeftIcon, ChevronRightIcon, SendIcon, SparklesIcon, UserIcon, XIcon } from '../../lib/icons';
import type { DmMessage } from '../../lib/dm';

/** 'now', '4m', '2h', 'Tue' — a timestamp you read without thinking about it. */
function ago(iso: string): string {
  const then = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  if (mins < 60 * 24 * 7) return new Date(then).toLocaleDateString('en-GB', { weekday: 'short' });
  return new Date(then).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function Avatar({ name, size = 34 }: { name: string | null; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: 999, flex: 'none', background: 'var(--field-bg)',
        border: '1px solid var(--ink-08)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: size * 0.4, color: 'var(--ink-60)',
      }}
    >
      {name ? name[0].toUpperCase() : <UserIcon size={size * 0.45} />}
    </span>
  );
}

// ── the people list ────────────────────────────────────────────────────────

function PeopleList() {
  const friends = useApp((s) => s.friends);
  const inbox = useApp((s) => s.dmInbox);

  // Only connected members can be messaged, so the friend list IS the list.
  // Anyone with something unread floats to the top with their own badge; the
  // rest keep the order they were connected in.
  const active = friends.filter((f) => f.state === 'active' && f.id);
  const waiting = new Map(inbox.map((p) => [p.from_id, p]));
  const rows = [...active].sort((a, b) => (waiting.has(b.id!) ? 1 : 0) - (waiting.has(a.id!) ? 1 : 0));

  if (!rows.length) {
    return (
      <div style={{ padding: '32px 22px', textAlign: 'center', color: 'var(--ink-60)', fontSize: 12.5, lineHeight: 1.6 }}>
        Nobody to message yet.
        <div style={{ marginTop: 8, color: 'var(--ink-40)', fontSize: 11.5 }}>
          Messages only go between people who are connected — scan a friend’s code or send them an invite, and they’ll show up here.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '4px 0 12px' }}>
      {rows.map((f) => {
        const w = waiting.get(f.id!);
        return (
          <div
            key={f.id}
            {...pressable(() => openDm(f.id!, f.name))}
            className="press"
            style={{ cursor: 'pointer', display: 'flex', gap: 11, alignItems: 'center', padding: '11px 18px' }}
          >
            <Avatar name={f.name} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontSize: 13.5, fontWeight: w ? 800 : 600 }}>{f.name || 'A friend'}</span>
                {w && <span style={{ fontSize: 10.5, color: 'var(--ink-40)', flex: 'none' }}>{ago(w.last_at)}</span>}
              </div>
              <div
                style={{
                  fontSize: 11.5, marginTop: 2, color: w ? 'var(--ink)' : 'var(--ink-40)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {w ? w.last_body : 'Say something'}
              </div>
            </div>
            {w ? (
              <span
                style={{
                  minWidth: 20, height: 20, padding: '0 6px', borderRadius: 999, flex: 'none',
                  background: 'var(--grad-accent)', color: '#fff', fontSize: 10.5, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {w.unread}
              </span>
            ) : (
              <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── an invite, answerable where it arrived ─────────────────────────────────

/**
 * The event card.
 *
 * This is the "tappable event in chat" — the host's Num put the question here,
 * and yes/no/maybe goes back to their Num without either person leaving the
 * conversation. `ref` (the invite token) is only ever returned to the person
 * the invite was addressed to, so the buttons simply do not exist for the host
 * looking at their own copy.
 */
function EventCard({ m }: { m: DmMessage }) {
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);

  const reply = async (rsvp: 'yes' | 'no' | 'maybe') => {
    if (!m.ref || busy) return;
    setBusy(true);
    setAnswer(rsvp);
    try {
      setLine(await replyToInvite(m.ref, rsvp));
      // The answer is posted back into this same thread server-side, so pull
      // it in rather than waiting up to five seconds for the poll — the reply
      // should appear under the card you just tapped.
      void loadDmThread(m.from_id);
      void refreshRequests();
    } catch {
      setAnswer(null);
      setLine('That didn’t go through — try again.');
    }
    setBusy(false);
  };

  const CHOICES: Array<['yes' | 'no' | 'maybe', string]> = [['yes', 'I’m in'], ['maybe', 'Maybe'], ['no', 'Can’t']];

  return (
    <div className="glass" style={{ borderRadius: 'var(--r-md)', padding: '12px 13px', maxWidth: '86%' }}>
      <div style={{ fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)', display: 'flex', gap: 6, alignItems: 'center' }}>
        <SparklesIcon size={12} /> INVITE
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, marginTop: 7, whiteSpace: 'pre-line' }}>{m.body}</div>
      {m.ref && !answer && (
        <div style={{ display: 'flex', gap: 7, marginTop: 11 }}>
          {CHOICES.map(([id, label]) => (
            <div
              key={id}
              {...pressable(() => void reply(id))}
              className="press"
              style={{
                cursor: 'pointer', flex: 1, textAlign: 'center', borderRadius: 999, padding: '9px 6px',
                fontSize: 11.5, fontWeight: 800,
                ...(id === 'yes'
                  ? { background: 'var(--grad-accent)', color: '#fff', boxShadow: '0 3px 10px rgba(236,48,19,.28)' }
                  : { background: 'var(--field-bg)', border: '1px solid var(--ink-12)', color: 'var(--ink)' }),
                ...(busy ? { pointerEvents: 'none' as const, opacity: 0.5 } : {}),
              }}
            >
              {label}
            </div>
          ))}
        </div>
      )}
      {(line || answer) && (
        <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 9, lineHeight: 1.45 }}>
          {line ?? (answer === 'yes' ? 'You’re in.' : answer === 'no' ? 'Told them you can’t.' : 'Marked as a maybe.')}
        </div>
      )}
    </div>
  );
}

// ── one conversation ───────────────────────────────────────────────────────

function Conversation() {
  const me = useApp((s) => s.me);
  const withWho = useApp((s) => s.dmWith);
  const msgs = useApp((s) => s.dmThread);
  const error = useApp((s) => s.dmError);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');

  // Same rule as the Num thread: snap to the newest on every change, because
  // a message that arrives above the fold has not arrived.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const send = () => {
    const text = draft.trim();
    if (!text || !withWho) return;
    setDraft('');
    void sendDm(withWho.id, text);
  };

  return (
    <>
      <div ref={scrollRef} className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '12px 0 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!msgs.length && (
          <div style={{ padding: '28px 22px', textAlign: 'center', color: 'var(--ink-40)', fontSize: 12, lineHeight: 1.6 }}>
            Nothing here yet. Whatever you send lands on {withWho?.name ? `${withWho.name}’s` : 'their'} lock screen — they can answer without opening anything.
          </div>
        )}
        {msgs.map((m) => {
          const mine = m.from_id === me?.id;
          if (m.kind === 'event') {
            return (
              <div key={m.id} className="msg-in" style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', padding: '0 16px' }}>
                <EventCard m={m} />
              </div>
            );
          }
          return (
            <div key={m.id} className="msg-in" style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', padding: '0 16px' }}>
              <div
                className={mine ? undefined : 'glass'}
                style={{
                  maxWidth: '82%', fontSize: 13, lineHeight: 1.5, padding: '10px 13px', borderRadius: 18,
                  opacity: m.pending ? 0.6 : 1,
                  ...(mine
                    ? { borderBottomRightRadius: 6, background: 'var(--grad-accent)', color: '#fff', boxShadow: '0 4px 14px rgba(236,48,19,.25)' }
                    : { borderBottomLeftRadius: 6, color: 'var(--ink)' }),
                }}
              >
                <div style={{ whiteSpace: 'pre-line' }}>{m.body}</div>
                {/* A failed message stays on screen and stays re-sendable. It
                    keeps its id, so tapping again cannot deliver it twice. */}
                {m.failed && (
                  <div
                    {...pressable(() => void retryDm(m.id))}
                    style={{ cursor: 'pointer', fontSize: 10.5, fontWeight: 800, marginTop: 5, opacity: 0.9, textDecoration: 'underline' }}
                  >
                    Didn’t send · tap to try again
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <div style={{ padding: '0 18px 6px', fontSize: 11, color: 'var(--color-accent-700)' }}>{error}</div>
      )}
      <div className="glass-bar" style={{ padding: '10px 14px max(env(safe-area-inset-bottom), 14px)', flex: 'none' }}>
        <div style={{ display: 'flex', gap: 8, height: 44, alignItems: 'center' }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder={`Message ${withWho?.name || 'them'}…`}
            /* 16px — anything smaller and iOS zooms the page in on focus. */
            style={{ flex: 1, height: 44, borderRadius: 999, border: '1px solid var(--glass-border)', padding: '0 16px', fontSize: 16, color: 'var(--color-text)', background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', minWidth: 0 }}
          />
          <div
            {...pressable(send)}
            aria-label="Send"
            className="press"
            style={{
              cursor: 'pointer', width: 44, height: 44, borderRadius: 999, flex: 'none',
              background: 'var(--grad-accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 14px rgba(236,48,19,.35)', opacity: draft.trim() ? 1 : 0.45,
            }}
            title="Send"
          >
            <SendIcon size={17} />
          </div>
        </div>
      </div>
    </>
  );
}

// ── the surface ────────────────────────────────────────────────────────────

export default function DmSheet() {
  const open = useApp((s) => s.dmOpen);
  const withWho = useApp((s) => s.dmWith);

  return (
    <div
      role="dialog"
      aria-label={withWho ? `Messages with ${withWho.name ?? 'a friend'}` : 'Messages'}
      aria-hidden={!open}
      style={{
        position: 'absolute', inset: 0, zIndex: 47, display: 'flex', flexDirection: 'column',
        background: 'var(--color-bg, #faf7f4)',
        visibility: open ? 'visible' : 'hidden',
        transform: open ? 'translateY(0)' : 'translateY(100%)',
        transition: 'transform .34s cubic-bezier(.32,.72,.29,.99), visibility .34s',
      }}
    >
      <div className="aurora-layer" aria-hidden="true" />
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 10, padding: 'max(env(safe-area-inset-top), 12px) 16px 6px' }}>
        {withWho && (
          <div
            {...pressable(closeDmThread)}
            aria-label="Back to messages"
            className="glass press"
            style={{ cursor: 'pointer', width: 30, height: 30, borderRadius: 999, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <ChevronLeftIcon size={15} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, fontSize: 11, letterSpacing: '.16em', fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {withWho ? (withWho.name || 'A FRIEND').toUpperCase() : 'MESSAGES'}
          {!withWho && <span style={{ fontWeight: 400, opacity: 0.5 }}> · YOUR PEOPLE</span>}
        </div>
        <div
          {...pressable(() => store.set({ dmOpen: false, dmWith: null, dmThread: [] }))}
          aria-label="Close messages"
          className="glass press"
          style={{ cursor: 'pointer', width: 30, height: 30, borderRadius: 999, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <XIcon size={15} />
        </div>
      </div>
      {/* Mounted only while open: the conversation auto-scrolls on every state
          change, and doing that behind a closed overlay is wasted work. */}
      {open && (
        <div className="no-scrollbar" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1, overflowY: withWho ? 'hidden' : 'auto' }}>
          {withWho ? <Conversation /> : <PeopleList />}
        </div>
      )}
    </div>
  );
}
