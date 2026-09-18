/**
 * GIVEAWAYS — what is live, whether you are in, one tap to enter.
 *
 * Dre, 18 Sep: "we need a giveaways tab for our pokemon giveaway listing. and
 * also we will be doing other giveways we can put that in profile page."
 *
 * The list comes from /api/giveaways (worker/giveaways.mjs), which is worded
 * from the same RULES object the Official Rules page is rendered from, so
 * this card cannot promise a prize the rules do not. Entering calls the same
 * writer as sending PACKS to NUM: one ticket per person per week whichever
 * door they use, and a second tap says "you're in" rather than adding one.
 *
 * Nothing here says "you won" unless the draw's claims table says so.
 */
import { useEffect, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { apiUrl } from '../../lib/apibase';
import { canSend, needAccount } from '../../lib/gate';
import { t } from '../../lib/i18n';

export interface Giveaway {
  id: string; title: string; prize: string; how: string; who: string; rules_url: string; note: string;
  closes_at: string; draw_label: string; entered: boolean; entries: number;
  won: { draw: string; state: 'won' | 'claimed'; drawn_at: string } | null;
}

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };

/** "Closes Thursday 23:59 UTC" — the rules' own clock, not the phone's. */
export function closesLine(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()];
  return t('Closes {day} 23:59 UTC', { day: t(day) });
}

/** `heading` is the profile's own group label, rendered only when there is something under it. */
export default function GiveawaysCard({ heading }: { heading?: React.ReactNode }) {
  const me = useApp((s) => s.me);
  const [list, setList] = useState<Giveaway[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const q = me?.id ? `?me=${encodeURIComponent(me.id)}` : '';
    fetch(apiUrl(`/api/giveaways${q}`))
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { giveaways?: Giveaway[] } | null) => { if (live) setList(j?.giveaways ?? []); })
      .catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, [me?.id]);

  const enter = async (g: Giveaway) => {
    if (busy) return;
    // Same line as sending a message: a prize needs somewhere to go.
    if (!me?.id || !canSend(me)) { needAccount({ profileOpen: true }); return; }
    setBusy(g.id); setErr(null);
    try {
      const r = await fetch(apiUrl('/api/giveaways/enter'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ me: me.id, id: g.id }),
      });
      const d = await r.json().catch(() => ({})) as Partial<Giveaway> & { error?: string; ok?: boolean };
      if (r.status === 403 && d.error === 'verify_to_send') { store.set({ inviteOpen: {} }); return; }
      if (!r.ok || !d.ok) { setErr(t('That entry didn’t record. Try again in a minute — you are not in until this says so.')); return; }
      setList((ls) => (ls ?? []).map((x) => (x.id === g.id ? { ...x, entered: !!d.entered, entries: d.entries ?? x.entries } : x)));
    } catch {
      setErr(t('That entry didn’t record. Try again in a minute — you are not in until this says so.'));
    } finally {
      setBusy(null);
    }
  };

  if (!list || !list.length) return null;
  return (
    <>
      {heading}
      {list.map((g) => (
        <div key={g.id} className="glass" style={card} data-giveaway={g.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={kicker}>{t('GIVEAWAY')}</div>
            <div style={{ ...kicker, color: 'var(--color-accent)' }}>{closesLine(g.closes_at)}</div>
          </div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15, marginTop: 4 }}>{g.title}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.55 }}>{g.prize}</div>

          {g.won && (
            <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 10, background: 'var(--field-bg)', border: '1px solid var(--ink-12)', fontSize: 12, lineHeight: 1.5 }}>
              <b>{t('You won the {date} draw.', { date: g.won.drawn_at.slice(0, 10) })}</b>{' '}
              {g.won.state === 'claimed' ? t('Your pack is on its way.') : t('NUM will message you to confirm where to send it — reply within 14 days or it is redrawn.')}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            {g.entered ? (
              <div style={{ flex: 1, textAlign: 'center', borderRadius: 10, padding: '11px 12px', fontWeight: 700, fontSize: 12.5, background: 'var(--field-bg)', border: '1px solid var(--ink-12)', color: 'var(--color-accent)' }}>
                {t('You’re in this week’s draw')}
              </div>
            ) : (
              <button
                type="button"
                disabled={busy === g.id}
                onClick={() => void enter(g)}
                className="tap press glow"
                style={{ flex: 1, border: 0, borderRadius: 10, padding: '11px 12px', fontWeight: 700, fontSize: 12.5, background: 'var(--grad-accent)', color: '#fff', cursor: 'pointer' }}
              >
                {busy === g.id ? t('Entering…') : t('Enter this week — free')}
              </button>
            )}
            <a href={g.rules_url} target="_blank" rel="noreferrer" className="tap" style={{ flex: 'none', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--ink-60)', textDecoration: 'none', padding: '11px 6px' }}>
              {t('RULES')}
            </a>
          </div>
          {err && <div style={{ fontSize: 11.5, color: 'var(--color-accent-700)', marginTop: 8, lineHeight: 1.5 }}>{err}</div>}
          <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 8, lineHeight: 1.5 }}>
            {g.who}
            {g.entries > 0 ? ` · ${t('{n} in so far', { n: g.entries })}` : ''}
            {' · '}{g.how}
          </div>
          <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 4, lineHeight: 1.5 }}>{g.note}</div>
        </div>
      ))}
    </>
  );
}
