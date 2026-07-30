// The operator's console. Reached only at /?admin=<ADMIN_KEY> — there is no
// button to it anywhere in the app, and the key is checked server-side on
// every request, so the URL is a router, not a permission.
//
// It answers the two questions an operator actually has: is anyone using this,
// and what is it costing me. The AI spend is measured from real token counts
// (worker/console.mjs → num_usage), not estimated.
import { useEffect, useState } from 'react';

interface Overview {
  people: { members: number; verified: number; active24: number; recent: Array<{ id: string; name: string; phone: string | null; phone_verified: number; dest: string | null; created_at: string; seen_at: string | null }> };
  usage: { plans: number; planItems: number; events: number; guests: number; rsvpYes: number; invites: number; joined: number; conversions: number };
  ai: { window_days: number; turns: number; spend_usd: number; per_turn_usd: number; by_day: Array<{ day: string; lane: string; turns: number; in_tokens: number; out_tokens: number; cache_read: number; micro_usd: number; avg_ms: number }> };
  product: { open_feature_requests: number; asks: Array<{ ts: string; place: string | null; summary: string; suggestion: string; status: string }> };
  referrals: Array<{ code: string; owner_type: string; joined: number }>;
}

const wrap: React.CSSProperties = {
  minHeight: '100dvh', background: '#0d0f14', color: '#e9e9ee',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '28px 18px 60px',
};
const card: React.CSSProperties = {
  background: '#151922', border: '1px solid #232833', borderRadius: 14, padding: 16, marginBottom: 14,
};
const h: React.CSSProperties = { fontSize: 10, letterSpacing: '.18em', color: '#7d8598', fontWeight: 700, marginBottom: 12 };
const big: React.CSSProperties = { fontSize: 26, fontWeight: 800, letterSpacing: '-.02em' };
const sub: React.CSSProperties = { fontSize: 10, color: '#7d8598', letterSpacing: '.08em', marginTop: 2 };

const Stat = ({ n, l, accent }: { n: string | number; l: string; accent?: boolean }) => (
  <div style={{ flex: 1, minWidth: 88 }}>
    <div style={{ ...big, color: accent ? '#ff7a45' : '#e9e9ee' }}>{n}</div>
    <div style={sub}>{l}</div>
  </div>
);

export default function AdminView({ adminKey }: { adminKey: string }) {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/admin/overview?days=${days}&key=${encodeURIComponent(adminKey)}`);
        if (!res.ok) throw new Error(res.status === 401 ? 'Wrong or missing admin key.' : `admin ${res.status}`);
        const j = (await res.json()) as Overview;
        if (live) {
          setData(j);
          setErr(null);
        }
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : 'failed');
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [adminKey, days]);

  if (err) return <div style={{ ...wrap, padding: 40 }}>{err}</div>;
  if (!data) return <div style={{ ...wrap, padding: 40 }}>loading…</div>;

  const { people, usage, ai, product, referrals } = data;
  // The number that matters for planning: what 100 daily-active users would
  // cost at today's measured per-turn price and a plausible turn count.
  const projected = ai.per_turn_usd * 100 * 12;

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: '.2em', fontWeight: 800 }}>NUM · OPERATOR</div>
          <div style={{ ...sub, marginTop: 4 }}>live · refreshes every 30s</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[1, 7, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                font: 'inherit', fontSize: 11, padding: '6px 11px', borderRadius: 999, cursor: 'pointer',
                background: days === d ? '#ff7a45' : 'transparent', color: days === d ? '#0d0f14' : '#7d8598',
                border: '1px solid ' + (days === d ? '#ff7a45' : '#232833'), fontWeight: 700,
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div style={card}>
        <div style={h}>PEOPLE</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Stat n={people.members} l="SIGNED UP" accent />
          <Stat n={people.verified} l="NUMBER VERIFIED" />
          <Stat n={people.active24} l="ACTIVE 24H" />
          <Stat n={usage.invites} l="INVITES SENT" />
          <Stat n={usage.joined} l="INVITES JOINED" />
        </div>
      </div>

      <div style={card}>
        <div style={h}>AI SPEND — MEASURED, {ai.window_days}D</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Stat n={ai.turns} l="TURNS" />
          <Stat n={'$' + ai.spend_usd.toFixed(2)} l="SPENT" accent />
          <Stat n={'$' + ai.per_turn_usd.toFixed(4)} l="PER TURN" />
          <Stat n={'$' + projected.toFixed(0)} l="100 DAU / DAY (EST)" />
        </div>
        <div style={{ marginTop: 14, fontSize: 11, color: '#7d8598' }}>
          {ai.by_day.length === 0 && 'No turns recorded in this window.'}
          {ai.by_day.map((r) => (
            <div key={r.day + r.lane} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #1c212b' }}>
              <span>
                {r.day} · <b style={{ color: r.lane === 'small' ? '#4ade80' : '#ff7a45' }}>{r.lane}</b>
              </span>
              <span>
                {r.turns} turns · {((r.in_tokens ?? 0) + (r.out_tokens ?? 0)).toLocaleString()} tok
                {r.cache_read ? ` · ${r.cache_read.toLocaleString()} cached` : ''} · ${((r.micro_usd ?? 0) / 1e6).toFixed(3)}
                {r.avg_ms ? ` · ${Math.round(r.avg_ms)}ms` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={card}>
        <div style={h}>WHAT THEY'RE DOING</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Stat n={usage.plans} l="GROUP PLANS" />
          <Stat n={usage.planItems} l="PLAN ITEMS" />
          <Stat n={usage.events} l="EVENTS" />
          <Stat n={usage.guests} l="GUESTS" />
          <Stat n={usage.rsvpYes} l="RSVP YES" />
          <Stat n={usage.conversions} l="REFERRALS" />
        </div>
      </div>

      <div style={card}>
        <div style={h}>ASKED FOR, COULDN'T DO ({product.open_feature_requests} OPEN)</div>
        {product.asks.length === 0 && <div style={{ fontSize: 11, color: '#7d8598' }}>Nothing flagged.</div>}
        {product.asks.map((a, i) => (
          <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid #1c212b', fontSize: 11.5 }}>
            <div style={{ color: '#e9e9ee' }}>{a.summary}</div>
            <div style={{ color: '#7d8598', marginTop: 3 }}>
              → {a.suggestion} · {a.place ?? 'no place'} · {a.status}
            </div>
          </div>
        ))}
      </div>

      <div style={card}>
        <div style={h}>NEWEST SIGNUPS</div>
        {people.recent.map((r) => (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #1c212b', fontSize: 11.5 }}>
            <span>
              {r.name ?? '—'} <span style={{ color: '#7d8598' }}>{r.phone ?? 'no number'}</span>
              {r.phone_verified ? <span style={{ color: '#4ade80' }}> ✓</span> : null}
            </span>
            <span style={{ color: '#7d8598' }}>
              {r.dest ?? '—'} · {r.created_at?.slice(0, 16)}
            </span>
          </div>
        ))}
      </div>

      {!!referrals.length && (
        <div style={card}>
          <div style={h}>REFERRAL LEADERBOARD</div>
          {referrals.map((r) => (
            <div key={r.code} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 11.5 }}>
              <span>
                {r.code} <span style={{ color: '#7d8598' }}>{r.owner_type}</span>
              </span>
              <span>{r.joined} joined</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
