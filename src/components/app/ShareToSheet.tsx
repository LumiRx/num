// "Send this to…" — the one picker every shareable card opens.
//
// Two destinations, one list, because to the person holding the phone they
// are the same gesture: a friend's chat, or a plan the group is building.
// See src/lib/sharecard.ts for why they share a payload.
//
// Deliberately NOT the OS share sheet. navigator.share hands the text to
// WhatsApp and the conversation leaves NUM — which is fine and is what
// ShareSheet already offers for inviting people. This one is for the people
// who are already here, where the reply comes back into the same app.
import { useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { closeShareCard, shareToFriend, shareToPlan } from '../../lib/sharecard';
import { CheckIcon, UsersIcon, XIcon } from '../../lib/icons';
import { t } from '../../lib/i18n';

const label: React.CSSProperties = {
  fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700,
};

const row: React.CSSProperties = {
  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 11,
  padding: '0 12px', minHeight: 52, borderRadius: 14,
  border: '1px solid var(--ink-08)', background: 'var(--field-bg)',
};

export default function ShareToSheet() {
  const card = useApp((s) => s.shareCard);
  const friends = useApp((s) => s.friends);
  const plans = useApp((s) => s.plans);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(!!card, ref);

  if (!card) return null;

  const people = friends.filter((f) => f.state === 'active' && f.id);

  // Sent means sent. The sheet stays open just long enough to show it
  // landed, because a sheet that vanishes the instant you tap leaves you
  // wondering whether you tapped the right row.
  const run = async (key: string, fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(key);
    setFailed(null);
    const ok = await fn();
    setBusy(null);
    if (!ok) {
      setFailed(key);
      return;
    }
    setDone(key);
    setTimeout(() => { closeShareCard(); setDone(null); }, 850);
  };

  const Row = ({ id, name, sub, fn }: { id: string; name: string; sub: string; fn: () => Promise<boolean> }) => (
    <div {...pressable(() => void run(id, fn))} style={{ ...row, opacity: busy && busy !== id ? 0.5 : 1 }}>
      <span
        aria-hidden="true"
        style={{
          width: 32, height: 32, borderRadius: 999, flex: 'none', background: 'var(--glass-bg)',
          border: '1px solid var(--ink-08)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 13, color: 'var(--ink-60)',
        }}
      >
        {name ? name[0].toUpperCase() : <UsersIcon size={15} />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{name}</span>
        <span style={{ display: 'block', fontSize: 11, color: 'var(--ink-40)', marginTop: 1 }}>
          {failed === id ? t('That didn’t send — tap to try again') : sub}
        </span>
      </span>
      {done === id
        ? <span style={{ color: 'var(--money)' }}><CheckIcon size={17} /></span>
        : busy === id
          ? <span style={{ fontSize: 10.5, color: 'var(--ink-40)', letterSpacing: '.08em' }}>{t('SENDING')}</span>
          : null}
    </div>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('Send this to')}
      ref={ref}
      className="glass-strong sheet-in"
      style={{ ...sheetBase, maxHeight: 'min(78%, 620px)', display: 'flex', flexDirection: 'column' }}
    >
      <div style={grabberStyle} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '0 4px' }}>
        <div style={label}>{t('SEND THIS TO')}</div>
        <span {...pressable(closeShareCard)} aria-label={t('Close')} style={{ cursor: 'pointer', color: 'var(--ink-40)' }}>
          <XIcon size={16} />
        </span>
      </div>

      {/* What is actually being sent, verbatim. A share sheet that hides the
          message is how people send the wrong thing to the wrong person. */}
      <div
        style={{
          marginTop: 10, borderRadius: 14, border: '1px solid var(--ink-08)', background: 'var(--field-bg)',
          padding: '11px 12px',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{card.title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 3, lineHeight: 1.5 }}>{card.summary}</div>
      </div>

      <div
        className="no-scrollbar"
        style={{ flex: 1, overflowY: 'auto', marginTop: 12, display: 'grid', gap: 8, paddingBottom: 6 }}
      >
        {plans.length > 0 && (
          <>
            <div style={{ ...label, color: 'var(--ink-40)', marginTop: 2 }}>{t('ADD TO A PLAN')}</div>
            {plans.map((p) => (
              <Row
                key={`plan:${p.id}`}
                id={`plan:${p.id}`}
                name={p.title}
                sub={p.dest ? `${p.dest} · goes on as an idea` : t('goes on as an idea')}
                fn={() => shareToPlan(p.id)}
              />
            ))}
          </>
        )}

        {people.length > 0 && (
          <>
            <div style={{ ...label, color: 'var(--ink-40)', marginTop: plans.length ? 8 : 2 }}>{t('SEND TO SOMEONE')}</div>
            {people.map((f) => (
              <Row
                key={`dm:${f.id}`}
                id={`dm:${f.id}`}
                name={f.name ?? 'Friend'}
                sub={t('in your chat')}
                fn={() => shareToFriend(f.id!)}
              />
            ))}
          </>
        )}

        {!plans.length && !people.length && (
          // The honest empty state names the two ways out, because "nowhere
          // to send this" with no next step is a dead end and this sheet is
          // most likely to be opened by someone who has neither yet.
          <div style={{ padding: '26px 18px', textAlign: 'center', color: 'var(--ink-60)', fontSize: 12.5, lineHeight: 1.6 }}>{t('Nowhere to send this yet.')}<div style={{ marginTop: 8 }}>
              <span
                {...pressable(() => { closeShareCard(); store.set({ shareOpen: true }); })}
                className="press tap"
                style={{
                  cursor: 'pointer', borderRadius: 999, padding: '0 16px', fontSize: 11, fontWeight: 700,
                  letterSpacing: '.06em', background: 'var(--grad-accent)', color: '#fff',
                }}
              >
                INVITE SOMEONE
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
