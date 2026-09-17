// Search and Suggest — "what should we do?", answered for a group.
//
// Two tabs, one sheet, for the reason ErrandSheet gives about its two
// audiences: the person who knows what they want and the person who doesn't
// are the same person on different evenings.
//
//   SEARCH  one box, plain words; results from four sources, each labelled.
//   SUGGEST a mood or "Surprise me"; three cards none of the crew has tried,
//           with the reason. 👎 trains memory, Save goes to the plan, Send
//           opens the picker.
//
// Nothing here books. A card's button says Ask NUM or Tickets, never Book,
// because the sheet cannot make a booking and must not look as if it can.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable, useDialogFocus } from '../../lib/a11y';
import { sheetBase, grabberStyle } from '../../lib/derive';
import { askNum } from '../../lib/concierge';
import { CheckIcon, SparklesIcon, XIcon } from '../../lib/icons';
import { t } from '../../lib/i18n';
import {
  MOODS, addToPlan, closeDiscover, discover, dislike, priceLine, sendItem,
  type DiscoverItem, type DiscoverResult, type Mood,
} from '../../lib/discover';

const kicker: React.CSSProperties = { fontSize: 9.5, letterSpacing: '.14em', color: 'var(--ink-40)', fontWeight: 700 };
const field: React.CSSProperties = {
  width: '100%', height: 46, borderRadius: 14, border: '1px solid var(--ink-12)', padding: '0 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const pill = (on: boolean): React.CSSProperties => ({
  cursor: 'pointer', borderRadius: 999, padding: '7px 13px', fontSize: 11, fontWeight: 700, letterSpacing: '.04em',
  border: '1px solid var(--ink-12)', background: on ? 'var(--grad-accent)' : 'transparent', color: on ? '#fff' : 'var(--ink-60)',
  flex: 'none', whiteSpace: 'nowrap',
});
const small: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 10, padding: '8px 6px', fontSize: 11, fontWeight: 700, textAlign: 'center',
  border: '1px solid var(--ink-12)', color: 'var(--color-text)', background: 'var(--field-bg)',
};

const LABEL_COLOR: Record<DiscoverItem['source'], string> = {
  num: 'var(--color-accent)', ticketmaster: '#2A63C8', viator: '#8A5CF5', crew: '#E9A23B',
};

export default function DiscoverSheet() {
  const open = useApp((s) => s.discoverOpen);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(!!open, ref);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (open) setMsg(null); }, [open]);
  if (!open) return null;

  return (
    <div ref={ref} role="dialog" aria-modal="true" className="glass-strong sheet-in" style={{ ...sheetBase, visibility: 'visible', transform: 'translateY(0)', maxHeight: 'min(92%, calc(100% - var(--safe-top, 0px)))', overflowY: 'auto' }}>
      <div style={grabberStyle} />
      <div {...pressable(closeDiscover)} aria-label={t('Close')} className="glass press tap" style={{ position: 'absolute', top: 4, right: 4, width: 44, height: 44, borderRadius: 999, cursor: 'pointer', zIndex: 2 }}>
        <XIcon size={15} />
      </div>

      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: '.14em', color: 'var(--color-accent)', fontWeight: 700 }}>
          {open === 'search' ? 'SEARCH' : 'SUGGEST'}
        </div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 6 }}>
          {open === 'search' ? 'What are you after?' : 'Three things none of you have tried'}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          {(['search', 'suggest'] as const).map((t) => (
            <div key={t} {...pressable(() => store.set({ discoverOpen: t }))} style={pill(open === t)}>
              {t === 'search' ? 'SEARCH' : 'SUGGEST'}
            </div>
          ))}
        </div>
        {msg && <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 12, lineHeight: 1.5 }}>{msg}</div>}
        {open === 'search' ? <Search onMsg={setMsg} /> : <Suggest onMsg={setMsg} />}
      </div>
    </div>
  );
}

/* ── SEARCH ─────────────────────────────────────────────────────────────── */

