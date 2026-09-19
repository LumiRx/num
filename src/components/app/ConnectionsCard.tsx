// CONNECT YOUR WORLD — a settings screen, not a daily one.
//
// It sat on TODAY under the feature grid, which put a six-switch permission
// panel in the same scroll as tonight's plans. Nobody connects their contacts
// twice, so after the first day it was a wall to scroll past on the one
// screen that should be about this evening. It lives in Settings now, where
// somebody goes precisely when they want to change what NUM can reach.
//
// Moved whole, on purpose: the switches, the explanations and the iOS
// Send & Share fallback are unchanged, because the reason each row says what
// it buys has not changed either.
import { useState } from 'react';
import { useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { toggleConnection, contactsSupported, sendAndShare } from '../../lib/connect';
import { BellIcon, CalendarIcon, CameraIcon, ChevronRightIcon, MessageIcon, UsersIcon, WalletIcon } from '../../lib/icons';
import type { Connections } from '../../lib/types';
import { T, t } from '../../lib/i18n';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };

function Collapsible({ title, summary, defaultOpen = false, children }: {
  title: string; summary?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass" style={card}>
      <div {...pressable(() => setOpen((v) => !v))} aria-expanded={open} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={kicker}>{title}</div>
          {summary && <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 3, lineHeight: 1.45 }}>{summary}</div>}
        </div>
        <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)', flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }} />
      </div>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

const CONNECTIONS: Array<{ key: keyof Connections; label: string; why: string; icon: JSX.Element }> = [
  { key: 'contacts', label: T('Contacts'), why: T('so “invite Sam” finds the right Sam'), icon: <UsersIcon size={14} /> },
  { key: 'photos', label: T('Photos'), why: T('files your trip shots to the right night'), icon: <CameraIcon size={14} /> },
  { key: 'calendar', label: T('Calendar'), why: T('NUM books around what’s already there'), icon: <CalendarIcon size={14} /> },
  { key: 'crypto', label: T('Crypto wallet'), why: T('balances on this screen, settle bills in USDC'), icon: <WalletIcon size={14} /> },
  { key: 'email', label: T('Email'), why: T('pulls confirmations in so you never forward one'), icon: <MessageIcon size={14} /> },
  { key: 'texts', label: T('Texts'), why: T('the venue’s “running late?” reaches NUM too'), icon: <BellIcon size={14} /> },
];

/**
 * Connections. Each one is off, named, and says what it buys — a permission
 * screen that explains itself is the difference between a grant and a decline.
 * Flipping a switch performs the REAL connection right then (src/lib/connect):
 * pickers open as sheets over the app, addresses are minted, numbers fetched —
 * the user never leaves. iOS has no contacts API at all, so there the contacts
 * row becomes Send & Share, which is the honest version of the same promise.
 */
export default function ConnectionsCard() {
  const conn = useApp((s) => s.connections);
  const detail = useApp((s) => s.connDetail);
  const on = Object.values(conn).filter(Boolean).length;
  return (
    <Collapsible
      title={t('CONNECT YOUR WORLD')}
      summary={on ? `${on} of ${CONNECTIONS.length} connected` : t('All off — NUM asks only when it needs one')}
    >
      <div>
        {CONNECTIONS.map((c) => {
          // No picker on this platform → the row keeps its promise another way.
          if (c.key === 'contacts' && !contactsSupported()) {
            return (
              <div
                key="share"
                {...pressable(() => { void sendAndShare(); })}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--ink-08)' }}
              >
                <span style={{ width: 26, height: 26, borderRadius: 999, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--grad-accent)', color: '#fff' }}>
                  {c.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>Send &amp; Share</div>
                  <div style={{ fontSize: 10.5, color: 'var(--ink-60)' }}>{t('invite anyone from the share sheet — you stay right here')}</div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--ink-60)' }}>{t('OPEN')}</span>
              </div>
            );
          }
          const on = conn[c.key];
          return (
            <div
              key={c.key}
              {...pressable(() => toggleConnection(c.key), 'switch')}
              aria-checked={on}
              style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--ink-08)' }}
            >
              <span style={{ width: 26, height: 26, borderRadius: 999, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? 'var(--grad-accent)' : 'var(--field-bg)', color: on ? '#fff' : 'var(--ink-60)', border: on ? 'none' : '1px solid var(--ink-08)' }}>
                {c.icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t(c.label)}</div>
                <div style={{ fontSize: 10.5, color: on && detail[c.key] ? 'var(--ink-80, var(--ink-60))' : 'var(--ink-60)', overflowWrap: 'anywhere' }}>
                  {(on && detail[c.key]) || t(c.why)}
                </div>
              </div>
              <span
                style={{
                  width: 38, height: 22, borderRadius: 999, flex: 'none', padding: 2,
                  background: on ? 'var(--grad-accent)' : 'var(--ink-12)', transition: 'background .2s',
                  display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start',
                }}
              >
                <span style={{ width: 18, height: 18, borderRadius: 999, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.2)' }} />
              </span>
            </div>
          );
        })}
      </div>
    </Collapsible>
  );
}
