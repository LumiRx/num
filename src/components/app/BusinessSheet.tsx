// The owner console. Scoped entirely by verification: what you see is the set
// of listings you proved you own, and the server checks that on every route —
// this component never decides who owns what.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, StarIcon, XIcon } from '../../lib/icons';
import { businessOverview, businessUpdate, businessOfferings, businessOfferingSave, businessOfferingVisible, businessOrders, businessOrderAdvance } from '../../lib/profile';
import { nativePlatform } from '../../lib/native';
import type { BusinessOverview, OfferingsPage, OwnerOrders } from '../../lib/profile';
import { t } from '../../lib/i18n';

const label: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 };
const field: React.CSSProperties = {
  width: '100%', height: 42, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 13px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '12px 16px', textAlign: 'center',
  boxShadow: '0 4px 14px var(--accent-30)',
};

/**
 * WHAT YOU OFFER — products, treatments, rooms, with prices.
 *
 * Dre, 19 Sep 2026: "we need to have his dashboard so he can add his products
 * and pricing." This is the same list the web console edits; here it is
 * keyed off the member, so the dashboard a person lands on after linking is
 * the one they can fill in. Free on every plan. NUM only ever says what is
 * put here — it does not guess a menu.
 *
 * The template comes from the server (a dispensary prices by the eighth and
 * is 21+; a spa sells sessions), so the sections and the example are the
 * trade's own, and the 21+ note is shown to the owner exactly as the console
 * shows it — because the answer path now enforces it (bizoffer.ageMinFor).
 */
