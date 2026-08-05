// YOUR PLAN.
//
// The card leads with what you already have rather than what you're missing.
// A pricing wall that opens with a locked padlock teaches people the product
// is mostly not for them; this one opens with "the concierge, your plans and
// your people are yours, free, forever" — which is true and is the reason to
// stay.
//
// Upgrades are framed as ceilings lifting, never as features unlocking, because
// that is what they actually are. Nothing in the free tier gets taken away to
// create a reason to pay.
import { useEffect, useState } from 'react';
import { useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { CheckIcon } from '../../lib/icons';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };

type Tier = {
  id: string;
  name: string;
  price_cents: number;
  blurb: string;
  entitlements: Record<string, boolean | number | null>;
};

const money = (c: number) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);

/** Turn raw entitlements into the two or three lines that actually differ. */
function highlights(t: Tier, free: Tier | undefined): string[] {
  const out: string[] = [];
  const e = t.entitlements;
  const f = free?.entitlements ?? {};
  const limit = (k: string, one: string, many: (n: number) => string) => {
    if (e[k] === f[k]) return;
    if (e[k] === null) out.push(one);
    else if (typeof e[k] === 'number') out.push(many(e[k] as number));
  };
  limit('plans_max', 'Unlimited plans', (n) => `${n} plans at once`);
  limit('deep_research_monthly', 'Unlimited deep research', (n) => `${n} deep searches a month`);
  if (e.priority_queue && !f.priority_queue) out.push('First in line when everyone asks at once');
  if (e.flight_search && !f.flight_search) out.push('Live fare search');
  if (e.concierge_booking && !f.concierge_booking) out.push('Num books on your behalf');
  return out;
}

export default function MembershipCard() {
  const me = useApp((s) => s.me);
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [mine, setMine] = useState<{ tier: string; used?: Record<string, number> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void fetch('/api/membership/tiers').then((r) => r.json()).then((d) => setTiers(d.tiers)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!me?.id) return;
    void fetch(`/api/membership/me?me=${encodeURIComponent(me.id)}`)
      .then((r) => r.json()).then(setMine).catch(() => {});
  }, [me?.id]);

  if (!tiers?.length) return null;
  const free = tiers.find((t) => t.price_cents === 0);
  const current = mine?.tier ?? 'free';
  const currentTier = tiers.find((t) => t.id === current);
  const paid = tiers.filter((t) => t.price_cents > 0);

  const subscribe = async (tier: string) => {
    if (!me?.id) return;
    setBusy(tier);
    setNote(null);
    try {
      const out = await fetch('/api/membership/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ me: me.id, tier }),
      }).then((r) => r.json()) as { ok?: boolean; url?: string; error?: string };
      if (out.url) { window.location.href = out.url; return; }
      setNote(out.error ?? 'Couldn’t start that just now.');
    } catch {
      setNote('Couldn’t reach the till — try again in a moment.');
    }
    setBusy(null);
  };

  return (
    <div className="glass" style={card}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={kicker}>YOUR PLAN</div>
        <div style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, color: current === 'free' ? 'var(--ink-60)' : 'var(--color-accent)' }}>
          {currentTier?.name ?? 'Num'}
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 8, lineHeight: 1.55 }}>
        {current === 'free'
          ? 'The concierge, your plans and your people are yours — free, no trial, no countdown. Paying only lifts the ceilings.'
          : currentTier?.blurb}
      </div>

      {/* What you've actually used. Shown before any upsell so the number is
          informative rather than a nudge. */}
      {mine?.used && Object.keys(mine.used).length > 0 && (
        <div style={{ marginTop: 9, display: 'grid', gap: 3 }}>
          {Object.entries(mine.used).map(([k, v]) => {
            const cap = currentTier?.entitlements?.[k];
            return (
              <div key={k} style={{ fontSize: 11, color: 'var(--ink-40)' }}>
                {k.replace(/_/g, ' ')}: {v}{typeof cap === 'number' ? ` of ${cap}` : ''} this month
              </div>
            );
          })}
        </div>
      )}

      {!open && current === 'free' && (
        <div
          {...pressable(() => setOpen(true))}
          style={{ cursor: 'pointer', marginTop: 12, fontSize: 11, fontWeight: 800, letterSpacing: '.07em', color: 'var(--color-accent-700)' }}
        >
          SEE WHAT MORE ROOM COSTS
        </div>
      )}

      {(open || current !== 'free') && (
        <div style={{ marginTop: 12, display: 'grid', gap: 9 }}>
          {paid.map((t) => {
            const on = t.id === current;
            const lines = highlights(t, free);
            return (
              <div
                key={t.id}
                style={{
                  borderRadius: 14, padding: 12,
                  border: '1.5px solid ' + (on ? 'var(--color-accent)' : 'var(--ink-08)'),
                  background: 'var(--field-bg)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15 }}>{t.name}</div>
                  <div style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 800 }}>{money(t.price_cents)}<span style={{ fontSize: 10, color: 'var(--ink-40)', fontWeight: 600 }}>/mo</span></div>
                </div>
                <div style={{ marginTop: 7, display: 'grid', gap: 4 }}>
                  {lines.map((l) => (
                    <div key={l} style={{ fontSize: 11.5, color: 'var(--ink)', display: 'flex', gap: 6, alignItems: 'flex-start', lineHeight: 1.45 }}>
                      <CheckIcon size={11} style={{ color: 'var(--color-accent)', marginTop: 3, flex: 'none' }} />
                      <span>{l}</span>
                    </div>
                  ))}
                </div>
                {on ? (
                  <div style={{ marginTop: 10, fontSize: 10.5, fontWeight: 800, letterSpacing: '.07em', color: 'var(--color-accent)', textAlign: 'center' }}>
                    YOUR PLAN
                  </div>
                ) : (
                  <div
                    {...pressable(() => { if (!busy) void subscribe(t.id); })}
                    style={{
                      cursor: 'pointer', marginTop: 11, borderRadius: 999, padding: '11px 14px', textAlign: 'center',
                      background: 'var(--grad-accent)', color: '#fff', fontWeight: 800, fontSize: 11, letterSpacing: '.06em',
                      opacity: busy ? 0.5 : 1,
                    }}
                  >
                    {busy === t.id ? 'OPENING…' : `GET ${t.name.toUpperCase()}`}
                  </div>
                )}
              </div>
            );
          })}
          <div style={{ fontSize: 10, color: 'var(--ink-40)', lineHeight: 1.5 }}>
            Cancel any time. If a payment lapses you drop back to the free plan — you never lose the app, only the extra room.
          </div>
        </div>
      )}

      {note && <div style={{ marginTop: 9, fontSize: 11.5, color: '#a3271c', lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}
