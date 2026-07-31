// The owner console. Scoped entirely by verification: what you see is the set
// of listings you proved you own, and the server checks that on every route —
// this component never decides who owns what.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, StarIcon, XIcon } from '../../lib/icons';
import { businessOverview, businessUpdate } from '../../lib/profile';
import type { BusinessOverview } from '../../lib/profile';

const label: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 };
const field: React.CSSProperties = {
  width: '100%', height: 42, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 13px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '12px 16px', textAlign: 'center',
  boxShadow: '0 4px 14px rgba(236,48,19,.3)',
};

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
      className="glass-strong"
      style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: '88%', overflowY: 'auto' }}
    >
      <div style={grabberStyle} />
      <div
        {...pressable(close)}
        aria-label="Close"
        className="glass press"
        style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}
      >
        <XIcon size={15} />
      </div>

      <div style={{ padding: 16 }}>
        <div style={label}>BUSINESS</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>
          {data?.places.length ? 'Your listings' : 'Claim your place'}
        </div>

        {!me && (
          <>
            <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 6, lineHeight: 1.55 }}>
              Add your name and number first — a claim has to belong to someone.
            </div>
            <div {...pressable(() => store.set({ businessOpen: false, inviteOpen: {} }))} style={{ ...primary, marginTop: 14 }}>
              INTRODUCE YOURSELF
            </div>
          </>
        )}

        {me && data && !data.places.length && (
          <>
            <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 6, lineHeight: 1.55 }}>
              {data.hint ?? 'No verified listing on this account yet.'} We send a code to the number your business already
              publishes — never to one you type in. That is the whole point: receiving it proves the place is yours.
            </div>
            <a href="https://itsnum.com/claim" target="_blank" rel="noreferrer" style={{ ...primary, display: 'block', marginTop: 14, textDecoration: 'none', color: '#fff' }}>
              START A CLAIM
            </a>
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
              <span style={{ flex: 'none', fontSize: 9, fontWeight: 800, letterSpacing: '.08em', padding: '4px 8px', borderRadius: 999, background: 'rgba(22,140,90,.14)', color: '#0e6b45', display: 'flex', gap: 4, alignItems: 'center' }}>
                <CheckIcon size={10} /> VERIFIED
              </span>
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
                  placeholder={k === 'phone' ? 'Public phone' : k === 'website' ? 'Website' : 'Area / neighbourhood'}
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
                {saved === p.id ? 'SAVED' : 'SAVE DETAILS'}
              </div>
            </div>
            <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 8, lineHeight: 1.5 }}>
              These are the details Num quotes to travellers. Changing the phone here does not change what verified you —
              that stays tied to the number we already reached you on.
            </div>
          </div>
        ))}

        {!!data?.events?.length && (
          <div style={{ marginTop: 18 }}>
            <div style={{ ...label, color: 'var(--ink-60)' }}>YOUR EVENTS</div>
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
            <div style={{ ...label, color: 'var(--ink-60)' }}>PEOPLE ASKED FOR YOU</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 4, lineHeight: 1.5 }}>
              Requests Num could not complete — demand, not bookings.
            </div>
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