function Offerings({ businessId }: { businessId: string }) {
  const [page, setPage] = useState<OfferingsPage | null>(null);
  const [name, setName] = useState('');
  const [section, setSection] = useState('');
  const [price, setPrice] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => { void businessOfferings(businessId).then(setPage); };
  useEffect(load, [businessId]);

  if (!page) return null;
  const tpl = page.template;
  const add = async () => {
    if (busy || !name.trim()) return;
    setBusy(true); setErr(null);
    const out = await businessOfferingSave(businessId, { name, section: section || undefined, price: price || undefined, description: desc || undefined });
    setBusy(false);
    if (!out.ok) { setErr(out.error ?? 'That did not save.'); return; }
    setName(''); setPrice(''); setDesc('');
    load();
  };

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--ink-08)' }}>
      <div style={{ ...label, color: 'var(--ink-60)' }}>{tpl.label.toUpperCase()}</div>
      <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 4, lineHeight: 1.5 }}>
        {t('What NUM tells travellers you offer, at the prices you list. It never guesses.')}
        {tpl.note ? ` ${tpl.note}` : ''}
      </div>

      {page.items.length > 0 && (
        <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
          {page.items.map((o) => (
            <div key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '6px 0', borderBottom: '1px solid var(--ink-08)', opacity: o.active ? 1 : 0.5 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</div>
                <div style={{ fontSize: 10.5, color: 'var(--ink-60)' }}>{[o.section, o.price_label].filter(Boolean).join(' · ') || t('price varies')}</div>
              </div>
              <div
                {...pressable(async () => { if (await businessOfferingVisible(businessId, o.id, !o.active)) load(); })}
                style={{ cursor: 'pointer', fontSize: 10, fontWeight: 800, letterSpacing: '.06em', padding: '8px 10px', borderRadius: 999, border: '1px solid var(--ink-12)', minHeight: 32 }}
              >
                {o.active ? t('HIDE') : t('SHOW')}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
        <input style={field} placeholder={tpl.example || t('Name')} value={name} onChange={(e) => setName(e.target.value)} />
        {tpl.sections.length > 0 && (
          <select style={{ ...field, appearance: 'auto' }} value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="">{t('Section')}</option>
            {tpl.sections.map((sName) => <option key={sName} value={sName}>{sName}</option>)}
          </select>
        )}
        <input style={field} inputMode="decimal" placeholder={tpl.price_hint || t('Price (leave empty if it varies)')} value={price} onChange={(e) => setPrice(e.target.value)} />
        <input style={field} placeholder={t('One line a guest would find useful (optional)')} value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div {...pressable(() => { void add(); })} style={{ ...primary, opacity: name.trim() ? 1 : 0.5 }}>
          {busy ? '\u2026' : `${t('ADD')} ${tpl.noun.toUpperCase()}`}
        </div>
        {err && <div style={{ fontSize: 11, color: 'var(--danger, #c0392b)' }}>{err}</div>}
      </div>
    </div>
  );
}

const STEP: Record<string, string> = {
  accepted: 'ACCEPT', declined: 'DECLINE', preparing: 'PREPARING',
  out_for_delivery: 'ON ITS WAY', delivered: 'DELIVERED', cancelled: 'CANCEL',
};
const ID_LABEL: Record<string, string> = {
  drivers_licence: "Driver's licence", state_id: 'State ID', passport: 'Passport', military_id: 'Military ID',
};

/**
 * ORDERS, ON THE OWNER'S PHONE — AND THE ID CHECK BEFORE ONE CLOSES.
 *
 * `/api/delivery/business` was built with Alfredo in mind and nothing in this
 * app ever called it, so an owner holding a phone could not see an order, let
 * alone move one along. This is that call.
 *
 * For an age-gated shop, DELIVERED opens the check first. What it collects is
 * what the law puts on the licensee — that they looked, at what kind of
 * document, and who they are. It does not collect the licence number, the
 * date of birth or a photograph of the document, and the server refuses a
 * payload carrying any of them rather than dropping them quietly. If a photo
 * is wanted on delivery it should be of the handover, not of somebody's ID.
 */
function Orders({ businessId }: { businessId: string }) {
  const [data, setData] = useState<OwnerOrders | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [idType, setIdType] = useState('drivers_licence');
  const [by, setBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => { void businessOrders(businessId).then(setData); };
  useEffect(load, [businessId]);
  if (!data || !data.orders.length) return null;

  const go = async (orderId: string, status: string) => {
    if (busy) return;
    if (status === 'delivered' && data.age_min > 0 && checking !== orderId) {
      setChecking(orderId); setErr(null); return;
    }
    setBusy(true); setErr(null);
    const check = status === 'delivered' && data.age_min > 0
      ? { id_type: idType, over_min: true as const, checked_by: by.trim() }
      : undefined;
    const out = await businessOrderAdvance(businessId, orderId, status, check);
    setBusy(false);
    if (!out.ok) { setErr(out.error ?? 'That did not go through.'); return; }
    setChecking(null); setBy('');
    load();
  };

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--ink-08)' }}>
      <div style={{ ...label, color: 'var(--ink-60)' }}>{t('ORDERS')}</div>
      {data.orders.map((o) => (
        <div key={o.id} className="glass" style={{ marginTop: 8, padding: 11, borderRadius: 'var(--r-md)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>{o.short_code}</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-60)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{o.status.replace(/_/g, ' ')}</div>
            <div style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700 }}>${(o.total_cs / 100).toFixed(2)}</div>
          </div>
          {o.items && <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>{o.items}</div>}
          {o.delivery_area && <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 2 }}>{o.delivery_area}</div>}

          {checking === o.id ? (
            <div style={{ marginTop: 9, display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-60)', lineHeight: 1.5 }}>
                {t('Check their ID before you hand it over.')} {data.age_min}+.{' '}
                {t('Num records that you checked and what you looked at — never the number on it, and never a photo of it.')}
              </div>
              <select style={{ ...field, appearance: 'auto' }} value={idType} onChange={(e) => setIdType(e.target.value)}>
                {data.id_types.map((k) => <option key={k} value={k}>{ID_LABEL[k] ?? k}</option>)}
              </select>
              <input style={field} placeholder={t('Who checked it')} value={by} onChange={(e) => setBy(e.target.value)} />
              <div {...pressable(() => { void go(o.id, 'delivered'); })} style={{ ...primary, opacity: by.trim() ? 1 : 0.5 }}>
                {busy ? '\u2026' : `${t('CONFIRMED')} ${data.age_min}+ \u2014 ${t('DELIVERED')}`}
              </div>
              <div {...pressable(() => { setChecking(null); setErr(null); })} style={{ cursor: 'pointer', textAlign: 'center', fontSize: 11, color: 'var(--ink-60)', minHeight: 32, paddingTop: 8 }}>
                {t('Back')}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 9 }}>
              {(data.next[o.id] ?? []).map((nxt) => (
                <div
                  key={nxt}
                  {...pressable(() => { void go(o.id, nxt); })}
                  style={{
                    cursor: 'pointer', minHeight: 40, padding: '0 14px', borderRadius: 999,
                    display: 'flex', alignItems: 'center', fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em',
                    background: nxt === 'delivered' ? 'var(--grad-accent)' : 'transparent',
                    color: nxt === 'delivered' ? '#fff' : 'var(--ink)',
                    border: nxt === 'delivered' ? 'none' : '1px solid var(--ink-12)',
                  }}
                >
                  {STEP[nxt] ?? nxt.toUpperCase()}
                </div>
              ))}
            </div>
          )}
          {err && checking === o.id && <div style={{ fontSize: 11, color: 'var(--danger, #c0392b)', marginTop: 7 }}>{err}</div>}
        </div>
      ))}
    </div>
  );
}

