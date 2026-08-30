/**
 * Reporting somebody — Apple guideline 1.2.
 *
 * Num carries user-generated content between members: direct messages, comments
 * on shared plans, and the name, bio and avatar a friend can see. Guideline 1.2
 * asks a UGC app for a way to report that content, and until 21 Aug 2026 we had
 * blocking but no reporting — while the App Review notes claimed "report/block
 * via the shield icon in chat". There was no shield icon.
 *
 * Two decisions worth stating, because both are easy to get wrong:
 *
 *  · REPORTING AND BLOCKING ARE SEPARATE ACTS, offered together. Blocking is a
 *    private preference and instant. Reporting says a human should look, and
 *    creates a record we are accountable for. The block box is ticked by
 *    default because somebody upset enough to report rarely wants to keep
 *    hearing from the person meanwhile — but it can be unticked, because
 *    "report a message but stay in the group chat" is a real thing to want.
 *
 *  · THE SUBJECT IS NEVER TOLD. Not that they were reported, not by whom. A
 *    report that notifies its subject is a retaliation risk, and the person
 *    raising it has to be able to trust that.
 */
import { useState } from 'react';
import { pressable } from '../../lib/a11y';
import { reportMember, REPORT_REASONS, type ReportReason } from '../../lib/social';
import { XIcon } from '../../lib/icons';

// Local, matching InviteSheet — the app's sheet controls are defined per-sheet
// rather than in derive, so a shared import here would be the odd one out.
const field: React.CSSProperties = {
  width: '100%', borderRadius: 12, border: '1px solid var(--ink-12)',
  padding: '0 14px', fontSize: 16, background: 'var(--field-bg)', outline: 'none',
  fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff',
  fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '12px 16px',
  display: 'flex', gap: 7, alignItems: 'center', justifyContent: 'center',
  boxShadow: '0 4px 14px rgba(236,48,19,.3)',
};

export default function ReportSheet({
  id, name, context, onClose,
}: {
  id: string;
  name?: string | null;
  context?: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [block, setBlock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const send = async () => {
    if (!reason || busy) return;
    setBusy(true);
    const msg = await reportMember(id, reason, { note, block, context });
    setBusy(false);
    setDone(msg ?? 'Reported. Someone reviews every report.');
  };

  const who = name || 'this person';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Report ${who}`}
      className="glass-strong"
      style={{
        position: 'absolute', left: 6, right: 6, bottom: 0, zIndex: 70,
        borderRadius: 'var(--r-xl) var(--r-xl) 0 0',
        maxHeight: 'calc(100% - env(safe-area-inset-top, 0px) - 12px)',
        overflowY: 'auto',
        paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 10px)',
      }}
    >
      <div
        {...pressable(onClose)}
        aria-label="Close"
        className="glass press"
        style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>

      {done ? (
        <div style={{ padding: 16 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18 }}>Thank you</div>
          <div style={{ fontSize: 12.5, color: 'var(--color-neutral-600)', marginTop: 6, lineHeight: 1.6 }}>{done}</div>
          <div {...pressable(onClose)} style={{ ...primary, marginTop: 14 }}>DONE</div>
        </div>
      ) : (
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 10, letterSpacing: '.16em', fontWeight: 700, color: 'var(--color-neutral-600)' }}>REPORT</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>
            Report {who}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 5, lineHeight: 1.55 }}>
            Someone reviews every report. {who} is never told that you reported them, or that a report exists.
          </div>

          <div style={{ display: 'grid', gap: 6, marginTop: 14 }}>
            {REPORT_REASONS.map((r) => (
              <div
                key={r.id}
                {...pressable(() => setReason(r.id))}
                role="radio"
                aria-checked={reason === r.id}
                style={{
                  cursor: 'pointer', padding: '11px 13px', borderRadius: 12, fontSize: 13,
                  border: `1px solid ${reason === r.id ? 'var(--color-accent)' : 'var(--ink-12)'}`,
                  background: reason === r.id ? 'var(--ink-04)' : 'transparent',
                  fontWeight: reason === r.id ? 700 : 400,
                }}
              >
                {r.label}
              </div>
            ))}
          </div>

          <textarea
            style={{ ...field, height: 74, marginTop: 10, padding: 11, resize: 'none', fontFamily: 'var(--font-body)' }}
            placeholder="Anything else we should know? (optional)"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 12, fontSize: 12, color: 'var(--color-neutral-600)', lineHeight: 1.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={block}
              onChange={(e) => setBlock(e.target.checked)}
              style={{ marginTop: 2, accentColor: 'var(--color-accent)' }}
            />
            <span>
              <b style={{ color: 'var(--ink)' }}>Also block them.</b> They can’t message you or add you again.
            </span>
          </label>

          <div
            {...pressable(send)}
            aria-disabled={!reason || busy}
            style={{ ...primary, marginTop: 14, opacity: !reason || busy ? 0.5 : 1, cursor: busy ? 'wait' : 'pointer' }}
          >
            {busy ? 'SENDING…' : !reason ? 'PICK A REASON' : 'SEND REPORT'}
          </div>
        </div>
      )}
    </div>
  );
}
