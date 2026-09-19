// Booking a room — the three screens between picking one and holding a
// confirmation code.
//
// ── WHY THIS SHEET EXISTS WHEN NO OTHER FEATURE PAGE HAS ONE ─────────────
//
// Every other feature page collects two or three fields and hands the ask to
// the concierge, deliberately: "a page is the fastest honest way to start the
// right conversation" (src/lib/features.ts). That was right while every rail
// ended in a hand-off.
//
// A room is different. The supplier needs specific things — the name the
// reservation sits under, one name per room, an email the confirmation goes to
// — and at the end of it money moves and a room leaves inventory. Collecting
// that in a thread means four questions answered one at a time and no way to
// see what you are agreeing to before you agree to it.
//
// ── WHAT MAKES IT FEEL SMOOTH RATHER THAN JUST WORK ──────────────────────
//
// Nothing here is decoration. Three screens with money at the end is a place
// people get anxious, and every choice below is aimed at that:
//
//   · A STEP RAIL, so nobody is wondering how much further this goes. Three
//     dots is enough; a progress bar overstates the ceremony.
//   · ONE ANIMATION, REUSED. `.rise-in` carries each step in, staggered down
//     the screen, so a step change reads as movement rather than a repaint.
//     The app already honours prefers-reduced-motion globally, so this costs
//     nothing for anybody who has asked for stillness.
//   · ERRORS ON THE FIELD, not in a block underneath. A red ring on the empty
//     box is findable; "something is missing" is a scavenger hunt.
//   · A SKELETON WHERE THE PRICE WILL BE while it is re-checked, because a
//     number that blinks to a different number is alarming and a number that
//     arrives into a waiting space is not.
//   · THE TICK DRAWS ITSELF at the end (`.check-draw`). Arriving somewhere
//     should feel like arriving.
//
// Colours come from the theme tokens rather than hex, so this follows the
// white base and dark mode without a second pass.
import { useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { XIcon } from '../../lib/icons';
import {
  bookStay, prebookStay, missingForBook, holdIsStale, closeStayBooking,
} from '../../lib/stays';
import type { StayDraft, StayGuest } from '../../lib/stays';
import { t } from '../../lib/i18n';

/* ── surface ──────────────────────────────────────────────────────────── */

const field = (bad = false): React.CSSProperties => ({
  width: '100%', height: 46, borderRadius: 13,
  // The ring IS the error message. A box outlined in the danger colour is
  // found instantly; a sentence at the bottom of a scrolling sheet is not.
  border: `1px solid ${bad ? 'var(--color-danger, #b3261e)' : 'var(--ink-12)'}`,
  boxShadow: bad ? '0 0 0 3px color-mix(in srgb, var(--color-danger, #b3261e) 14%, transparent)' : 'none',
  padding: '0 14px', fontSize: 16, background: 'var(--field-bg)', outline: 'none',
  fontFamily: 'var(--font-body)', color: 'var(--color-text)',
  transition: 'border-color .18s ease, box-shadow .18s ease',
});

const primary = (disabled = false): React.CSSProperties => ({
  cursor: disabled ? 'default' : 'pointer', borderRadius: 999,
  background: disabled ? 'var(--ink-12)' : 'var(--grad-accent)',
  color: disabled ? 'var(--ink-40)' : '#fff',
  fontWeight: 800, fontSize: 12, letterSpacing: '.07em',
  padding: '15px 16px', display: 'flex', gap: 8,
  alignItems: 'center', justifyContent: 'center',
  transition: 'background .2s ease, box-shadow .2s ease, opacity .2s ease',
});

const label: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 800 };
const quiet: React.CSSProperties = { fontSize: 11, color: 'var(--color-neutral-500)', lineHeight: 1.6, marginTop: 7 };
const row: React.CSSProperties = { display: 'flex', gap: 8 };
const note: React.CSSProperties = {
  borderRadius: 13, padding: '11px 13px', background: 'var(--ink-04)',
  fontSize: 12, lineHeight: 1.55,
};