export default function BusinessSheet() {
  const open = useApp((s) => s.businessOpen);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  const [data, setData] = useState<BusinessOverview | null>(null);
  const [edit, setEdit] = useState<Record<string, { phone: string; website: string; area: string }>>({});
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !me) return;
    void businessOverview().then((d) => {
      setData(d);
      const seed: typeof edit = {};
      d?.places.forEach((p) => { seed[p.id] = { phone: p.phone ?? '', website: p.website ?? '', area: p.area ?? '' }; });
      setEdit(seed);
    });
  }, [open, me?.id]);

  if (!open) return null;
  const close = () => store.set({ businessOpen: false });

  return (
    <div
      ref={ref}
      className="glass-strong sheet-in"
      style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(88%, calc(100% - var(--sat, 0px) - 8px))', overflowY: 'auto' }}
    >
      <div style={grabberStyle} />
      <div
        {...pressable(close)}
        aria-label={t('Close')}
        className="glass press"
        style={{ position: 'absolute', top: 6, right: 6, width: 44, height: 44, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>

      <div style={{ padding: 16 }}>
        <div style={label}>{t('BUSINESS')}</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>
          {data?.places.length ? t('Your listings') : t('Claim your place')}
        </div>

        {!me && (
          <>
            <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 6, lineHeight: 1.55 }}>{t('Add your name and number first — a claim has to belong to someone.')}</div>
            <div {...pressable(() => store.set({ businessOpen: false, inviteOpen: { intent: 'business', returnTo: { businessOpen: true } } }))} style={{ ...primary, marginTop: 14 }}>{t('INTRODUCE YOURSELF')}</div>
          </>
        )}

        {me && data && !data.places.length && (
          <>
            <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 6, lineHeight: 1.55 }}>
              {data.hint ?? 'No verified listing on this account yet.'} We send a code to the number your business already
              publishes — never to one you type in. That is the whole point: receiving it proves the place is yours.
            </div>
            {/* GUIDELINE 4 — DESIGN. 30 Aug 2026, iOS 1.0(2):
                "the user is taken to the default web browser to sign in or
                register for an account, which provides a poor user
                experience."
                itsnum.com/claim IS a registration flow — it takes a business
                name and sends a verification code — so linking out to it from
                inside the app is the exact thing that rule forbids. There is
                no in-app claim flow yet to point at instead, so on iOS the
                link is not offered at all and the sheet says plainly where the
                thing can be done.
                Same decision, same reason, as the "Continue with Google" card
                in Verify5arz.tsx: 4.0 is about LEAVING THE APP, and no
                alternative login or nicer button fixes that.
                When an in-app claim exists, replace this branch with it —
                do not restore the outbound link. */}
            {nativePlatform() === 'ios' ? (
              <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 14, lineHeight: 1.55 }}>{t('To claim a listing, visit itsnum.com/claim on a computer or phone browser and sign in there. Once the code arrives on your business number, your listing appears here automatically.')}</div>
            ) : (
              <a href="https://itsnum.com/claim" target="_blank" rel="noreferrer" style={{ ...primary, display: 'block', marginTop: 14, textDecoration: 'none', color: '#fff' }}>{t('START A CLAIM')}</a>
            )}
          </>
        )}

        {me && data?.places.map((p) => (
          <div key={p.id} className="glass" style={{ marginTop: 14, padding: 13, borderRadius: 'var(--r-md)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14 }}>{p.name}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3 }}>
                  {[p.category, p.area, p.dest].filter(Boolean).join(' · ')}
                </div>
              </div>
              <span style={{ flex: 'none', fontSize: 9, fontWeight: 800, letterSpacing: '.08em', padding: '4px 8px', borderRadius: 999, background: 'var(--ok-soft)', color: 'var(--ok)', display: 'flex', gap: 4, alignItems: 'center' }}>
                <CheckIcon size={10} />{' '}{t('VERIFIED')}</span>
            </div>
            {p.rating != null && (
              <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 6, display: 'flex', gap: 5, alignItems: 'center' }}>
                <StarIcon size={11} style={{ color: 'var(--color-accent)' }} />
                {p.rating} · {p.reviews ?? 0} reviews · claimed by {p.method ?? 'review'}
              </div>
            )}
            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              {(['phone', 'website', 'area'] as const).map((k) => (
                <input
                  key={k}
                  style={field}
                  placeholder={k === 'phone' ? t('Public phone') : k === 'website' ? t('Website') : 'Area / neighbourhood'}
                  value={edit[p.id]?.[k] ?? ''}
                  onChange={(e) => setEdit((prev) => ({ ...prev, [p.id]: { ...prev[p.id], [k]: e.target.value } }))}
                />
              ))}
              <div
                {...pressable(async () => {
                  const ok = await businessUpdate(p.id, edit[p.id]);
                  setSaved(ok ? p.id : null);
                  setTimeout(() => setSaved(null), 2400);
                })}
                style={primary}
              >
                {saved === p.id ? t('SAVED') : t('SAVE DETAILS')}
              </div>
            </div>
            <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 8, lineHeight: 1.5 }}>{t('These are the details NUM quotes to travellers. Changing the phone here does not change what verified you — that stays tied to the number we already reached you on.')}</div>
            {p.business_id && <Offerings businessId={p.business_id} />}
            {p.business_id && <Orders businessId={p.business_id} />}
          </div>
        ))}

        {!!data?.events?.length && (
          <div style={{ marginTop: 18 }}>
            <div style={{ ...label, color: 'var(--ink-60)' }}>{t('YOUR EVENTS')}</div>
            {data.events.map((e) => (
              <div key={e.id} className="glass" style={{ marginTop: 8, padding: '10px 12px', borderRadius: 'var(--r-md)' }}>
                <div style={{ fontWeight: 700, fontSize: 12.5 }}>{e.title}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-60)' }}>
                  {e.yes} coming of {e.invited} invited{e.day ? ` · ${e.day}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}

        {!!data?.demand?.length && (
          <div style={{ marginTop: 18 }}>
            <div style={{ ...label, color: 'var(--ink-60)' }}>{t('PEOPLE ASKED FOR YOU')}</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 4, lineHeight: 1.5 }}>{t('Requests NUM could not complete — demand, not bookings.')}</div>
            {data.demand.map((d) => (
              <div key={d.ts} style={{ fontSize: 11.5, color: 'var(--ink)', padding: '7px 0', borderBottom: '1px solid var(--ink-08)', lineHeight: 1.5 }}>
                · {d.summary}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
