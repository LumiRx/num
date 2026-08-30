// Passenger details — the form that makes a flight bookable.
//
// WHY THIS SCREEN IS BLUNT ABOUT WHAT IT IS ASKING
//
// Every other form in Num asks for a preference. This one asks for the name on
// a passport, a date of birth and the gender marker on a travel document, and
// pretending otherwise would be the wrong kind of polish. An airline will not
// issue a ticket without them and will not accept a nickname: "Dre" boards
// nothing. So the copy says that in the first sentence, says who it goes to,
// says what Num does not do with it, and puts the delete next to the save
// rather than three screens away.
//
// The rules encoded here are Duffel's, transcribed rather than invented —
// https://duffel.com/docs/api/orders/create-order. Everything is re-checked on
// the server (worker/passengers.mjs); this side exists so a person finds out
// before they tap, not after.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { normalisePhone } from '../../lib/phone';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, ChevronRightIcon, XIcon } from '../../lib/icons';
import { GENDERS, TITLES, listPassengers, removePassenger, savePassenger } from '../../lib/passengers';
import type { Passenger, PassengerDraft } from '../../lib/passengers';

const field: React.CSSProperties = {
  width: '100%', height: 44, borderRadius: 12, border: '1px solid var(--ink-12)',
  padding: '0 14px', fontSize: 16, background: 'var(--field-bg)', outline: 'none',
  fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff',
  fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '13px 16px',
  display: 'flex', gap: 7, alignItems: 'center', justifyContent: 'center',
  boxShadow: '0 4px 14px rgba(236,48,19,.3)',
};
const label: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 };
const legend: React.CSSProperties = { fontSize: 10, letterSpacing: '.1em', fontWeight: 700, color: 'var(--ink-40)', marginBottom: 5 };
const helpText: React.CSSProperties = { fontSize: 10.5, color: 'var(--color-neutral-500)', lineHeight: 1.55, marginTop: 6 };

const EMPTY: PassengerDraft = {
  title: '', given_name: '', family_name: '', born_on: '', gender: '',
  email: '', phone_number: '', label: '', is_self: true,
};

const TITLE_LABEL: Record<string, string> = { mr: 'Mr', ms: 'Ms', mrs: 'Mrs', miss: 'Miss', dr: 'Dr' };

function Segmented({ options, value, onPick, name }: {
  options: Array<[string, string]>;
  value: string;
  onPick: (v: string) => void;
  name: string;
}) {
  return (
    <div role="radiogroup" aria-label={name} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map(([v, text]) => (
        <div
          key={v}
          {...pressable(() => onPick(v))}
          role="radio"
          aria-checked={value === v}
          style={{
            cursor: 'pointer', borderRadius: 999, padding: '9px 14px', fontSize: 12.5, fontWeight: 600,
            border: `1px solid ${value === v ? 'transparent' : 'var(--ink-12)'}`,
            background: value === v ? 'var(--grad-accent)' : 'var(--field-bg)',
            color: value === v ? '#fff' : 'var(--color-text)',
          }}
        >
          {text}
        </div>
      ))}
    </div>
  );
}

