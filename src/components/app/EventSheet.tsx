// Events — host one, invite by text, watch the RSVPs land.
//
// The guest never installs anything: they get one text with one link, and that
// link is a real page with two buttons. This sheet is the host's side of it —
// the dashboard an event site would charge you for, including the thing hosts
// actually need, which is chasing the people who opened it and went quiet.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { CheckIcon, CopyIcon, ShareIcon, XIcon } from '../../lib/icons';
import { createEvent, eventDashboard, inviteGuests, listEvents, chaseText } from '../../lib/events';
import type { EventDashboard, GuestInvite } from '../../lib/events';
import { shareNative } from '../../lib/services';

const label: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 };
const field: React.CSSProperties = {
  width: '100%', height: 44, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '12px 16px', display: 'flex', gap: 7, alignItems: 'center',
  justifyContent: 'center', boxShadow: '0 4px 14px rgba(236,48,19,.3)',
};
const ghost: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, padding: '11px 14px', fontSize: 11.5, fontWeight: 700,
  letterSpacing: '.06em', textAlign: 'center', textDecoration: 'none', color: 'var(--ink)',
};

const RSVP_STYLE: Record<string, { bg: string; fg: string; text: string }> = {
  yes: { bg: 'rgba(22,140,90,.14)', fg: '#0e6b45', text: 'COMING' },
  no: { bg: 'rgba(32,30,29,.07)', fg: 'var(--ink-60)', text: 'CAN’T' },
  maybe: { bg: 'rgba(236,48,19,.12)', fg: 'var(--color-accent-700)', text: 'MAYBE' },
  pending: { bg: 'rgba(32,30,29,.05)', fg: 'var(--ink-40)', text: 'NO REPLY' },
};