function Search({ onMsg }: { onMsg: (m: string | null) => void }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<DiscoverResult | null>(null);
  const planId = useApp((s) => s.planId);

  // Search as they type, but not on every keystroke: the server fans out to
  // three networks per call and a fast typist would fire a dozen.
  useEffect(() => {
    const text = q.trim();
    if (text.length < 3) { setRes(null); return; }
    const t = setTimeout(async () => {
      setBusy(true);
      const r = await discover({ mode: 'search', q: text });
      setRes(r); setBusy(false);
    }, 380);
    return () => clearTimeout(t);
  }, [q]);

  const sources = res?.sources;
  return (
    <div style={{ marginTop: 14 }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={planId ? 'sunset boat · something Ari hasn’t done…' : 'sunset boat · cooking class saturday…'}
        style={field}
        enterKeyHint="search"
        autoFocus
      />
      {sources && (
        <div style={{ ...kicker, marginTop: 10 }}>
          {[['NUM', sources.num], ['TICKETMASTER', sources.ticketmaster], ['VIATOR', sources.viator], ['YOUR CREW', sources.crew]]
            .filter(([, n]) => Number(n) > 0).map(([k, n]) => `${n} ${k}`).join(' · ') || 'NOTHING YET'}
        </div>
      )}
      <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
        {busy && !res && <div style={{ fontSize: 12, color: 'var(--ink-40)' }}>{t('Looking…')}</div>}
        {res && res.items.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--ink-40)', lineHeight: 1.6, padding: '6px 2px' }}>
            {res.error === 'no_place'
              ? <span>{t('Tell NUM where you are first.')}{' '}<span {...pressable(() => store.set({ discoverOpen: null, placeOpen: true }))} style={{ color: 'var(--color-accent)', fontWeight: 700, cursor: 'pointer' }}>{t('Where am I?')}</span></span>
              : res.error ? 'Couldn’t search just now.' : (res.note ?? 'Nothing for that here. Ask NUM in the thread and it will look wider.')}
          </div>
        )}
        {res?.items.map((i) => <Row key={i.id} i={i} onMsg={onMsg} />)}
      </div>
    </div>
  );
}