export default function PassengerSheet() {
  const open = useApp((s) => s.passengerOpen);
  const me = useApp((s) => s.me);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  // Deliberately component state, not the store. Nothing here is persisted to
  // localStorage and nothing reaches the concierge prompt — see src/lib/passengers.ts.
  const [saved, setSaved] = useState<Passenger[]>([]);
  const [draft, setDraft] = useState<PassengerDraft>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSaved([]);
      setDraft(EMPTY);
      setEditing(false);
      setError(null);
      return;
    }
    let live = true;
    listPassengers(me)
      .then((rows) => { if (live) setSaved(rows); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [open, me?.id]);

  if (!open) return null;
  const close = () => store.set({ passengerOpen: false });
  const set = (patch: PassengerDraft) => setDraft((d) => ({ ...d, ...patch }));

  const phone = draft.phone_number ? normalisePhone(draft.phone_number) : null;
  const ready = !!(draft.title && draft.given_name && draft.family_name && draft.born_on
    && draft.gender && draft.email && phone);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await savePassenger(me, { ...draft, phone_number: phone ?? draft.phone_number });
      setSaved((rows) => [...rows.filter((r) => r.id !== out.id), out]);
      setDraft(EMPTY);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await removePassenger(me, id);
      setSaved((rows) => rows.filter((r) => r.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const edit = (p: Passenger) => {
    setDraft({
      id: p.id, is_self: p.is_self, label: p.label ?? '', title: p.title,
      given_name: p.given_name, family_name: p.family_name, born_on: p.born_on,
      gender: p.gender, email: p.email, phone_number: p.phone_number,
    });
    setEditing(true);
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Passenger details" className="glass-strong"
      style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(92%, calc(100% - var(--sat, 0px) - 8px))', overflowY: 'auto' }}>
      <div style={grabberStyle} />
      <div {...pressable(close)} aria-label="Close" className="glass press"
        style={{ position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>

      <div style={{ padding: 16 }}>
        <div style={label}>WHO IS FLYING</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, lineHeight: 1.2, marginTop: 8, letterSpacing: '-.01em' }}>
          Exactly as it appears on the passport
        </div>

        {/* The honest paragraph. It is first, and it is not a tooltip. */}
        <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 10, lineHeight: 1.6 }}>
          An airline will not issue a ticket to a nickname. To book a flight, Num has to hand the airline the
          full name printed on your travel document, your date of birth, and the gender marker on that document —
          those are the airline’s security checks, not Num’s idea of you. It goes to the airline through Duffel
          and nowhere else.
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-40)', marginTop: 8, lineHeight: 1.6 }}>
          It is never sent to 5arz, never shared with a business, and never shown to the concierge —
          Num answers your questions without knowing your surname. Remove a passenger any time and it is
          destroyed for good 30 days later.
        </div>

        {saved.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div style={legend}>SAVED</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {saved.map((p) => (
                <div key={p.id} style={{ borderRadius: 'var(--r-lg)', border: '1px solid var(--ink-12)', background: 'var(--field-bg)', padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                      {TITLE_LABEL[p.title] ?? p.title} {p.given_name} {p.family_name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 2 }}>
                      {p.is_self ? 'You' : p.label || 'Travelling with you'} · born {p.born_on}
                    </div>
                  </div>
                  <div {...pressable(() => edit(p))} aria-label={`Edit ${p.given_name}`} className="press"
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'var(--ink-40)' }}>
                    <ChevronRightIcon size={16} />
                  </div>
                  <div {...pressable(() => void remove(p.id))} aria-label={`Remove ${p.given_name}`} className="press"
                    style={{ cursor: 'pointer', fontSize: 10.5, letterSpacing: '.08em', fontWeight: 700, color: 'var(--ink-40)' }}>
                    REMOVE
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 18, display: 'grid', gap: 14 }}>
          <div>
            <div style={legend}>THIS PASSENGER IS</div>
            <Segmented
              name="Who this record is for"
              value={draft.is_self ? 'self' : 'other'}
              onPick={(v) => set({ is_self: v === 'self' })}
              options={[['self', 'Me'], ['other', 'Someone I travel with']]}
            />
            {!draft.is_self && (
              <input
                style={{ ...field, marginTop: 8 }}
                placeholder="What to call this one — “Mum”, “Sam”"
                value={draft.label ?? ''}
                onChange={(e) => set({ label: e.target.value })}
                aria-label="Label"
              />
            )}
          </div>

          <div>
            <div style={legend}>TITLE</div>
            <Segmented
              name="Title"
              value={draft.title ?? ''}
              onPick={(v) => set({ title: v })}
              options={TITLES.map((t) => [t, TITLE_LABEL[t]] as [string, string])}
            />
            {draft.title === 'dr' && (
              <div style={helpText}>Some airlines refuse “Dr” and the booking comes back rejected. If it does, Mr/Ms works.</div>
            )}
          </div>

          <div>
            <div style={legend}>GIVEN NAME</div>
            <input style={field} value={draft.given_name ?? ''} onChange={(e) => set({ given_name: e.target.value })}
              placeholder="As printed" autoComplete="given-name" aria-label="Given name" />
          </div>

          <div>
            <div style={legend}>FAMILY NAME</div>
            <input style={field} value={draft.family_name ?? ''} onChange={(e) => set({ family_name: e.target.value })}
              placeholder="As printed" autoComplete="family-name" aria-label="Family name" />
            <div style={helpText}>
              Letters, spaces, hyphens and apostrophes only, and the two names together fit in 40 characters —
              that is the airline’s limit, not ours.
            </div>
          </div>

          <div>
            <div style={legend}>DATE OF BIRTH</div>
            <input style={field} type="date" value={draft.born_on ?? ''} onChange={(e) => set({ born_on: e.target.value })}
              autoComplete="bday" aria-label="Date of birth" />
            <div style={helpText}>Airlines price by age and check it at the gate. A child under two travels on an adult’s lap and has to be linked to one.</div>
          </div>

          <div>
            <div style={legend}>GENDER ON THE DOCUMENT</div>
            <Segmented
              name="Gender marker on the travel document"
              value={draft.gender ?? ''}
              onPick={(v) => set({ gender: v })}
              options={GENDERS.map((g) => [g, g === 'm' ? 'M' : 'F'] as [string, string])}
            />
            <div style={helpText}>
              The airline systems accept only M or F. Num is copying the marker on your passport so check-in matches —
              it is not a question about you.
            </div>
          </div>

          <div>
            <div style={legend}>EMAIL</div>
            <input style={field} type="email" inputMode="email" value={draft.email ?? ''} onChange={(e) => set({ email: e.target.value })}
              placeholder="you@example.com" autoComplete="email" aria-label="Email" />
            <div style={helpText}>The airline sends the confirmation and any disruption notice here, directly to the passenger.</div>
          </div>

          <div>
            <div style={legend}>PHONE</div>
            <input style={field} type="tel" inputMode="tel" value={draft.phone_number ?? ''} onChange={(e) => set({ phone_number: e.target.value })}
              placeholder="+44 20 8016 0509" autoComplete="tel" aria-label="Phone number" />
            {draft.phone_number && !phone && (
              <div style={{ ...helpText, color: 'var(--color-accent)' }}>That number needs its country code — start it with +.</div>
            )}
          </div>
        </div>

        {error && (
          <div role="alert" style={{ marginTop: 14, fontSize: 12, lineHeight: 1.55, color: 'var(--color-accent)' }}>{error}</div>
        )}

        <div {...pressable(() => { if (ready && !busy) void save(); })}
          aria-disabled={!ready || busy}
          style={{ ...primary, marginTop: 18, opacity: ready && !busy ? 1 : 0.45 }}>
          <CheckIcon size={14} />
          {busy ? 'SAVING…' : editing ? 'UPDATE PASSENGER' : 'SAVE PASSENGER'}
        </div>

        <div style={{ ...helpText, marginTop: 12 }}>
          Nothing is booked by saving this. It sits here until you choose a flight, and Num shows you the
          fare and the name it is about to send before anything is bought.
        </div>
      </div>
    </div>
  );
}
