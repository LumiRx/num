// The travel handoff — where Num stops searching and an agency takes over.
//
// This is BookSheet's sibling and is built the same way on purpose: the facts
// sit above the button in full, the button says what it does, and after the tap
// the sheet becomes the waiting room rather than closing. What differs is the
// sentence, and the sentence is the product:
//
//   **Num presents. The agency issues.**
//
// So this screen never says booked, reserved, held or ticketed. It shows the
// agency's quote in the agency's own currency, exactly as they sent it — no
// conversion, because a converted number is a price Num computed and Num does
// not price travel. And on acceptance it says, in the server's own words, that
// the agency will contact the member to take payment. That sentence is the
// whole reason Num can do this at all without holding passenger money, and
// blurring it would put the money back on Num's side of the line.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, XIcon } from '../../lib/icons';
import {
  acceptQuote, itineraryLine, loadMyReferrals, paxLine, quoteLine, referTravel, startTravelSync,
} from '../../lib/travel';

const button: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center',
};
const ghost: React.CSSProperties = {
  ...button, background: 'transparent', color: 'var(--ink-60)', border: '1px solid var(--ink-12)',
};
const label: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 };
const help: React.CSSProperties = { fontSize: 10.5, color: 'var(--ink-40)', lineHeight: 1.55 };
const row: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0',
  borderBottom: '1px solid var(--ink-08)', fontSize: 12.5,
};

