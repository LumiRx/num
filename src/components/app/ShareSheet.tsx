// Share sheet — live-updates and hide-costs toggles, the share link with
// copy/kill, and the killed state.
import { store, useApp } from '../../lib/store';
import { sheetBase, checkboxStyle } from '../../lib/derive';
import { SHARE_LINK } from '../../lib/data';

export default function ShareSheet() {
  const open = useApp((s) => s.shareOpen);
  const shLive = useApp((s) => s.shLive);
  const shHide = useApp((s) => s.shHide);
  const copied = useApp((s) => s.copied);
  const killed = useApp((s) => s.killed);
  const nBookings = useApp((s) => s.bookings.filter((b) => b.status !== 'cancelled').length);

  const copyLink = () => {
    try {
      navigator.clipboard.writeText(SHARE_LINK);
    } catch {
      // clipboard unavailable — the COPIED state still confirms the tap
    }
    store.set({ copied: true });
  };

  return (
    <div style={{ ...sheetBase, transform: open ? 'translateY(0)' : 'translateY(105%)' }}>
      <div style={{ padding: 16, borderBottom: '2px solid var(--color-divider)' }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>SHARE PLAN</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18, marginTop: 6 }}>Viv’s SE Asia loop</div>
        <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', marginTop: 2 }}>{nBookings} bookings · 3 cities · live</div>
      </div>
      <div
        onClick={() => store.set((s) => ({ shLive: !s.shLive }))}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', borderBottom: '1px solid var(--color-neutral-300)', cursor: 'pointer' }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Live updates</div>
          <div style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>Their copy changes when your plans change</div>
        </div>
        <span style={checkboxStyle(shLive)}>{shLive ? '✓' : ''}</span>
      </div>
      <div
        onClick={() => store.set((s) => ({ shHide: !s.shHide }))}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', borderBottom: '2px solid var(--color-divider)', cursor: 'pointer' }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Hide costs & stars</div>
          <div style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>They see where and when — never what you paid</div>
        </div>
        <span style={checkboxStyle(shHide)}>{shHide ? '✓' : ''}</span>
      </div>
      <div style={{ padding: '14px 16px' }}>
        {!killed ? (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, border: '2px solid var(--color-neutral-300)', padding: '9px 10px', fontSize: 11, color: 'var(--color-neutral-700)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', background: '#fff' }}>
                concierge.travel/p/viv-4k2x
              </div>
              <div
                onClick={copyLink}
                style={{ cursor: 'pointer', background: 'var(--color-accent)', color: '#fff', fontWeight: 700, fontSize: 11, letterSpacing: '.08em', padding: '9px 13px', display: 'flex', alignItems: 'center' }}
              >
                {copied ? 'COPIED' : 'COPY'}
              </div>
            </div>
            <div
              onClick={() => store.set({ killed: true })}
              style={{ marginTop: 12, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-neutral-600)', cursor: 'pointer' }}
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