function Row({ i, onMsg }: { i: DiscoverItem; onMsg: (m: string | null) => void }) {
  const planId = useApp((s) => s.planId);
  const price = priceLine(i);
  return (
    <div className="glass" style={{ borderRadius: 14, padding: 10, display: 'grid', gridTemplateColumns: i.image ? '48px 1fr' : '1fr', gap: 10 }}>
      {i.image && <div style={{ width: 48, height: 48, borderRadius: 10, backgroundImage: `url(${i.image})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 9.5, letterSpacing: '.1em', fontWeight: 700, color: LABEL_COLOR[i.source] }}>{i.label.toUpperCase()}</div>
        <div style={{ fontWeight: 700, fontSize: 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 2, lineHeight: 1.4 }}>
          {[i.sub, i.rating != null ? `${i.rating}${i.reviews ? ` (${i.reviews.toLocaleString()})` : ''}` : null, price ? `from ${price}` : null, i.distance_km != null ? `${i.distance_km} km` : null].filter(Boolean).join(' · ')}
        </div>
        {!i.novelty.never_tried && <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 2 }}>{i.reason}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 8 }}>
          <Primary i={i} />
          <div {...pressable(() => sendItem(i))} style={small}>{t('Send')}</div>
          <div
            {...pressable(async () => {
              if (!planId) { sendItem(i); return; }
              onMsg((await addToPlan(i)) ? `Added “${i.title}” to the plan.` : 'Couldn’t add that just now.');
            })}
            style={small}
          >
            {planId ? 'Add to plan' : 'Save'}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The one button that moves towards a booking, honestly labelled. */
function Primary({ i }: { i: DiscoverItem }) {
  const style: React.CSSProperties = { ...small, background: 'var(--grad-accent)', color: '#fff', border: 0 };
  if (i.source === 'ticketmaster' && i.url) return <a href={i.url} target="_blank" rel="noopener noreferrer" style={{ ...style, textDecoration: 'none', display: 'block' }}>{t('Tickets')}</a>;
  if (i.source === 'viator' && i.url) return <a href={i.url} target="_blank" rel="noopener noreferrer" style={{ ...style, textDecoration: 'none', display: 'block' }}>{t('See tour')}</a>;
  return (
    <div {...pressable(() => { closeDiscover(); void askNum(`Tell me about ${i.title} and book it if you can.`); })} style={style}>{t('Ask NUM')}</div>
  );
}

/* ── SUGGEST ────────────────────────────────────────────────────────────── */

function Suggest({ onMsg }: { onMsg: (m: string | null) => void }) {
  const [mood, setMood] = useState<Mood | null>(null);
  const [busy, setBusy] = useState(false);
  const [deck, setDeck] = useState<DiscoverItem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const planId = useApp((s) => s.planId);
  const members = useApp((s) => s.planMembers);

  const deal = async (m: Mood | null) => {
    setBusy(true); onMsg(null);
    const r = await discover({ mode: 'surprise', mood: m });
    setDeck(r.items); setNote(r.error === 'no_place' ? 'no_place' : r.error ? 'Couldn’t reach the shelf just now.' : r.note); setBusy(false);
  };
  useEffect(() => { void deal(null); /* first open deals a hand */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drop = (id: string) => setDeck((d) => d.filter((x) => x.id !== id));
  const names = members.filter((m) => m.member_id !== store.get().me?.id).map((m) => m.name).filter(Boolean);

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--ink-60)', lineHeight: 1.5 }}>
        {planId && names.length
          ? `Checked against what you, ${names.slice(0, 2).join(' and ')} have already done.`
          : 'Checked against what you have already done. Open a plan and it checks the whole crew.'}
      </div>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 6, marginTop: 12, overflowX: 'auto' }}>
        {MOODS.map((m) => (
          <div key={m.id} {...pressable(() => { const next = mood === m.id ? null : m.id; setMood(next); void deal(next); })} style={pill(mood === m.id)}>
            <span aria-hidden="true" style={{ marginRight: 5 }}>{m.emoji}</span>{m.label.toUpperCase()}
          </div>
        ))}
      </div>
      <div
        {...pressable(() => { setMood(null); void deal(null); })}
        className="press"
        style={{ cursor: 'pointer', marginTop: 10, borderRadius: 14, padding: '13px 16px', background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}
      >
        <SparklesIcon size={14} />
        {busy ? 'Dealing…' : 'Surprise me'}
      </div>

      <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
        {!busy && deck.length === 0 && note === 'no_place' && (
          <div className="glass" style={{ borderRadius: 14, padding: 12, display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{t('Tell NUM where you are first. One tap, and it deals from there.')}</div>
            <div {...pressable(() => store.set({ discoverOpen: null, placeOpen: true }))} style={{ ...small, background: 'var(--grad-accent)', color: '#fff', border: 0 }}>{t('Where am I?')}</div>
          </div>
        )}
        {!busy && deck.length === 0 && note !== 'no_place' && (
          <div style={{ fontSize: 12, color: 'var(--ink-40)', lineHeight: 1.6, padding: '6px 2px' }}>{note ?? 'Nothing new here yet.'}</div>
        )}
        {deck.map((i) => <SuggestCard key={i.id} i={i} planId={planId} onDone={(m) => { drop(i.id); onMsg(m); }} />)}
      </div>
    </div>
  );
}

function SuggestCard({ i, planId, onDone }: { i: DiscoverItem; planId: string | null; onDone: (m: string | null) => void }) {
  const price = priceLine(i);
  return (
    <div className="glass" style={{ borderRadius: 18, overflow: 'hidden' }}>
      {/* No photo (most directory rows) gets a tinted band so the stamp and
          the source label have somewhere to sit instead of the title. */}
      <div style={{ height: i.image ? 130 : 44, background: i.image ? `url(${i.image}) center/cover` : 'linear-gradient(135deg, var(--color-accent-300, #9fe3cf), var(--field-bg))', position: 'relative' }}>
        {i.novelty.never_tried && (
          <div style={{ position: 'absolute', top: 8, left: 8, background: 'var(--color-accent)', color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: '.06em', padding: '3px 8px', borderRadius: 8 }}>{t('NEVER TRIED')}</div>
        )}
        <div style={{ position: 'absolute', top: 8, right: 8, fontSize: 9.5, fontWeight: 700, background: 'rgba(0,0,0,.45)', color: '#fff', padding: '2px 6px', borderRadius: 6 }}>{i.label}</div>
      </div>
      <div style={{ padding: '10px 12px 0' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15, lineHeight: 1.2 }}>{i.title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4 }}>
          {[i.sub, i.rating != null ? `${i.rating}${i.reviews ? ` from ${i.reviews.toLocaleString()}` : ''}` : null, price ? `from ${price}` : null, i.distance_km != null ? `${i.distance_km} km` : null].filter(Boolean).join(' · ')}
        </div>
        <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.45 }}>{i.reason}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr .9fr 1.3fr', gap: 6, padding: 10 }}>
        <div {...pressable(() => { void dislike(i); onDone(`Noted. I won’t suggest “${i.title}” again.`); })} style={small}>👎 Not me</div>
        <div
          {...pressable(async () => {
            if (!planId) { sendItem(i); onDone(null); return; }
            onDone((await addToPlan(i)) ? `Saved “${i.title}” to the plan.` : 'Couldn’t save that just now.');
          })}
          style={small}
        >
          Save
        </div>
        <div
          {...pressable(async () => {
            if (planId) {
              const ok = await addToPlan(i);
              onDone(ok ? `Sent to the crew. It lands in the plan as an idea they can vote on.` : 'Couldn’t send that just now.');
            } else { sendItem(i); onDone(null); }
          })}
          style={{ ...small, background: 'var(--grad-accent)', color: '#fff', border: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
        >
          <CheckIcon size={12} />{' '}{t('Send to crew')}</div>
      </div>
    </div>
  );
}
