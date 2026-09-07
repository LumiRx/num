// The table request — the one screen where Num stops advising and commits.
//
// Everything on this sheet exists to serve one rule: **a real restaurant is
// about to be texted on this person's behalf, so this person taps the button.**
// Num can propose the venue, the party and the hour; it cannot decide to put a
// stranger's phone number and a guest's name into a message. That is the same
// line ErrandSheet draws around money and InviteSheet draws around who an
// invite goes to, and it is drawn here for a stronger reason: an errand can be
// cancelled and an invite can be ignored, but a table held under somebody's
// name is a promise made to a third party who is not in this app.
//
// So the facts sit above the button in full — venue, party, day, time, and the
// note the venue will read — and the button says what it does. After the tap
// the sheet does not close: it becomes the waiting room, because "asked" and
// "confirmed" are different things and the moment we blur them is the moment
// somebody turns up to a table that was never held.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, XIcon } from '../../lib/icons';
import { draftLine, loadMyRequests, requestTable, startBookSync, stateLine } from '../../lib/bookdesk';
import { calendarUrl } from '../../lib/calendar';

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

export default function BookSheet() {
  const draft = useApp((s) => s.bookDraft);
  const requests = useApp((s) => s.bookRequests);
  const me = useApp((s) => s.me);
  const open = !!draft;
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  // The id of the request this sheet sent, so the waiting room follows THAT
  // one and not merely the newest row — a guest who asks two restaurants in a
  // row must see the answer to the one they are looking at.
  const [sentId, setSentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSentId(null);
    setNote(null);
    setErr(null);
    void loadMyRequests();
    return startBookSync();
  }, [open, draft?.venue_name, draft?.at_time]);

  if (!draft) return null;
  const close = () => store.set({ bookDraft: null });

  const sent = sentId ? requests.find((r) => r.id === sentId) ?? null : null;
  const answered = sent && sent.state !== 'requested';

  const send = async () => {
    setBusy(true);
    setErr(null);
    const out = await requestTable(draft);
    setBusy(false);
    if (!out.ok) { setErr(out.message); return; }
    setSentId(out.id ?? null);
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
        <div style={label}>{!sentId ? 'ASK THE VENUE' : answered ? 'THE VENUE ANSWERED' : 'WAITING ON THE VENUE'}</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>
          {draft.venue_name}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>
          {draftLine(draft)}
        </div>

        {/* The request in full, before it is sent. Nothing here is a summary —
            it is the message the restaurant is about to get. */}
        <div style={{ marginTop: 14, padding: '2px 12px 6px', borderRadius: 'var(--r-md)', background: 'var(--field-bg)', border: '1px solid var(--ink-08)' }}>
          <Fact k="Venue" v={draft.venue_name} />
          <Fact k="Party" v={`${draft.party_size} ${draft.party_size === 1 ? 'person' : 'people'}`} />
          <Fact k="When" v={`${draft.on_date ?? 'Tonight'}${draft.at_time ? ` · ${draft.at_time}` : ''}`} />
          {draft.note && <Fact k="Note" v={draft.note} />}
          <Fact
            k="Reaching them"
            v={draft.venue_phone ? `by text · ${draft.venue_phone}` : 'by our desk — no number on file'}
            last
          />
        </div>

        {!sentId ? (
          <>
            {!me ? (
              <>
                <div style={{ ...help, marginTop: 14, color: 'var(--ink-60)' }}>
                  Tell me your name first — a restaurant holding a table needs to know whose it is.
                </div>
                <div {...pressable(() => store.set({ bookDraft: null, inviteOpen: {} }))} style={{ ...button, marginTop: 12 }}>
                  INTRODUCE YOURSELF
                </div>
              </>
            ) : (
              <>
                <div {...pressable(send)} aria-disabled={busy} style={{ ...button, marginTop: 14, opacity: busy ? 0.55 : 1 }}>
                  {busy ? 'ASKING…' : `SEND THE REQUEST TO ${draft.venue_name.toUpperCase()}`}
                </div>
                <div {...pressable(close)} style={{ ...ghost, marginTop: 8 }}>NOT YET</div>
                <div style={{ ...help, marginTop: 12 }}>
                  {draft.venue_phone
                    ? 'They get one text with your party size and time, and two links — confirm or decline. Nothing is held until they tap one.'
                    : 'We have no number on file for this one, so our desk rings them and answers here. Nothing is held until they do.'}
                </div>
              </>
            )}
            {err && <div style={{ fontSize: 11.5, color: 'var(--color-accent)', marginTop: 10 }}>{err}</div>}
          </>
        ) : (
          <div style={{ marginTop: 14 }}>
            {/* Pending, and honest about it. The word "confirmed" appears on
                this screen only when the server says so. */}
            <div
              style={{
                display: 'flex', gap: 8, alignItems: 'center', borderRadius: 12, padding: '11px 13px',
                background: sent?.state === 'confirmed' ? 'rgba(22,140,90,.12)' : 'var(--field-bg)',
                border: '1px solid var(--ink-08)',
              }}
            >
              {sent?.state === 'confirmed' ? <CheckIcon size={14} /> : <Dots />}
              <div style={{ fontSize: 12.5, fontWeight: 600, color: sent?.state === 'confirmed' ? '#0e6b45' : 'var(--ink)' }}>
                {sent ? stateLine(sent) : 'Asked — waiting on the venue'}
              </div>
            </div>

            <div style={{ ...help, marginTop: 12 }}>
              {sent?.state === 'confirmed'
                ? 'It’s in your plan, and your phone has it. Turn up and say the name.'
                : sent?.state === 'declined'
                  ? 'Not this time. Ask me and I’ll find you somewhere just as good for the same hour.'
                  : note ?? 'You can close this — your phone buzzes the moment they answer.'}
            </div>

            {/* The one thing a confirmed table should end with: a place in
                the diary they actually look at. Server-built .ics, in the
                venue's own clock time. */}
            {sent?.state === 'confirmed' && me?.id && (
              <a
                href={calendarUrl('booking', sent.id, me.id)}
                className="glass press"
                style={{ ...ghost, marginTop: 14, textDecoration: 'none', display: 'flex', justifyContent: 'center' }}
              >
                ADD TO MY CALENDAR
              </a>
            )}
            <div {...pressable(close)} style={{ ...(answered ? button : ghost), marginTop: sent?.state === 'confirmed' ? 8 : 14 }}>
              {answered ? 'DONE' : 'CLOSE — I’LL TELL YOU'}
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
