// The operator console — same design language as the rest of the app, and
// built for a phone first, because the person who needs it is usually not at a
// desk.
//
// Auth: the key is posted ONCE and exchanged for a signed 12-hour session held
// in localStorage. It never appears in the URL — a URL ends up in history, in
// the address bar of a screenshot, and in the Referer of every outbound link.
import { useCallback, useEffect, useState } from 'react';
import { pressable } from '../../lib/a11y';
import { ChevronRightIcon, XIcon } from '../../lib/icons';

const TOKEN_KEY = 'num-admin-session';

interface Overview {
  app: {
    members: number; verified: number; active24: number; plans: number; planItems: number;
    events: number; guests: number; rsvpYes: number; invites: number; joined: number; conversions: number;
    recent: Array<{ id: string; name: string; phone: string | null; phone_verified: number; dest: string | null; created_at: string }>;
    referrals: Array<{ code: string; owner_type: string; joined: number }>;
  };
  site: { leads: number; leadsNew: number; accounts: number; byDest: Array<{ dest: string; n: number }> };
  brain: {
    messages: number; requests: number; bookings: number; guests: number;
    byTier: Array<{ tier: string; calls: number; in_tokens: number; out_tokens: number; avg_ms: number }>;
    recentRequests: Array<{ id: string; vertical: string | null; intent: string | null; status: string | null; area: string | null; created_at: string }>;
  };
  directory: { places: number; withPhoto: number; destinations: number; buzz: number; latestBuzz: Array<{ dest: string; title: string; publisher: string; kind: string }> };
  business: { businesses: number; claims: number; owners: number; rows: Array<{ id: string; name: string; category: string | null; status: string | null; country: string | null }> };
  ai: { window_days: number; turns: number; spend_usd: number; per_turn_usd: number; by_day: Array<{ day: string; lane: string; turns: number; in_tokens: number; out_tokens: number; cache_read: number; micro_usd: number; avg_ms: number }> };
  product: { open_feature_requests: number; asks: Array<{ id: number; ts: string; place: string | null; summary: string; suggestion: string; status: string }> };
}

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };
const field: React.CSSProperties = {
  width: '100%', height: 46, borderRadius: 14, border: '1px solid var(--ink-12)', padding: '0 14px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700,
  fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center',
  boxShadow: '0 4px 14px rgba(236,48,19,.3)',
};

const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString();

/** A stat tile. Two per row on a phone, four on anything wider. */
function Stat({ n, label, accent }: { n: string | number; label: string; accent?: boolean }) {
  return (
    <div style={{ flex: '1 1 40%', minWidth: 96 }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, letterSpacing: '-.02em', color: accent ? 'var(--color-accent)' : 'var(--ink)' }}>
        {n}
      </div>
      <div style={{ ...kicker, marginTop: 1 }}>{label}</div>
    </div>
  );
}

function Panel({ title, summary, defaultOpen = false, children }: {
  title: string; summary?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass" style={card}>
      <div {...pressable(() => setOpen((v) => !v))} aria-expanded={open} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={kicker}>{title}</div>
          {summary && <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 3, lineHeight: 1.45 }}>{summary}</div>}
        </div>
        <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)', flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }} />
      </div>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

const Row = ({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--ink-08)', fontSize: 12, lineHeight: 1.45 }}>
    <span style={{ minWidth: 0 }}>{left}</span>
    {right != null && <span style={{ color: 'var(--ink-60)', flex: 'none', textAlign: 'right' }}>{right}</span>}
  </div>
);