export default function TravelSheet() {
  const draft = useApp((s) => s.travelDraft);
  const referrals = useApp((s) => s.travelReferrals);
  const me = useApp((s) => s.me);
  const open = !!draft;
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  // The reference this sheet sent, so the waiting room follows THAT trip and
  // not merely the newest row.
  const [sentRef, setSentRef] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSentRef(null);
    setNote(null);
    setErr(null);
    void loadMyReferrals();
    return startTravelSync();
  }, [open, draft?.destination, draft?.depart_on]);

  if (!draft) return null;
  const close = () => store.set({ travelDraft: null });

  const live = sentRef ? referrals.find((r) => r.ref === sentRef) ?? null : null;
  const quoted = live?.state === 'quoted';
  const done = live ? ['accepted', 'confirmed', 'declined', 'cancelled', 'expired'].includes(live.state) : false;

  const send = async () => {
    setBusy(true);
    setErr(null);
    const out = await referTravel(draft);
    setBusy(false);
    if (!out.ok) { setErr(out.message); return; }
    setSentRef(out.ref ?? null);
    setNote(out.message);
  };

  const accept = async () => {
    if (!live) return;
    setBusy(true);
    const out = await acceptQuote(live.ref);
    setBusy(false);
    if (!out.ok) { setErr(out.message); return; }
    // The server's sentence, verbatim. See lib/travel.ts.
    setNote(out.message);
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      className="glass-strong"
      style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(88%, calc(100% - var(--sat, 0px) - 8px))', overflowY: 'auto' }}
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
        <div style={label}>
          {!sentRef ? 'HAND THIS TO AN AGENCY' : quoted ? 'THE AGENCY QUOTED' : done ? 'WITH THE AGENCY' : 'WAITING ON THE AGENCY'}
        </div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>
          {draft.destination ?? 'Your trip'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>
          {itineraryLine(draft)}
        </div>

        {/* The request in full, before it goes. This is what a named company is
            about to receive about a named traveller. */}
        <div style={{ marginTop: 14, padding: '2px 12px 6px', borderRadius: 'var(--r-md)', background: 'var(--field-bg)', border: '1px solid var(--ink-08)' }}>
          <Fact k="Trip" v={itineraryLine(draft)} />
          <Fact k="Travelling" v={paxLine(draft)} />
          {draft.cabin && <Fact k="Cabin" v={draft.cabin} />}
          {draft.budget_cs && draft.budget_currency && (
            /* THEIR ceiling, in THEIR currency — a number the member gave, not
               one Num worked out. */
            <Fact k="Your budget" v={`up to ${(draft.budget_cs / 100).toFixed(2)} ${draft.budget_currency}`} />
          )}
          {draft.notes && <Fact k="Notes" v={draft.notes} />}
          <Fact k="They'll reach you on" v={draft.contact_email ?? draft.contact_phone ?? 'this thread'} last />
        </div>

        {!sentRef ? (
          <>
            {!me ? (
              <>
                <div style={{ ...help, marginTop: 14, color: 'var(--ink-60)' }}>
                  Tell me your name first — an agency quoting a trip needs to know whose it is.
                </div>
                <div {...pressable(() => store.set({ travelDraft: null, inviteOpen: {} }))} style={{ ...button, marginTop: 12 }}>
                  INTRODUCE YOURSELF
                </div>
              </>
            ) : (
              <>
                <div {...pressable(send)} aria-disabled={busy} style={{ ...button, marginTop: 14, opacity: busy ? 0.55 : 1 }}>
                  {busy ? 'SENDING…' : 'SEND THIS TO THE AGENCY'}
                </div>
                <div {...pressable(close)} style={{ ...ghost, marginTop: 8 }}>NOT YET</div>
                <div style={{ ...help, marginTop: 12 }}>
                  A travel agency gets this with a Num reference and comes back with options and a price.
                  They quote it, they take the payment and they issue the confirmation — I don’t handle the money.
                </div>
              </>
            )}
            {err && <div style={{ fontSize: 11.5, color: 'var(--color-accent)', marginTop: 10 }}>{err}</div>}
          </>
        ) : (
          <div style={{ marginTop: 14 }}>
            <div
              style={{
                display: 'flex', gap: 8, alignItems: 'center', borderRadius: 12, padding: '11px 13px',
                background: live?.state === 'confirmed' ? 'rgba(22,140,90,.12)' : 'var(--field-bg)',
                border: '1px solid var(--ink-08)',
              }}
            >
              {live?.state === 'confirmed' ? <CheckIcon size={14} /> : <Dots />}
              <div style={{ fontSize: 12.5, fontWeight: 600, color: live?.state === 'confirmed' ? '#0e6b45' : 'var(--ink)' }}>
                {/* The server's own line for the state. Never re-worded here —
                    "confirmed" on this screen means an AGENCY issued something,
                    and only the server knows that. */}
                {live?.state_line ?? 'Sent — waiting on the agency'}
              </div>
            </div>

            <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 8, letterSpacing: '.08em' }}>
              REFERENCE {sentRef}
              {live?.partner_ref ? ` · THEIRS ${live.partner_ref}` : ''}
            </div>

            {/* The agency's quote, in the agency's currency, untouched. */}
            {live && quoteLine(live) && (
              <div style={{ marginTop: 12, padding: '2px 12px 6px', borderRadius: 'var(--r-md)', background: 'var(--field-bg)', border: '1px solid var(--ink-08)' }}>
                <Fact k={`${live.partner_name ?? 'The agency'} quotes`} v={quoteLine(live) as string} />
                {live.quote_note && <Fact k="Includes" v={live.quote_note} last />}
              </div>
            )}

            {quoted && (
              <>
                <div {...pressable(accept)} aria-disabled={busy} style={{ ...button, marginTop: 14, opacity: busy ? 0.55 : 1 }}>
                  {busy ? 'PASSING IT ON…' : 'YES — GO AHEAD'}
                </div>
                <div style={{ ...help, marginTop: 10 }}>
                  Saying yes tells the agency to go ahead. They’ll contact you to take payment and issue the
                  confirmation in their own name — nothing is held until they do that with you directly.
                </div>
              </>
            )}

            <div style={{ ...help, marginTop: 12 }}>
              {note ?? (live?.state === 'sent' ? 'You can close this — I’ll bring their answer straight into the thread.' : '')}
            </div>
            {err && <div style={{ fontSize: 11.5, color: 'var(--color-accent)', marginTop: 10 }}>{err}</div>}

            <div {...pressable(close)} style={{ ...(done ? button : ghost), marginTop: 14 }}>
              {done ? 'DONE' : 'CLOSE — I’LL TELL YOU'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Fact({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div style={{ ...row, ...(last ? { borderBottom: 'none' } : {}) }}>
      <span style={{ color: 'var(--ink-40)' }}>{k}</span>
      <span style={{ fontWeight: 600, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

/** The same three-dot pulse the thread uses while Num is thinking. */
function Dots() {
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 5, height: 5, borderRadius: 999, background: 'var(--color-accent)',
            animation: `vbar .9s ${i * 0.15}s infinite ease-in-out`, transformOrigin: 'center',
          }}
        />
      ))}
    </span>
  );
}