export default function EventSheet() {
  const open = useApp((s) => s.eventOpen);
  const me = useApp((s) => s.me);
  const events = useApp((s) => s.events);
  const eventId = useApp((s) => s.eventId);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(open, ref);

  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [place, setPlace] = useState('');
  const [dress, setDress] = useState('');
  const [guest, setGuest] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [dash, setDash] = useState<EventDashboard | null>(null);
  const [minted, setMinted] = useState<GuestInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // The dashboard is server truth — RSVPs arrive from other people's phones,
  // so local state can never be the source.
  useEffect(() => {
    if (!open || !eventId) return setDash(null);
    let live = true;
    const load = () => void eventDashboard(eventId).then((d) => live && setDash(d));
    load();
    const t = setInterval(load, 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [open, eventId]);

  if (!open) return null;
  const close = () => store.set({ eventOpen: false });

  const doCreate = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await createEvent({ title: title.trim(), day: day || null, time: time || null, place: place || null, dress: dress || null });
      setTitle('');
      setDay('');
      setTime('');
      setPlace('');
      setDress('');
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Couldn’t create that.');
    } finally {
      setBusy(false);
    }
  };

  const doInvite = async () => {
    if (!eventId || (!guest.trim() && !guestPhone.trim())) return;
    setBusy(true);
    try {
      const [inv] = await inviteGuests(eventId, [{ name: guest.trim(), phone: guestPhone.trim() }]);
      setMinted(inv ?? null);
      setGuest('');
      setGuestPhone('');
      void eventDashboard(eventId).then(setDash);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Couldn’t create that invite.');
    } finally {
      setBusy(false);
    }
  };

  const chase = dash ? chaseText(dash.event, dash.guests, dash.url) : null;

  return (
    <div
      ref={ref}
      className="glass-strong"
      style={{ ...sheetBase, visibility: open ? 'visible' : 'hidden', transform: open ? 'translateY(0)' : 'translateY(105%)', maxHeight: '88%', overflowY: 'auto' }}
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

      {!me ? (
        <div style={{ padding: 16 }}>
          <div style={label}>EVENTS</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>Host something</div>
          <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 6, lineHeight: 1.55 }}>
            Your guests RSVP from one text — no app, no account on their side. You just need your own name and number first.
          </div>
          <div {...pressable(() => store.set({ eventOpen: false, inviteOpen: {} }))} style={{ ...primary, marginTop: 14 }}>
            INTRODUCE YOURSELF
          </div>
        </div>
      ) : !eventId ? (
        <div style={{ padding: 16 }}>
          <div style={label}>NEW EVENT</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>What are you hosting?</div>
          <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', marginTop: 6, lineHeight: 1.55 }}>
            Only the name is required — you can fill the rest in once the venue is settled. Guests get one link that answers where, when and what to wear.
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            <input style={field} placeholder="e.g. Dre’s 30th" value={title} onChange={(e) => setTitle(e.target.value)} />
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...field, flex: 1 }} type="date" value={day} onChange={(e) => setDay(e.target.value)} />
              <input style={{ ...field, width: 120 }} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <input style={field} placeholder="Venue" value={place} onChange={(e) => setPlace(e.target.value)} />
            <input style={field} placeholder="Dress code (optional)" value={dress} onChange={(e) => setDress(e.target.value)} />
            <div {...pressable(doCreate)} style={{ ...primary, opacity: busy || !title.trim() ? 0.6 : 1 }}>
              {busy ? 'ONE SEC…' : 'CREATE THE EVENT'}
            </div>
          </div>
          {note && <div style={{ fontSize: 10.5, color: 'var(--color-accent-700)', marginTop: 10 }}>{note}</div>}
          {!!events.length && (
            <div style={{ marginTop: 18 }}>
              <div style={{ ...label, color: 'var(--ink-60)' }}>YOUR EVENTS</div>
              {events.map((e) => (
                <div
                  key={e.id}
                  {...pressable(() => store.set({ eventId: e.id }))}
                  className="glass lift"
                  style={{ cursor: 'pointer', marginTop: 8, padding: '11px 13px', borderRadius: 'var(--r-md)' }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{e.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-neutral-600)' }}>
                    {e.yes ?? 0} coming of {e.invited ?? 0} invited{e.day ? ` · ${e.day}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ padding: 16, borderBottom: '1px solid var(--ink-08)' }}>
            <div style={label}>EVENT DASHBOARD</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>{dash?.event.title ?? 'Loading…'}</div>
            {dash && (
              <>
                <div style={{ fontSize: 11.5, color: 'var(--color-neutral-600)', marginTop: 3 }}>
                  {[dash.event.day, dash.event.time, dash.event.place].filter(Boolean).join(' · ') || 'Details still to come'}
                </div>
                {/* The four numbers a host checks obsessively. */}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  {([['heads', 'COMING'], ['maybe', 'MAYBE'], ['no', 'CAN’T'], ['pending', 'SILENT']] as const).map(([k, l]) => (
                    <div key={k} className="glass" style={{ flex: 1, borderRadius: 'var(--r-md)', padding: '9px 6px', textAlign: 'center' }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18 }}>{dash.summary[k]}</div>
                      <div style={{ fontSize: 9, letterSpacing: '.1em', color: 'var(--ink-60)', fontWeight: 700 }}>{l}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <div
                    {...pressable(() => void shareNative({ title: dash.event.title, text: `${dash.event.title} — details and RSVP:`, url: dash.url }))}
                    style={{ ...primary, flex: 1 }}
                  >
                    <ShareIcon size={14} /> SHARE THE PAGE
                  </div>
                  <div
                    {...pressable(() => { store.set({ eventId: null }); void listEvents(); })}
                    className="glass press"
                    style={ghost}
                  >
                    ALL EVENTS
                  </div>
                </div>
                {!!chase?.count && (
                  <a href={chase.sms} className="glass press" style={{ ...ghost, display: 'block', marginTop: 8 }}>
                    NUDGE THE {chase.count} WHO HAVEN’T REPLIED
                  </a>
                )}
              </>
            )}
          </div>

          {/* invite one more */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ink-08)' }}>
            <div style={{ ...label, color: 'var(--ink-60)' }}>INVITE SOMEONE</div>
            {!minted ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                <input style={field} placeholder="Their name" value={guest} onChange={(e) => setGuest(e.target.value)} />
                <input style={field} placeholder="Their mobile (optional)" inputMode="tel" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} />
                <div {...pressable(doInvite)} style={{ ...primary, opacity: busy ? 0.6 : 1 }}>
                  {busy ? 'ONE SEC…' : 'CREATE THEIR INVITE'}
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 8 }}>
                <div style={{ padding: 11, borderRadius: 'var(--r-md)', background: 'var(--field-bg)', border: '1px solid var(--ink-08)', fontSize: 12, lineHeight: 1.5 }}>
                  {minted.message}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <div {...pressable(() => void shareNative(minted.share))} style={{ ...primary, flex: 1 }}>
                    <ShareIcon size={14} /> SEND IT
                  </div>
                  <a href={minted.sms_url} className="glass press" style={ghost}>TEXT</a>
                  <a href={minted.whatsapp_url} target="_blank" rel="noreferrer" className="glass press" style={ghost}>WA</a>
                  <div
                    {...pressable(() => void navigator.clipboard?.writeText(minted.url))}
                    className="glass press"
                    style={{ ...ghost, padding: '11px 13px', display: 'flex', alignItems: 'center' }}
                    aria-label="Copy link"
                  >
                    <CopyIcon size={14} />
                  </div>
                </div>
                <div
                  {...pressable(() => setMinted(null))}
                  style={{ marginTop: 12, fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'var(--color-accent-700)', cursor: 'pointer' }}
                >
                  INVITE ANOTHER
                </div>
              </div>
            )}
          </div>

          {/* the list */}
          <div style={{ padding: '12px 16px' }}>
            {dash?.guests.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', lineHeight: 1.55 }}>
                Nobody invited yet. Add the first name above — they’ll get a text with a link that answers everything and takes one tap to RSVP.
              </div>
            )}
            {dash?.guests.map((g) => {
              const st = RSVP_STYLE[g.rsvp] ?? RSVP_STYLE.pending;
              return (
                <div key={g.token} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--ink-08)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {g.name || 'Guest'}
                      {g.plus_ones > 0 && <span style={{ color: 'var(--ink-60)', fontWeight: 500 }}> +{g.plus_ones}</span>}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--ink-60)' }}>
                      {g.phone ?? 'no number'}
                      {g.rsvp === 'pending' && g.opened_at ? ' · opened it, no answer' : ''}
                      {g.message ? ` · “${g.message}”` : ''}
                    </div>
                  </div>
                  <span style={{ flex: 'none', fontSize: 9, fontWeight: 800, letterSpacing: '.1em', padding: '4px 8px', borderRadius: 999, background: st.bg, color: st.fg, display: 'flex', gap: 4, alignItems: 'center' }}>
                    {g.rsvp === 'yes' && <CheckIcon size={10} />}
                    {st.text}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
