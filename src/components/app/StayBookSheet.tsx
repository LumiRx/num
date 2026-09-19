// Booking a room — the three screens between picking one and holding a
// confirmation code.
//
// ── WHY THIS SHEET EXISTS WHEN NO OTHER FEATURE PAGE HAS ONE ─────────────
//
// Every other feature page in NUM collects two or three fields and hands the
// ask to the concierge, deliberately: "a page is the fastest honest way to
// start the right conversation" (src/lib/features.ts). That was right while
// every rail ended in a hand-off.
//
// A room is different because the supplier needs specific things — the name on
// the reservation, one name per room, an email the confirmation goes to — and
// because at the end of it money moves and a room comes out of inventory.
// Collecting that in a thread means a person answering four questions one at a
// time and no way to see what they have agreed to before they agree to it.
//
// ── THE THREE THINGS THIS SCREEN IS CAREFUL ABOUT ────────────────────────
//
// 1. HELD IS NOT BOOKED. The hold is taken when they move to confirm, and the
//    copy says exactly what that means. Nothing is reserved and nothing is
//    paid until the last tap.
//
// 2. A HELD PRICE GOES STALE. If they sat on the confirm screen, the price is
//    re-checked rather than trusted. A guest committing against a ten-minute-old
//    number is how somebody is charged a price they never saw.
//
// 3. WHAT IS OWED AT THE DESK IS ON THE CONFIRM SCREEN. A resort fee disclosed
//    after payment is a complaint, and it was ours to mention.
import { useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, XIcon } from '../../lib/icons';
import {
  bookStay, prebookStay, missingForBook, holdIsStale, closeStayBooking,
} from '../../lib/stays';
import type { StayDraft, StayGuest } from '../../lib/stays';
import { t } from '../../lib/i18n';
import { T } from '../../lib/i18nmark';

const field: React.CSSProperties = {
  width: '100%', height: 44, borderRadius: 12, border: '1px solid var(--ink-12)',
  padding: '0 14px', fontSize: 16, background: 'var(--field-bg)', outline: 'none',
  fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff',
  fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '13px 16px',
  display: 'flex', gap: 7, alignItems: 'center', justifyContent: 'center',
  boxShadow: '0 4px 14px rgba(14,164,131,.3)',
};
const label: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 };
const quiet: React.CSSProperties = { fontSize: 10.5, color: 'var(--color-neutral-500)', lineHeight: 1.55, marginTop: 6 };
const row: React.CSSProperties = { display: 'flex', gap: 8 };

const money = (n: number | null | undefined, ccy: string | null) =>
  n == null ? '—' : `${ccy === 'USD' ? '$' : ccy === 'GBP' ? '£' : ccy === 'EUR' ? '€' : ''}${n.toFixed(2)}${ccy && !['USD', 'GBP', 'EUR'].includes(ccy) ? ` ${ccy}` : ''}`;