const money = (n: number | null | undefined, ccy: string | null) =>
  n == null ? '—' : `${ccy === 'USD' ? '$' : ccy === 'GBP' ? '£' : ccy === 'EUR' ? '€' : ''}${n.toFixed(2)}${ccy && !['USD', 'GBP', 'EUR'].includes(ccy) ? ` ${ccy}` : ''}`;

/** "free until 1 October" beats a timestamp nobody reads. */
const byWhen = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(String(iso).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
};

const STEPS: Array<StayDraft['step']> = ['guests', 'confirm', 'done'];

/** Three dots. Enough to say "not much further", without the ceremony of a bar. */
function StepRail({ step }: { step: StayDraft['step'] }) {
  const at = STEPS.indexOf(step);
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }} aria-hidden>
      {STEPS.map((s, i) => (
        <div key={s} style={{
          height: 4, borderRadius: 999,
          width: i === at ? 20 : 8,
          background: i <= at ? 'var(--color-accent)' : 'var(--ink-12)',
          transition: 'width .28s cubic-bezier(.3,1,.4,1), background .28s ease',
        }} />
      ))}
    </div>
  );
}

/** The tick draws itself — arriving somewhere should feel like arriving. */
function DrawnCheck() {
  return (
    <div className="check-pop" style={{
      width: 44, height: 44, borderRadius: 999, background: 'var(--grad-accent)',
      display: 'grid', placeItems: 'center',
    }}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path className="check-draw" d="M4.5 12.5l5 5 10-11" stroke="#fff" strokeWidth="2.6"
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export default function StayBookSheet() {
  const draft = useApp((s) => s.stayBookOpen) as StayDraft | null;
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  const [touched, setTouched] = useState(false);
  useDialogFocus(!!draft, ref);
  if (!draft) return null;

  const set = (patch: Partial<StayDraft>) => store.set({ stayBookOpen: { ...draft, ...patch } });
  const { option, query } = draft;
  const missing = missingForBook(draft);

  const setGuest = (i: number, patch: Partial<StayGuest>) =>
    set({ guests: draft.guests.map((g, n) => (n === i ? { ...g, ...patch } : g)) });

  const holderIncomplete = !draft.holder.firstName || !draft.holder.lastName || !draft.holder.email;
  const guestsIncomplete = draft.guests.some((g) => !g.firstName || !g.lastName);
  const bad = (empty: boolean) => touched && empty;

  /** Take the hold. The first call that touches the supplier. */
  const toConfirm = async () => {
    setTouched(true);
    if (holderIncomplete || guestsIncomplete) return;
    set({ busy: true, error: null });
    try {
      const hold = await prebookStay(me, option, query);
      // Marked here and not when the sheet opens: the confirm screen is where
      // the warning is rendered, so this is the first moment it is true.
      store.set({
        stayBookOpen: {
          ...draft, hold, step: 'confirm', busy: false, error: null,
          loyaltyDisclosed: draft.loyaltyWarning,
        },
      });
    } catch (err) {
      set({ busy: false, error: (err as Error).message });
    }
  };

  /** Re-take the hold, because the one they have has aged out. */
  const recheck = async () => {
    set({ busy: true, error: null });
    try {
      const hold = await prebookStay(me, option, query);
      store.set({ stayBookOpen: { ...draft, hold, busy: false, error: null } });
    } catch (err) {
      set({ busy: false, error: (err as Error).message });
    }
  };

  const confirm = async () => {
    if (missing.length) { setTouched(true); return; }
    set({ busy: true, error: null });
    try {
      const receipt = await bookStay(me, draft);
      store.set({ stayBookOpen: { ...draft, receipt, step: 'done', busy: false, error: null } });
    } catch (err) {
      set({ busy: false, error: (err as Error).message });
    }
  };

  const stale = draft.step === 'confirm' && holdIsStale(draft.hold);
  const moved = draft.hold?.priceChanged === true;
  const total = draft.hold?.total ?? option.total;
  const ccy = draft.hold?.currency ?? option.currency;
  /** Stagger down the screen, so a step arrives rather than repaints. */
  const rise = (i: number): React.CSSProperties => ({ animationDelay: `${i * 45}ms` });

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'flex', alignItems: 'flex-end' }}>
      <div {...pressable(closeStayBooking)}
        style={{ position: 'absolute', inset: 0, background: 'rgba(24,20,18,.42)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t('Book this stay')} className="glass-strong sheet-in"
        style={{
          ...sheetBase, position: 'relative', width: '100%', visibility: 'visible', transform: 'translateY(0)',
          maxHeight: 'min(92%, calc(100% - var(--safe-top, 0px)))', overflowY: 'auto',
        }}>
        <div style={grabberStyle} />

        {/* The stay itself stays put across all three steps — it is the thing
            being agreed to, and losing sight of it mid-flow is disorienting. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, padding: '0 16px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={label}>{draft.step === 'done' ? t('CONFIRMED') : t('YOUR STAY')}</div>
              {draft.step !== 'done' && <StepRail step={draft.step} />}
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 17, marginTop: 4, lineHeight: 1.25 }}>
              {option.hotel}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', marginTop: 3, lineHeight: 1.5 }}>
              {option.room}{option.board ? ` · ${option.board}` : ''}<br />
              {query.checkin} → {query.checkout}
            </div>
          </div>
          <div {...pressable(closeStayBooking)} className="tap" style={{ cursor: 'pointer', padding: 6, borderRadius: 999 }} aria-label={t('Close')}>
            <XIcon size={16} />
          </div>
        </div>

        {/* ── 3 · who is staying ──────────────────────────────────────── */}
        {draft.step === 'guests' && (
          <div key="guests" style={{ padding: '16px 16px 20px' }}>
            <div className="rise-in" style={{ ...quiet, marginTop: 0, ...rise(0) }}>
              {t('The hotel needs the name the reservation is under, and a name for each room. Nothing is held or paid yet.')}
            </div>

            <div className="rise-in" style={{ marginTop: 16, ...rise(1) }}>
              <div style={label}>{t('WHO THE BOOKING IS UNDER')}</div>
              <div style={{ ...row, marginTop: 8 }}>
                <input style={field(bad(!draft.holder.firstName))} placeholder={t('First name')} value={draft.holder.firstName}
                  aria-invalid={bad(!draft.holder.firstName)} aria-label={t('First name')}
                  onChange={(e) => set({ holder: { ...draft.holder, firstName: e.target.value } })} />
                <input style={field(bad(!draft.holder.lastName))} placeholder={t('Last name')} value={draft.holder.lastName}
                  aria-invalid={bad(!draft.holder.lastName)} aria-label={t('Last name')}
                  onChange={(e) => set({ holder: { ...draft.holder, lastName: e.target.value } })} />
              </div>
              <input style={{ ...field(bad(!draft.holder.email)), marginTop: 8 }} type="email" inputMode="email"
                placeholder={t('Email for the confirmation')} value={draft.holder.email}
                aria-invalid={bad(!draft.holder.email)} aria-label={t('Email for the confirmation')}
                onChange={(e) => set({ holder: { ...draft.holder, email: e.target.value } })} />
              <input style={{ ...field(), marginTop: 8 }} type="tel" inputMode="tel" placeholder={t('Phone (optional)')}
                value={draft.holder.phone} aria-label={t('Phone (optional)')}
                onChange={(e) => set({ holder: { ...draft.holder, phone: e.target.value } })} />
              <div style={quiet}>
                {t('The confirmation goes here. The phone is only so the hotel can reach you if your plans change — NUM never asks for card details, and you pay the hotel’s payment provider directly.')}
              </div>
            </div>

            <div className="rise-in" style={{ marginTop: 18, ...rise(2) }}>
              <div style={label}>{t('WHO IS STAYING')}</div>
              {draft.guests.map((g, i) => (
                <div key={i} style={{ ...row, marginTop: 8 }}>
                  <input style={field(bad(!g.firstName))} placeholder={t('First name')} value={g.firstName}
                    aria-invalid={bad(!g.firstName)} aria-label={t('Guest first name')}
                    onChange={(e) => setGuest(i, { firstName: e.target.value })} />
                  <input style={field(bad(!g.lastName))} placeholder={t('Last name')} value={g.lastName}
                    aria-invalid={bad(!g.lastName)} aria-label={t('Guest last name')}
                    onChange={(e) => setGuest(i, { lastName: e.target.value })} />
                </div>
              ))}
              {draft.guests.length < Math.max(1, query.rooms) && (
                <div {...pressable(() => set({ guests: [...draft.guests, { occupancyNumber: draft.guests.length + 1, firstName: '', lastName: '' }] }))}
                  className="tap" style={{ ...quiet, cursor: 'pointer', color: 'var(--color-accent)', fontWeight: 700 }}>
                  {t('Add a name for the next room')}
                </div>
              )}
            </div>

            {draft.error && <div style={{ ...note, marginTop: 14, color: 'var(--color-danger, #b3261e)' }}>{draft.error}</div>}

            <div {...pressable(toConfirm)} className={draft.busy ? '' : 'press glow'}
              style={{ ...primary(draft.busy), marginTop: 18 }}
              role="button" aria-disabled={draft.busy}>
              {draft.busy ? t('Checking the room…') : t('SEE WHAT IT COSTS')}
            </div>
          </div>
        )}

        {/* ── 4 · confirm ─────────────────────────────────────────────── */}
        {draft.step === 'confirm' && (
          <div key="confirm" style={{ padding: '16px 16px 20px' }}>
            {moved && (
              <div className="rise-in" style={{ ...note, ...rise(0) }}>
                {t('The hotel’s price moved while you were deciding. This is the current one — nothing has been paid.')}
              </div>
            )}
            {stale && (
              <div className="rise-in" style={{ ...note, marginTop: moved ? 8 : 0, ...rise(0) }}>
                {t('This price was held a while ago and may have changed.')}
                <div {...pressable(recheck)} className="tap"
                  style={{ cursor: 'pointer', color: 'var(--color-accent)', fontWeight: 700, marginTop: 6 }}>
                  {t('Check it again')}
                </div>
              </div>
            )}

            <div className="rise-in" style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, ...rise(1) }}>
              <div style={{ fontSize: 12.5, color: 'var(--color-neutral-600)' }}>{t('Total for the stay')}</div>
              {draft.busy
                // A number that blinks to a different number is alarming. A
                // number that arrives into a space already held for it is not.
                ? <div className="skel" style={{ width: 92, height: 26 }} aria-label={t('Checking the price')} />
                : <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, letterSpacing: '-.01em' }}>{money(total, ccy)}</div>}
            </div>

            {option.payAtHotel != null && (
              <div className="rise-in" style={{ marginTop: 9, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, ...rise(2) }}>
                <div style={{ fontSize: 12.5, color: 'var(--color-neutral-600)' }}>
                  {t('Paid at the hotel')}{option.payAtHotelFor?.length ? ` · ${option.payAtHotelFor.join(', ')}` : ''}
                </div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{money(option.payAtHotel, ccy)}</div>
              </div>
            )}

            <div className="rise-in" style={{ marginTop: 13, fontSize: 12.5, lineHeight: 1.55, ...rise(3) }}>
              {option.refundable === true && option.cancelBy
                ? t('Free cancellation until {date}', { date: byWhen(option.cancelBy) ?? option.cancelBy })
                : option.refundable === true
                  ? t('This room can be cancelled.')
                  : option.refundable === false
                    ? t('This room cannot be cancelled or refunded.')
                    : t('The hotel has not stated a cancellation policy for this room.')}
            </div>

            {(option.checkinFrom || option.checkoutBefore) && (
              <div className="rise-in" style={{ marginTop: 7, fontSize: 12, color: 'var(--color-neutral-600)', ...rise(4) }}>
                {option.checkinFrom ? t('Check in from {from}', { from: option.checkinFrom }) : ''}
                {option.checkinFrom && option.checkoutBefore ? ' · ' : ''}
                {option.checkoutBefore ? t('out by {to}', { to: option.checkoutBefore }) : ''}
              </div>
            )}

            {draft.loyaltyWarning && (
              // Shown BEFORE the tap, never after. A room bought this way earns
              // none of the chain's points, and some chains no longer give
              // elite benefits on it at all. Losing a night's upgrade to save
              // eleven dollars is not a saving.
              <div className="rise-in" style={{ ...note, marginTop: 13, ...rise(5) }}>
                {t('This booking won’t earn {chain} points, and some chains don’t give members their usual upgrades or breakfast on bookings made this way.', { chain: option.chain || t('the hotel’s') })}
                <div style={{ marginTop: 5 }}>
                  {t('If you have status with them, it may be worth booking on the hotel’s own site instead — say the word and NUM will find it.')}
                </div>
              </div>
            )}

            <div className="rise-in" style={{ ...quiet, ...rise(6) }}>
              {t('Nothing is reserved yet. Confirming takes the room and charges the hotel’s payment provider — NUM never holds your money.')}
            </div>

            {draft.error && <div style={{ ...note, marginTop: 12, color: 'var(--color-danger, #b3261e)' }}>{draft.error}</div>}

            <div {...pressable(confirm)} className={draft.busy || stale ? '' : 'press glow'}
              style={{ ...primary(draft.busy || stale), marginTop: 18 }}
              role="button" aria-disabled={draft.busy || stale}>
              {draft.busy ? t('Taking the room…') : t('CONFIRM AND BOOK')}
            </div>
            <div {...pressable(() => set({ step: 'guests' }))} className="tap"
              style={{ ...quiet, textAlign: 'center', cursor: 'pointer', padding: '4px 0' }}>
              {t('Back to the names')}
            </div>
          </div>
        )}

        {/* ── 5 · confirmed ───────────────────────────────────────────── */}
        {draft.step === 'done' && draft.receipt && (
          <div key="done" style={{ padding: '18px 16px 22px' }}>
            <div className="rise-in" style={{ display: 'flex', alignItems: 'center', gap: 12, ...rise(0) }}>
              <DrawnCheck />
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19 }}>{t('Booked.')}</div>
            </div>

            {draft.receipt.confirmationCode && (
              // The reason this screen exists. Big enough to read across a desk
              // at midnight, and boxed so it is findable in a hurry.
              <div className="rise-in" style={{
                marginTop: 16, borderRadius: 15, padding: '13px 15px',
                background: 'var(--ink-04)', border: '1px solid var(--ink-08)', ...rise(1),
              }}>
                <div style={label}>{t('SHOW THIS AT THE DESK')}</div>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, letterSpacing: '.05em', marginTop: 4 }}>
                  {draft.receipt.confirmationCode}
                </div>
              </div>
            )}

            <div className="rise-in" style={{ marginTop: 14, fontSize: 12.5, lineHeight: 1.65, ...rise(2) }}>
              {draft.receipt.hotel}<br />
              {draft.receipt.checkin} → {draft.receipt.checkout}<br />
              <strong>{money(draft.receipt.total, draft.receipt.currency)}</strong>
              {draft.receipt.payAtHotel ? ` · ${t('plus')} ${money(draft.receipt.payAtHotel, draft.receipt.currency)} ${t('at the hotel')}` : ''}
            </div>

            {draft.receipt.cancelBy && draft.receipt.refundable && (
              <div className="rise-in" style={{ ...quiet, ...rise(3) }}>
                {t('You can cancel this free until {date}, from your wallet.', { date: byWhen(draft.receipt.cancelBy) ?? draft.receipt.cancelBy })}
              </div>
            )}

            <div {...pressable(closeStayBooking)} className="press glow" style={{ ...primary(), marginTop: 18 }} role="button">
              {t('DONE')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