export default function AdminView() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [key, setKey] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    if (!key.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'That did not work.');
      localStorage.setItem(TOKEN_KEY, body.token);
      setToken(body.token);
      setKey('');
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setData(null);
  };

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/overview?days=${days}`, { headers: { 'X-Admin-Session': token } });
      if (res.status === 401) {
        // Expired or revoked — drop it rather than retrying forever.
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        return;
      }
      if (!res.ok) throw new Error(`admin ${res.status}`);
      setData((await res.json()) as Overview);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  }, [token, days]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  // ── the lock screen ───────────────────────────────────────────────────────
  if (!token) {
    return (
      <div className="app-shell-stage">
        <div className="app-shell">
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
            <div className="aurora-layer" aria-hidden="true" />
            <div style={{ position: 'relative', zIndex: 1, margin: 'auto', padding: 22, width: '100%', maxWidth: 380 }}>
              <div className="glass" style={{ borderRadius: 'var(--r-lg)', padding: 20 }}>
                <div style={{ fontSize: 11, letterSpacing: '.2em', fontWeight: 800, color: 'var(--color-accent)' }}>NUM · OPERATOR</div>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 21, marginTop: 8 }}>Sign in</div>
                <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 6, lineHeight: 1.55 }}>
                  Your admin key, once. It is exchanged for a 12-hour session on this device and never goes in the address bar.
                </div>
                <input
                  style={{ ...field, marginTop: 14 }}
                  type="password"
                  autoComplete="current-password"
                  placeholder="Admin key"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void signIn(); }}
                />
                <div {...pressable(signIn)} style={{ ...primary, marginTop: 10, opacity: busy || !key.trim() ? 0.6 : 1 }}>
                  {busy ? 'ONE SEC…' : 'OPEN THE DASHBOARD'}
                </div>
                {err && <div style={{ fontSize: 11.5, color: 'var(--color-accent-700)', marginTop: 10 }}>{err}</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── the dashboard ─────────────────────────────────────────────────────────
  return (
    <div className="app-shell-stage">
      <div className="app-shell">
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
          <div className="aurora-layer" aria-hidden="true" />

          <div className="glass" style={{ position: 'relative', zIndex: 2, margin: '0 8px', borderRadius: '0 0 var(--r-lg) var(--r-lg)', borderTop: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'max(env(safe-area-inset-top), 14px) 16px 12px' }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: '.16em', fontWeight: 800 }}>
                  NUM <span style={{ fontWeight: 400, opacity: 0.55 }}>· OPERATOR</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 3 }}>live · refreshes every 30s</div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {[1, 7, 30].map((d) => (
                  <span
                    key={d}
                    {...pressable(() => setDays(d))}
                    style={{
                      cursor: 'pointer', fontSize: 11, fontWeight: 800, padding: '5px 10px', borderRadius: 999,
                      background: days === d ? 'var(--grad-accent)' : 'transparent',
                      color: days === d ? '#fff' : 'var(--ink-40)',
                      border: '1px solid ' + (days === d ? 'transparent' : 'var(--ink-12)'),
                    }}
                  >
                    {d}d
                  </span>
                ))}
                <span {...pressable(signOut)} aria-label="Sign out" className="glass press" style={{ cursor: 'pointer', width: 28, height: 28, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <XIcon size={13} />
                </span>
              </div>
            </div>
          </div>

          <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', position: 'relative', zIndex: 1, paddingBottom: 40 }}>
            {!data && <div style={{ ...card, fontSize: 12, color: 'var(--ink-60)' }}>Loading…</div>}
            {err && <div style={{ ...card, fontSize: 12, color: 'var(--color-accent-700)' }}>{err}</div>}
            {data && (
              <>
                {/* the headline: what it costs, and who is here */}
                <div className="glass" style={card}>
                  <div style={kicker}>AI SPEND · MEASURED · {data.ai.window_days}D</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10 }}>
                    <Stat n={fmt(data.ai.turns)} label="TURNS" />
                    <Stat n={'$' + data.ai.spend_usd.toFixed(2)} label="SPENT" accent />
                    <Stat n={'$' + data.ai.per_turn_usd.toFixed(4)} label="PER TURN" />
                    <Stat n={'$' + (data.ai.per_turn_usd * 100 * 12).toFixed(0)} label="100 DAU/DAY EST" />
                  </div>
                  {data.ai.by_day.map((r) => (
                    <Row
                      key={r.day + r.lane}
                      left={<>{r.day} · <b style={{ color: r.lane === 'small' ? '#0e6b45' : 'var(--color-accent)' }}>{r.lane}</b></>}
                      right={`${r.turns} · ${fmt((r.in_tokens ?? 0) + (r.out_tokens ?? 0))} tok · $${((r.micro_usd ?? 0) / 1e6).toFixed(3)}`}
                    />
                  ))}
                </div>

                <Panel title="THE APP" summary={`${fmt(data.app.members)} signed up · ${fmt(data.app.active24)} active today`} defaultOpen>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                    <Stat n={fmt(data.app.members)} label="SIGNED UP" accent />
                    <Stat n={fmt(data.app.verified)} label="VERIFIED" />
                    <Stat n={fmt(data.app.invites)} label="INVITES" />
                    <Stat n={fmt(data.app.joined)} label="JOINED" />
                    <Stat n={fmt(data.app.plans)} label="GROUP PLANS" />
                    <Stat n={fmt(data.app.events)} label="EVENTS" />
                    <Stat n={fmt(data.app.rsvpYes)} label="RSVP YES" />
                    <Stat n={fmt(data.app.conversions)} label="REFERRALS" />
                  </div>
                  {!!data.app.recent.length && (
                    <div style={{ marginTop: 14 }}>
                      <div style={kicker}>NEWEST</div>
                      {data.app.recent.map((r) => (
                        <Row
                          key={r.id}
                          left={<>{r.name ?? '—'} {r.phone_verified ? <span style={{ color: '#0e6b45' }}>✓</span> : null} <span style={{ color: 'var(--ink-40)' }}>{r.phone ?? ''}</span></>}
                          right={`${r.dest ?? '—'} · ${(r.created_at ?? '').slice(5, 16)}`}
                        />
                      ))}
                    </div>
                  )}
                </Panel>

                <Panel title="ITSNUM.COM" summary={`${fmt(data.site.leads)} leads · ${fmt(data.site.accounts)} accounts`}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                    <Stat n={fmt(data.site.leads)} label="LEADS" accent />
                    <Stat n={fmt(data.site.leadsNew)} label="UNWORKED" />
                    <Stat n={fmt(data.site.accounts)} label="ACCOUNTS" />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <div style={kicker}>LEADS BY DESTINATION</div>
                    {data.site.byDest.map((d) => (
                      <Row key={d.dest ?? 'none'} left={d.dest ?? '—'} right={fmt(d.n)} />
                    ))}
                  </div>
                </Panel>

                <Panel title="LINE & WHATSAPP BRAIN" summary={`${fmt(data.brain.messages)} messages · ${fmt(data.brain.requests)} requests`}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                    <Stat n={fmt(data.brain.messages)} label="MESSAGES" />
                    <Stat n={fmt(data.brain.requests)} label="REQUESTS" accent />
                    <Stat n={fmt(data.brain.bookings)} label="BOOKINGS" />
                    <Stat n={fmt(data.brain.guests)} label="GUESTS" />
                  </div>
                  {!!data.brain.byTier.length && (
                    <div style={{ marginTop: 12 }}>
                      <div style={kicker}>MODEL TIERS</div>
                      {data.brain.byTier.map((t) => (
                        <Row key={t.tier} left={t.tier ?? '—'} right={`${t.calls} calls · ${fmt((t.in_tokens ?? 0) + (t.out_tokens ?? 0))} tok · ${Math.round(t.avg_ms ?? 0)}ms`} />
                      ))}
                    </div>
                  )}
                  {!!data.brain.recentRequests.length && (
                    <div style={{ marginTop: 12 }}>
                      <div style={kicker}>RECENT REQUESTS</div>
                      {data.brain.recentRequests.map((r) => (
                        <Row key={r.id} left={`${r.vertical ?? r.intent ?? '—'}${r.area ? ' · ' + r.area : ''}`} right={r.status ?? '—'} />
                      ))}
                    </div>
                  )}
                </Panel>

                <Panel title="DIRECTORY" summary={`${fmt(data.directory.places)} places · ${fmt(data.directory.destinations)} destinations`}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                    <Stat n={fmt(data.directory.places)} label="PLACES" accent />
                    <Stat n={fmt(data.directory.withPhoto)} label="WITH PHOTO" />
                    <Stat n={fmt(data.directory.destinations)} label="DESTINATIONS" />
                    <Stat n={fmt(data.directory.buzz)} label="BUZZ ITEMS" />
                  </div>
                  {!!data.directory.latestBuzz.length && (
                    <div style={{ marginTop: 12 }}>
                      <div style={kicker}>SCOUT — LATEST</div>
                      {data.directory.latestBuzz.map((b, i) => (
                        <Row key={i} left={b.title} right={`${b.dest} · ${b.publisher ?? ''}`} />
                      ))}
                    </div>
                  )}
                </Panel>

                <Panel title="BUSINESSES" summary={`${fmt(data.business.businesses)} claimed · ${fmt(data.business.claims)} claims`}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                    <Stat n={fmt(data.business.businesses)} label="BUSINESSES" accent />
                    <Stat n={fmt(data.business.claims)} label="CLAIMS" />
                    <Stat n={fmt(data.business.owners)} label="VERIFIED OWNERS" />
                  </div>
                  {data.business.rows.map((b) => (
                    <Row key={b.id} left={b.name} right={`${b.category ?? '—'} · ${b.status ?? '—'}`} />
                  ))}
                </Panel>

                <Panel title="ASKED FOR, COULDN'T DO" summary={`${data.product.open_feature_requests} open`} defaultOpen>
                  {data.product.asks.length === 0 && <div style={{ fontSize: 12, color: 'var(--ink-60)' }}>Nothing flagged.</div>}
                  {data.product.asks.map((a) => (
                    <div key={a.id} style={{ padding: '9px 0', borderBottom: '1px solid var(--ink-08)' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.45 }}>{a.summary}</div>
                      <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.5 }}>→ {a.suggestion}</div>
                      <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 4 }}>{a.place ?? 'no place'} · {a.status}</div>
                    </div>
                  ))}
                </Panel>

                {!!data.app.referrals.length && (
                  <Panel title="REFERRALS" summary={`${data.app.referrals.length} codes`}>
                    {data.app.referrals.map((r) => (
                      <Row key={r.code} left={<>{r.code} <span style={{ color: 'var(--ink-40)' }}>{r.owner_type}</span></>} right={`${r.joined} joined`} />
                    ))}
                  </Panel>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
