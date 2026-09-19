// The bill at your table, and every way you may pay it.
//
// One card per rail, in the order the server chose for THIS venue and THIS
// phone. Tapping a card leaves the app for the thing that takes the money —
// Stripe's page on the venue's account, the venue's own payment page, a
// wallet — and the pay page brings the guest back with a receipt. The app
// adds what a browser tab cannot: your saved details via Link and the
// wallets your phone has, and a shared tab to split it with friends.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { XIcon } from '../../lib/icons';
import { t } from '../../lib/i18n';
import { loadBill, startRail, splitShares, tryAutoPay, autoPayNote, type BillView, type BillRail, type BillShare } from '../../lib/bill';
import { openTab, loadTab, type TabState } from '../../lib/tabs';

const BADGE: Record<string, string> = {
  apple_pay: ' Pay', google_pay: 'G Pay', card: 'CARD', link: 'Link', cashapp: '$', amazon_pay: 'a',
  alipay: '支', wechat_pay: '微', pay_by_bank: 'BANK', revolut_pay: 'R', paypal: 'PayPal',
  promptpay_stripe: 'PP', promptpay_sticker: 'PP', venue_link: '↗', usdc_stripe: 'USDC', usdc_direct: 'USDC',
};

export default function BillSheet() {
  const token = useApp((s) => s.billOpen);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(!!token, ref);
  const [view, setView] = useState<BillView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Auto-pay, if this member turned it on. The server decides; this only asks
  // once per opened bill and shows whichever answer comes back.
  const [auto, setAuto] = useState<'trying' | 'paid' | null>(null);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  // Splitting happens in two steps, deliberately. Opening a tab gets a code
  // for friends to join with; only once they are on it does anybody's share
  // get minted, because a share minted for a person who is not there is a
  // live bill code nobody is going to pay.
  const [tab, setTab] = useState<TabState | null>(null);
  const [shares, setShares] = useState<BillShare[] | null>(null);
  const [splitErr, setSplitErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setView(null); setErr(null); setBusy(null); setAuto(null); setAutoNote(null);
    setTab(null); setShares(null); setSplitErr(null);
    let alive = true;
    void loadBill(token).then(async (r) => {
      if (!alive) return;
      if (!r.ok) { setErr(r.status === 404 ? t('This code is not one of ours. Nothing was charged.') : r.error); return; }
      setView(r.view);
      // Only for a real, unpaid, fixed-amount bill, and only for a signed-in
      // member. Everything else is a tap, exactly as it was before.
      const b = r.view.bill;
      if (!me?.id || b.state !== 'open' || !b.fixed) return;
      setAuto('trying');
      const out = await tryAutoPay(token, me.id);
      if (!alive) return;
      if (!out.ok) { setAuto(null); setAutoNote(autoPayNote(out)); return; }
      setAuto('paid');
      // Re-read rather than assuming: the receipt a guest shows staff should be
      // the server's word that this is settled, not this screen's optimism.
      const again = await loadBill(token);
      if (alive && again?.ok) setView(again.view);
    });
    return () => { alive = false; };
  }, [token]);

  if (!token) return null;
  const close = () => store.set({ billOpen: null });
  const bill = view?.bill;
  const rails = (view?.rails ?? []).filter((r) => r.ready && r.source !== 'app');
  const amount = bill?.amount ? `${bill.currency} ${bill.amount}` : null;

  const go = (r: BillRail) => { setBusy(r.id); startRail(r, me?.id); };

  /** Step one: a tab, and a code the others read off this screen. */
  const startSplit = async () => {
    if (!bill) return;
    setBusy('tab'); setSplitErr(null);
    const st = await openTab(bill.label ? `${bill.venue} · ${bill.label}` : bill.venue, bill.venue);
    setBusy(null);
    if (st) setTab(st); else setSplitErr(t('Could not open a tab just now.'));
  };

  const refreshTab = async () => {
    if (!tab) return;
    const st = await loadTab(tab.tab.id);
    if (st) setTab(st);
  };

  /** Step two: one real bill code each, sent to their NUM. */
  const sendShares = async () => {
    if (!bill || !tab) return;
    setBusy('shares'); setSplitErr(null);
    const people = tab.members.map((m) => ({ member_id: m.member_id, name: m.name }));
    const out = await splitShares(bill.token, people, me?.id ?? null);
    setBusy(null);
    if (!out.ok) { setSplitErr(out.error); return; }
    setShares(out.shares);
    // Re-read: this screen now shows a bill that has been split, and it should
    // say so because the server says so, not because we just asked it to.
    const again = await loadBill(bill.token);
    if (again.ok) setView(again.view);
  };

  /** The share that was minted for whoever is looking at this screen. */
  const mine = shares?.find((sh) => sh.member_id && sh.member_id === me?.id) ?? null;

  return (
    <div ref={ref} className="glass-strong sheet-in" style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(92%, calc(100% - var(--sat, 0px) - 8px))', overflowY: 'auto' }}>
      <div style={grabberStyle} />
      <div {...pressable(close)} aria-label={t('Close')} className="glass press" style={{ position: 'absolute', top: 6, right: 6, width: 44, height: 44, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>{t('YOUR BILL')}</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>
          {bill ? bill.venue : err ? t('Something is off') : t('One moment…')}
        </div>
        {bill?.label && <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 2 }}>{bill.label}</div>}
        {amount && <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 32, marginTop: 10 }}>{amount}</div>}

        {/* WHAT YOU ARE PAYING FOR, when the venue itemised it. The lines add
            up to the figure above because the server minted the bill FROM
            them — there is no second total anywhere that could disagree. */}
        {!!bill?.items?.length && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--ink-12)', paddingTop: 10 }}>
            {bill.items.map((it, i) => (
              <div key={`${it.name}-${i}`} style={{ display: 'flex', gap: 10, fontSize: 13, lineHeight: 1.9, color: 'var(--ink-60)' }}>
                <div style={{ flex: 'none', width: 28, fontVariantNumeric: 'tabular-nums' }}>{it.qty}&times;</div>
                <div style={{ flex: 1, minWidth: 0 }}>{it.name}</div>
                <div style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{(it.line_minor / 100).toFixed(2)}</div>
              </div>
            ))}
          </div>
        )}

        {err && <div style={{ fontSize: 13, color: 'var(--ink-60)', marginTop: 10, lineHeight: 1.55 }}>{err}</div>}

        {/* Once the shares are out, this screen's job is to hand the person
            who split it their own one. Theirs is a bill like any other — it
            opens in the same sheet, with the same rails. */}
        {mine && (
          <div style={{ marginTop: 14, borderRadius: 16, border: '1.5px solid var(--color-accent)', padding: 14 }}>
            <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>{t('YOUR SHARE')}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 26, marginTop: 6 }}>
              {bill?.currency} {mine.amount}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 6, lineHeight: 1.5 }}>
              {t('Everyone else has theirs in their NUM.')}
            </div>
            <div
              {...pressable(() => store.set({ billOpen: mine.token }))}
              role="button"
              className="press"
              style={{ cursor: 'pointer', marginTop: 10, minHeight: 44, boxSizing: 'border-box', borderRadius: 999, border: '1px solid var(--ink-12)', padding: '13px 16px', textAlign: 'center', fontSize: 12, fontWeight: 700, letterSpacing: '.06em' }}
            >
              {t('PAY YOUR SHARE')}
            </div>
          </div>
        )}

        {bill && bill.state === 'paid' && (
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-60)' }}>
            {t('Paid — thank you.')} {t('Show this to staff if asked. Nothing further is owed on this code.')}
            <div style={{ marginTop: 6, fontWeight: 700, letterSpacing: '.06em' }}>{bill.token}</div>
          </div>
        )}

        {bill && bill.state === 'split' && !mine && (
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-60)' }}>
            {t('This bill was split. Everyone pays their own share, and each share was sent to their NUM.')}
          </div>
        )}

        {bill && bill.state === 'open' && !bill.fixed && (
          <div style={{ fontSize: 13, color: 'var(--ink-60)', marginTop: 10, lineHeight: 1.55 }}>
            {t('This code has no amount on it yet. Ask staff for the bill — they put the figure on and a fresh code appears here.')}
          </div>
        )}

        {auto === 'trying' && (
          <div style={{ fontSize: 13, color: 'var(--ink-60)', marginTop: 12, lineHeight: 1.55 }}>{t('Paying this for you…')}</div>
        )}

        {bill && bill.state === 'open' && bill.fixed && auto !== 'trying' && (
          <>
            {autoNote && (
              <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 12, lineHeight: 1.5 }}>{autoNote}</div>
            )}
            <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 12 }}>{t('How would you like to pay?')}</div>
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              {rails.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--ink-60)', lineHeight: 1.55 }}>
                  {t('No way to pay this through NUM right now — staff can take payment their usual way. Nothing was charged.')}
                </div>
              )}
              {rails.map((r, i) => (
                <div
                  key={r.id}
                  {...pressable(() => go(r))}
                  role="button"
                  aria-label={`${r.label}. ${r.how}`}
                  className="glass press"
                  style={{
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', minHeight: 66, borderRadius: 16,
                    border: i === 0 ? '1.5px solid var(--color-accent)' : '1px solid var(--ink-12)', opacity: busy && busy !== r.id ? 0.6 : 1,
                  }}
                >
                  <div aria-hidden style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--field-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12, flex: 'none' }}>
                    {BADGE[r.id] ?? ''}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{r.label}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--ink-60)', lineHeight: 1.4 }}>{busy === r.id ? t('Opening…') : r.how}</div>
                  </div>
                  <div aria-hidden style={{ color: 'var(--ink-40)', fontSize: 22, lineHeight: 1 }}>›</div>
                </div>
              ))}
            </div>

            {me && !tab && (
              <div
                {...pressable(startSplit)}
                role="button"
                style={{ cursor: 'pointer', marginTop: 12, minHeight: 44, boxSizing: 'border-box', borderRadius: 999, border: '1px dashed var(--ink-12)', padding: '13px 16px', textAlign: 'center', fontSize: 12, fontWeight: 700, letterSpacing: '.06em', opacity: busy === 'tab' ? 0.6 : 1 }}
              >
                {busy === 'tab' ? t('OPENING A TAB…') : t('SPLIT IT WITH FRIENDS')}
              </div>
            )}

            {/* The tab is open: friends join with the code, then everyone gets
                a real bill code of their own. Nobody's money passes through
                anybody else — four shares are four charges on the venue's own
                account, which is the only way NUM can do this at all. */}
            {me && tab && (
              <div style={{ marginTop: 12, borderRadius: 16, border: '1px solid var(--ink-12)', padding: 14 }}>
                <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>{t('SPLITTING THIS BILL')}</div>
                <div style={{ fontSize: 13, color: 'var(--ink-60)', marginTop: 8, lineHeight: 1.55 }}>
                  {t('Read this code to the others — they open NUM and join.')}
                </div>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 26, letterSpacing: '.14em', marginTop: 6 }}>{tab.tab.code}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 10 }}>
                  {tab.members.length === 1
                    ? t('Just you so far.')
                    : tab.members.map((m) => m.name || t('Someone')).join(', ')}
                </div>
                <div
                  {...pressable(refreshTab)}
                  role="button"
                  style={{ cursor: 'pointer', marginTop: 10, minHeight: 44, boxSizing: 'border-box', borderRadius: 999, border: '1px solid var(--ink-12)', padding: '13px 16px', textAlign: 'center', fontSize: 12, fontWeight: 700, letterSpacing: '.06em' }}
                >
                  {t('WHO IS ON IT?')}
                </div>
                {tab.members.length > 1 && !shares && (
                  <div
                    {...pressable(sendShares)}
                    role="button"
                    className="press"
                    style={{ cursor: 'pointer', marginTop: 8, minHeight: 44, boxSizing: 'border-box', borderRadius: 999, border: '1.5px solid var(--color-accent)', padding: '13px 16px', textAlign: 'center', fontSize: 12, fontWeight: 700, letterSpacing: '.06em', opacity: busy === 'shares' ? 0.6 : 1 }}
                  >
                    {busy === 'shares'
                      ? t('SENDING…')
                      : `${t('SEND EVERYONE THEIR SHARE')} (${tab.members.length})`}
                  </div>
                )}
                {splitErr && <div style={{ fontSize: 12.5, color: 'var(--ink-60)', marginTop: 8, lineHeight: 1.5 }}>{splitErr}</div>}
                <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 10, lineHeight: 1.5 }}>
                  {t('Each share is its own bill, paid straight to the venue. NUM never moves money between you.')}
                </div>
              </div>
            )}

            <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 10, lineHeight: 1.5 }}>
              {t('Whichever you choose, the money goes to the venue — NUM never holds it and never sees your card. Card payments are taken by the venue\'s own Stripe account. Stars never pay a venue bill; a tab settles the split between friends.')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
