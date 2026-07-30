// Share sheet — live-updates and hide-costs toggles, the share link with
// copy/kill, and the killed state.
import { useRef } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, checkboxStyle, grabberStyle } from '../../lib/derive';
import { CheckIcon, CopyIcon, XIcon } from '../../lib/icons';
import { SHARE_LINK } from '../../lib/data';

export default function ShareSheet() {
  const open = useApp((s) => s.shareOpen);
  const shLive = useApp((s) => s.shLive);
  const shHide = useApp((s) => s.shHide);
  const copied = useApp((s) => s.copied);
  const killed = useApp((s) => s.killed);
  const nBookings = useApp((s) => s.bookings.filter((b) => b.status !== 'cancelled').length);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  const copyLink = () => {
    try {
      navigator.clipboard.writeText(SHARE_LINK);
    } catch {
      // clipboard unavailable — the COPIED state still confirms the tap
    }
    store.set({ copied: true });
  };

  const close = () => store.set({ shareOpen: false });
  return (
    <div ref={ref} className="glass-strong" style={{ ...sheetBase, visibility: open ? 'visible' : 'hidden', transform: open ? 'translateY(0)' : 'translateY(105%)' }}>
      <div style={grabberStyle} />
      <div
        {...pressable(close)}
        aria-label="Close"
        className="glass press"
        style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>
      <div style={{ padding: 16, borderBottom: '1px solid var(--ink-08)' }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>SHARE PLAN</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>Viv’s SE Asia loop</div>
        <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', marginTop: 2 }}>{nBookings} bookings · 3 cities · live</div>
      </div>
      <div
        {...pressable(() => store.set((s) => ({ shLive: !s.shLive })), 'checkbox')}
        aria-checked={shLive}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', borderBottom: '1px solid var(--ink-08)', cursor: 'pointer' }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Live updates</div>
          <div style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>Their copy changes when your plans change</div>
        </div>
        <span style={checkboxStyle(shLive)}>{shLive ? <CheckIcon size={14} /> : null}</span>
      </div>
      <div
        {...pressable(() => store.set((s) => ({ shHide: !s.shHide })), 'checkbox')}
        aria-checked={shHide}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', borderBottom: '1px solid var(--ink-08)', cursor: 'pointer' }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Hide costs & stars</div>
          <div style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>They see where and when — never what you paid</div>
        </div>
        <span style={checkboxStyle(shHide)}>{shHide ? <CheckIcon size={14} /> : null}</span>
      </div>
      <div style={{ padding: '14px 16px' }}>
        {!killed ? (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, borderRadius: 999, border: '1px solid var(--ink-12)', padding: '9px 14px', fontSize: 11, color: 'var(--color-neutral-700)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', background: 'var(--field-bg)' }}>
                concierge.travel/p/viv-4k2x
              </div>
              <div
                {...pressable(copyLink)}
                className="press"
                style={{ cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', boxShadow: '0 3px 10px rgba(236,48,19,.3)', color: '#fff', fontWeight: 700, fontSize: 11, letterSpacing: '.08em', padding: '9px 13px', display: 'flex', gap: 6, alignItems: 'center' }}
              >
                <CopyIcon size={13} />
                {copied ? 'COPIED' : 'COPY'}
              </div>
            </div>
            <div
              {...pressable(() => store.set({ killed: true }))}
              style={{ marginTop: 12, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-accent-700)', cursor: 'pointer' }}
            >
              KILL THIS LINK
            </div>
            <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--color-neutral-500)', lineHeight: 1.5 }}>
              Opens in any browser. No app, no account — a webcal feed lets it live inside their calendar.
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--color-neutral-700)', lineHeight: 1.5 }}>
            Link killed — anyone holding it now sees nothing. Ask me in the thread when you want a new one.
          </div>
        )}
      </div>
    </div>
  );
}
