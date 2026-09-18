// An event, opened inside NUM.
//
// FIRST GLANCE, THEN MORE. What arrives on the first screen is what somebody
// standing on a street decides with: the poster, the name, when it starts,
// where it is, how far, what it costs. Everything else — NUM's reason, the
// full date, who is selling — is one tap down, because a wall of small print
// above the button is how people end up not reading either.
//
// NOTHING IS FETCHED HERE. The listing is already in memory from the rail
// that was tapped, so the sheet opens instantly and works offline once the
// rail has loaded. The day an event needs more than the listing holds, it
// gets its own request and its own spinner — not before.
//
// WHAT IT PROMISES. The price line, the ticket button and the seller note all
// come from lib/eventview.ts, which is where the rules about them are written
// and tested: no invented number, and never "booked" for a ticket NUM cannot
// sell.
import { useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { XIcon } from '../../lib/icons';
import { askNum } from '../../lib/concierge';
import { openShareCard } from '../../lib/sharecard';
import { t } from '../../lib/i18n';
import {
  closeEventCard, costOf, factsOf, getInAsk, keepEvent, planAsk, sellerNote, shareOf, ticketLabel,
} from '../../lib/eventview';

const primary: React.CSSProperties = {
  background: 'var(--grad-accent)', color: '#fff', borderRadius: 999, padding: '13px 0', textAlign: 'center',
  fontWeight: 800, fontSize: 12.5, letterSpacing: '.06em', cursor: 'pointer',
};
const secondary: React.CSSProperties = {
  borderRadius: 999, padding: '12px 0', textAlign: 'center', fontWeight: 700, fontSize: 12,
  letterSpacing: '.04em', cursor: 'pointer', border: '1px solid var(--ink-12)',
};

export default function EventDetailSheet() {
  const e = useApp((s) => s.eventView);
  const planId = useApp((s) => s.planId);
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const [kept, setKept] = useState<string | null>(null);
  useDialogFocus(!!e, ref);
  if (!e) return null;

  const facts = factsOf(e);
  const cost = costOf(e);
  const tickets = ticketLabel(e);
  const seller = sellerNote(e);

  const ask = (line: string) => {
    closeEventCard();
    store.set({ threadOpen: true, unread: 0 });
    void askNum(line);
  };
  const keep = async () => {
    const ok = await keepEvent(e);
    setKept(ok ? t('In the plan.') : t('Open a plan first — then it can go in.'));
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={e.title}
      className="glass-strong sheet-in"
      style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(94%, calc(100% - var(--safe-top, 0px)))', overflowY: 'auto' }}
    >
      <div style={grabberStyle} />
      <div {...pressable(closeEventCard)} aria-label={t('Close')} className="glass press tap" style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, borderRadius: 999, cursor: 'pointer', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <XIcon size={15} />
      </div>

      {/* THE POSTER. A picture is most of why somebody stops on an event, so
          it gets the top of the sheet — and when the feed has none, the space
          is not filled with a grey box pretending to be one: the title simply
          starts higher up. */}
      {e.image && (
        <div style={{ position: 'relative', height: 188, overflow: 'hidden' }}>
          <img src={e.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,.05) 0%, rgba(0,0,0,.30) 55%, rgba(0,0,0,.82) 100%)' }} />
          <div style={{ position: 'absolute', left: 16, right: 56, bottom: 13, color: '#fff' }}>
            <div style={{ fontSize: 9.5, letterSpacing: '.14em', fontWeight: 800, opacity: 0.85 }}>{t(e.label)}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, lineHeight: 1.12, marginTop: 4, letterSpacing: '-.01em' }}>{e.title}</div>
          </div>
        </div>
      )}

      <div style={{ padding: 16, display: 'grid', gap: 13 }}>
        {!e.image && (
          <div>
            <div style={{ fontSize: 9.5, letterSpacing: '.14em', fontWeight: 800, color: 'var(--color-accent)' }}>{t(e.label)}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, lineHeight: 1.12, marginTop: 5, letterSpacing: '-.01em' }}>{e.title}</div>
          </div>
        )}

        {/* THE FACTS, UNDER THE PICTURE, IN PLAIN TEXT. Written over a busy
            poster they were unreadable — the same lesson the rails learned on
            18 Sep. Each one is here only if the listing carries it. */}
        {!!facts.length && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', fontSize: 12.5, color: 'var(--ink-60)', lineHeight: 1.5 }}>
            {facts.map((f, i) => (
              <span key={f}>
                {i > 0 && <span style={{ color: 'var(--ink-40)', marginRight: 8 }}>·</span>}
                <span style={{ color: i === 0 ? 'var(--color-accent)' : undefined, fontWeight: i === 0 ? 700 : 500 }}>{f}</span>
              </span>
            ))}
          </div>
        )}

        {cost && <div style={{ fontSize: 13, fontWeight: 700 }}>{t(cost)}</div>}

        {/* ONE BUTTON THAT MATTERS. Leaving NUM is deliberate and labelled
            with whose page opens; an event with no ticket page asks NUM
            instead of dead-ending. */}
        {tickets ? (
          <a href={e.url ?? undefined} target="_blank" rel="noopener noreferrer" style={{ ...primary, display: 'block', textDecoration: 'none' }}>{t(tickets)}</a>
        ) : (
          <div {...pressable(() => ask(getInAsk(e)))} className="press" style={primary}>{t('ASK NUM HOW TO GET IN')}</div>
        )}

        <div {...pressable(() => ask(planAsk(e)))} className="press" style={secondary}>{t('PLAN THE EVENING AROUND IT')}</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div {...pressable(() => void keep())} className="press" style={secondary}>{t('KEEP IT')}</div>
          <div {...pressable(() => openShareCard(shareOf(e)))} className="press" style={secondary}>{t('SEND TO A FRIEND')}</div>
        </div>
        {kept && <div style={{ fontSize: 11.5, color: 'var(--color-accent-700)', fontWeight: 600 }}>{kept}</div>}
        {!planId && !kept && <div style={{ fontSize: 11, color: 'var(--color-neutral-500)' }}>{t('“Keep it” puts it in an open plan.')}</div>}

        {/* MORE — folded away until asked for. */}
        {(e.why || seller || e.starts_on) && (
          <div>
            <div {...pressable(() => setMore((v) => !v))} className="tap" style={{ fontSize: 10.5, letterSpacing: '.12em', fontWeight: 800, color: 'var(--color-accent)', cursor: 'pointer', padding: '2px 0' }}>
              {more ? t('LESS') : t('MORE ABOUT THIS')}
            </div>
            {more && (
              <div style={{ marginTop: 10, display: 'grid', gap: 9, fontSize: 12, color: 'var(--ink-60)', lineHeight: 1.55 }}>
                {e.why && <div>{e.why}</div>}
                {e.starts_on && <div>{t('Date')}: {e.starts_on}</div>}
                {seller && <div style={{ color: 'var(--color-neutral-500)', fontSize: 11 }}>{t(seller)}</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