/** "free until 1 October" beats a timestamp nobody reads. */
const byWhen = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
};

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

  /** Take the hold. This is the first call that touches the supplier. */
  const toConfirm = async () => {
    setTouched(true);
    if (!draft.holder.firstName || !draft.holder.lastName || !draft.holder.email) return;
    if (draft.guests.some((g) => !g.firstName || !g.lastName)) return;
    set({ busy: true, error: null });
    try {
      const hold = await prebookStay(me, option, query);
      store.set({ stayBookOpen: { ...draft, hold, step: 'confirm', busy: false, error: null } });
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

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'flex', alignItems: 'flex-end' }}>
      <div {...pressable(closeStayBooking)} style={{ position: 'absolute', inset: 0, background: 'rgba(24,20,18,.4)' }} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t('Book this stay')} className="glass-strong sheet-in"
        style={{ ...sheetBase, position: 'relative', width: '100%', visibility: 'visible', transform: 'translateY(0)',
          maxHeight: 'min(92%, calc(100% - var(--safe-top, 0px)))', overflowY: 'auto' }}>
        <div style={grabberStyle} />

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, padding: '0 16px' }}>
          <div>
            <div style={label}>{draft.step === 'done' ? t('CONFIRMED') : t('YOUR STAY')}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16, marginTop: 3 }}>{option.hotel}</div>
            <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', marginTop: 2 }}>
              {option.room}{option.board ? ` · ${option.board}` : ''}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', marginTop: 2 }}>
              {query.checkin} → {query.checkout}
            </div>
          </div>
          <div {...pressable(closeStayBooking)} style={{ cursor: 'pointer', padding: 4 }} aria-label={t('Close')}>
            <XIcon size={16} />
          </div>
        </div>

        {/* ── SCREEN 3 · who is staying ───────────────────────────────── */}
        {draft.step === 'guests' && (
          <div style={{ padding: '14px 16px 18px' }}>
            <div style={{ ...quiet, marginTop: 0 }}>
              {t('The hotel needs the name the reservation is under, and a name for each room. Nothing is held or paid yet.')}
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={label}>{t('WHO THE BOOKING IS UNDER')}</div>
              <div style={{ ...row, marginTop: 7 }}>
                <input style={field} placeholder={t('First name')} value={draft.holder.firstName}
                  onChange={(e) => set({ holder: { ...draft.holder, firstName: e.target.value } })} />
                <input style={field} placeholder={t('Last name')} value={draft.holder.lastName}
                  onChange={(e) => set({ holder: { ...draft.holder, lastName: e.target.value } })} />
              </div>
              <input style={{ ...field, marginTop: 8 }} type="email" inputMode="email" placeholder={t('Email for the confirmation')}
                value={draft.holder.email}
                onChange={(e) => set({ holder: { ...draft.holder, email: e.target.value } })} />
              <div style={quiet}>{t('The confirmation goes here. NUM never asks for card details — you pay the hotel’s payment provider directly.')}</div>
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={label}>{t('WHO IS STAYING')}</div>
              {draft.guests.map((g, i) => (
                <div key={i} style={{ ...row, marginTop: 7 }}>
                  <input style={field} placeholder={t('First name')} value={g.firstName}
                    onChange={(e) => setGuest(i, { firstName: e.target.value })} />
                  <input style={field} placeholder={t('Last name')} value={g.lastName}
                    onChange={(e) => setGuest(i, { lastName: e.target.value })} />
                </div>
              ))}
              {draft.guests.length < Math.max(1, query.rooms) && (
                <div {...pressable(() => set({ guests: [...draft.guests, { occupancyNumber: draft.guests.length + 1, firstName: '', lastName: '' }] }))}
                  style={{ ...quiet, cursor: 'pointer', color: 'var(--color-accent)', fontWeight: 700 }}>
                  {t('Add a name for the next room')}
                </div>
              )}
            </div>

            {touched && (!draft.holder.firstName || !draft.holder.lastName || !draft.holder.email
              || draft.guests.some((g) => !g.firstName || !g.lastName)) && (
              <div style={{ ...quiet, color: 'var(--color-danger)' }}>
                {t('The hotel will not take a reservation without these.')}
              </div>
            )}
            {draft.error && <div style={{ ...quiet, color: 'var(--color-danger)' }}>{draft.error}</div>}

            <div {...pressable(toConfirm)} style={{ ...primary, marginTop: 16, opacity: draft.busy ? 0.6 : 1 }}>
              {draft.busy ? t('Checking the room…') : t('SEE WHAT IT COSTS')}
            </div>
          </div>
        )}

        {/* ── SCREEN 4 · confirm ──────────────────────────────────────── */}
        {draft.step === 'confirm' && (
          <div style={{ padding: '14px 16px 18px' }}>
            {moved && (
              <div style={{ borderRadius: 12, padding: '11px 13px', background: 'var(--ink-04)', fontSize: 12, lineHeight: 1.5 }}>
                {t('The hotel’s price moved while you were deciding. This is the current one — nothing has been paid.')}
              </div>
            )}
            {stale && (
              <div style={{ borderRadius: 12, padding: '11px 13px', background: 'var(--ink-04)', fontSize: 12, lineHeight: 1.5 }}>
                {t('This price was held a while ago and may have changed.')}
                <div {...pressable(recheck)} style={{ cursor: 'pointer', color: 'var(--color-accent)', fontWeight: 700, marginTop: 6 }}>
                  {t('Check it again')}
                </div>
              </div>
            )}

            <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontSize: 12.5, color: 'var(--color-neutral-600)' }}>{t('Total for the stay')}</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20 }}>{money(total, ccy)}</div>
            </div>

            {option.payAtHotel != null && (
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontSize: 12.5, color: 'var(--color-neutral-600)' }}>
                  {t('Paid at the hotel')}{option.payAtHotelFor?.length ? ` · ${option.payAtHotelFor.join(', ')}` : ''}
                </div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{money(option.payAtHotel, ccy)}</div>
              </div>
            )}

            <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.55 }}>
              {option.refundable === true && option.cancelBy
                ? t('Free cancellation until {date}', { date: byWhen(option.cancelBy) ?? option.cancelBy })
                : option.refundable === true
                  ? t('This room can be cancelled.')
                  : option.refundable === false
                    ? t('This room cannot be cancelled or refunded.')
                    : t('The hotel has not stated a cancellation policy for this room.')}
            </div>

            <div style={quiet}>
              {t('Nothing is reserved yet. Confirming takes the room and charges the hotel’s payment provider — NUM never holds your money.')}
            </div>

            {touched && missing.length > 0 && (
              <div style={{ ...quiet, color: 'var(--color-danger)' }}>
                {t('Something is still missing on the previous screen.')}
              </div>
            )}
            {draft.error && <div style={{ ...quiet, color: 'var(--color-danger)' }}>{draft.error}</div>}

            <div {...pressable(confirm)} style={{ ...primary, marginTop: 16, opacity: draft.busy || stale ? 0.6 : 1 }}>
              {draft.busy ? t('Taking the room…') : t('CONFIRM AND BOOK')}
            </div>
            <div {...pressable(() => set({ step: 'guests' }))} style={{ ...quiet, textAlign: 'center', cursor: 'pointer' }}>
              {t('Back to the names')}
            </div>
          </div>
        )}

        {/* ── SCREEN 5 · confirmed ────────────────────────────────────── */}
        {draft.step === 'done' && draft.receipt && (
          <div style={{ padding: '14px 16px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckIcon size={16} style={{ color: 'var(--color-accent)' }} />
              <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Booked.')}</div>
            </div>

            {draft.receipt.confirmationCode && (
              <div style={{ marginTop: 12 }}>
                <div style={label}>{t('SHOW THIS AT THE DESK')}</div>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18, letterSpacing: '.04em', marginTop: 3 }}>
                  {draft.receipt.confirmationCode}
                </div>
              </div>
            )}

            <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.6 }}>
              {draft.receipt.hotel}<br />
              {draft.receipt.checkin} → {draft.receipt.checkout}<br />
              {money(draft.receipt.total, draft.receipt.currency)}
              {draft.receipt.payAtHotel ? ` · ${t('plus')} ${money(draft.receipt.payAtHotel, draft.receipt.currency)} ${t('at the hotel')}` : ''}
            </div>

            {draft.receipt.cancelBy && draft.receipt.refundable && (
              <div style={quiet}>
                {t('You can cancel this free until {date}, from your wallet.', { date: byWhen(draft.receipt.cancelBy) ?? draft.receipt.cancelBy })}
              </div>
            )}

            <div {...pressable(closeStayBooking)} style={{ ...primary, marginTop: 16 }}>{t('DONE')}</div>
          </div>
        )}
      </div>
    </div>
  );
}
