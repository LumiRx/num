// The desktop presentation — poster header, the app in an iPhone frame, the
// lock screen beside it, and the v0.8 release notes. Mirrors the design canvas.
import IOSDevice from '../device/IOSDevice';
import ConciergeApp from '../app/ConciergeApp';
import LockScreen from './LockScreen';

export default function PrototypeCanvas() {
  return (
    <div style={{ minHeight: '100vh', padding: '44px 48px 64px', fontFamily: 'var(--font-body)', color: 'var(--color-text)' }}>
      <div style={{ borderBottom: '2px solid var(--color-divider)', paddingBottom: 20, marginBottom: 36 }}>
        <div style={{ fontSize: 11, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>NUM — V0.8 · CANONICAL PROTOTYPE</div>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 34, margin: '8px 0 10px', lineHeight: 1.05 }}>
          Num. Three letters — one fewer than Siri.<br />End results only, one question when it matters.
        </h1>
        <div style={{ fontSize: 13, color: 'var(--color-neutral-700)', maxWidth: 760, lineHeight: 1.55 }}>
          Demo script — ① the morning brief: reshuffled before you woke, one word undoes it. ② “Dinner on Thursday”: two Thursdays, so it asks one
          question. ③ tap the date, then any day: a visual day timeline — every block labeled with day, time and place. ④ “Set a meeting with Mei”:
          her Num agent answers, it lands on both calendars. ⑤ tap the mic and just say it. ⑥ the MEMORY tab keeps everything you’ve done — ask
          “when was that Tokyo omakase?” and it comes straight back. ⑦ run the disruption demo — the lock screen tracks all of it. ⑧ tap ★ in the
          header for the wallet: top up by Apple Pay, card or a crypto link — then try “Pay my bill — Le Du”: the bill is already assigned, one tap
          settles it, the receipt files itself. ⑨ “Let Num organize my photos”: a real permission ask, then photos pair to memories by place — and
          Dan can hold the same memory.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 56, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <IOSDevice width={393} height={852}>
            <ConciergeApp />
          </IOSDevice>
          <div style={{ fontSize: 11, letterSpacing: '.1em', color: 'var(--color-neutral-600)' }}>NUM — ONE THREAD, ONE CALENDAR, ZERO FORMS</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <IOSDevice width={393} height={852} dark>
            <LockScreen />
          </IOSDevice>
          <div style={{ fontSize: 11, letterSpacing: '.1em', color: 'var(--color-neutral-600)' }}>LOCK SCREEN — THE LIVE ACTIVITY TRACKS THE THREAD</div>
        </div>

        <div style={{ maxWidth: 300, paddingTop: 8 }}>
          <div style={{ borderTop: '2px solid var(--color-text)', paddingTop: 14 }}>
            <div style={{ fontSize: 11, letterSpacing: '.14em', fontWeight: 700, marginBottom: 10 }}>WHAT’S NEW IN V0.8 — MONEY &amp; MEMORY</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.65, color: 'var(--color-neutral-800)' }}>
              <p style={{ margin: '0 0 10px' }}><strong>Stars, the payrail.</strong> Buy stars once (Apple Pay, card, or a crypto link we text you) and every booking, ticket and bill settles in one tap — Num takes the transaction, not a form.</p>
              <p style={{ margin: '0 0 10px' }}><strong>Pay by text.</strong> The restaurant assigns the bill to you; “pay my bill” settles it from the thread before you stand up. Stars, Apple Pay, or the link — your call.</p>
              <p style={{ margin: '0 0 10px' }}><strong>Receipts file themselves.</strong> Every payment lands on the event it belongs to — open the booking, the receipt is there.</p>
              <p style={{ margin: '0 0 10px' }}><strong>Photos become memories.</strong> One real permission ask, then photos pair to reservations by time and place. No cluster — they file to the memory shelf.</p>
              <p style={{ margin: 0 }}><strong>Shared memories.</strong> Approve once, and Dan holds the same night on his own shelf — his shots can join yours.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
