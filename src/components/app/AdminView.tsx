// The operator console — same design language as the rest of the app, and
// built for a phone first, because the person who needs it is usually not at a
// desk.
//
// Auth: the key is posted ONCE and exchanged for a signed 12-hour session held
// in localStorage. It never appears in the URL — a URL ends up in history, in
// the address bar of a screenshot, and in the Referer of every outbound link.
import { useCallback, useEffect, useState, createContext, useContext } from 'react';
import { pressable } from '../../lib/a11y';
import { ChevronRightIcon, XIcon } from '../../lib/icons';

const TOKEN_KEY = 'num-admin-session';
const PAYOUT_TOKEN_KEY = 'num-payout-session';
// The payout desk is a separate Worker on purpose — money code should not share
// a deploy or a set of bindings with a chat UI. It uses the same key, so one
// sign-in mints both sessions.
const PAYOUTS = 'https://num-payouts.thatislumi.workers.dev';

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
  money: {
    circulating: number; escrow_held: number; escrow_committed: number; escrow_balanced: boolean;
    moves_total: number; moves_24h: number; by_kind: Array<{ kind: string; n: number; volume: number }>;
  };
  tabs: { open: number; all_time: number; items: number; on_open_tabs: number; settled_value: number };
  errands: {
    all_time: number; live: number; open: number; disputed: number; bounties_paid: number;
    by_state: Array<{ state: string; n: number; bounty: number }>;
    recent: Array<{ id: string; title: string; state: string; bounty: number; spend_cap: number; place: string | null; poster: string | null; runner: string | null }>;
  };
  reach: { push_subscriptions: number; push_dead: number; notifications_queued: number; notifications_delivered: number; delivery_rate: number | null };
  partners: { air_calls: number; air_failed: number; sabre_operations: number; sabre_failed: number };
  rails: Record<string, boolean | string | null>;
  engagement: {
    active_1d: number; active_7d: number; active_30d: number; ever_asked: number;
    top_users: Array<{ member_id: string; name: string | null; turns: number; last_day: string; micro_usd: number }>;
  };
  operator?: { signed_in_as: string | null; configured: string | null; recent_logins: Array<{ who: string | null; ok: number; ip: string; created_at: string }> };
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

/**
 * Which tab is showing. Held in context so each Panel declares the ONE tab it
 * belongs to (`in="money"`) instead of every panel being threaded a prop it
 * mostly ignores. The dashboard used to be fifteen collapsibles in a single
 * column, which is a list, not a dashboard — you had to already know what you
 * were looking for to find it.
 */
/**
 * PULSE — the only screen that has to be readable in five seconds.
 *
 * Everything here is either a number that should be going up, or an alarm.
 * Nothing is collapsed, nothing needs a tap, and anything wrong is stated in
 * a sentence rather than implied by a figure you have to interpret. If this
 * screen is quiet, the system is fine.
 */
function Pulse({ d }: { d: Overview }) {
  // Ordered worst-first: money that has gone missing outranks a dead push
  // subscription, and an operator scanning this should hit the worst thing
  // first rather than in schema order.
  const alarms: Array<{ level: 'bad' | 'warn'; text: string }> = [];
  if (!d.money.escrow_balanced) {
    alarms.push({
      level: 'bad',
      text: `Escrow drift — ★${fmt(d.money.escrow_held)} held against ★${fmt(d.money.escrow_committed)} committed. Stars moved without an errand moving.`,
    });
  }
  if (d.errands.disputed > 0) {
    alarms.push({ level: 'warn', text: `${d.errands.disputed} errand${d.errands.disputed === 1 ? '' : 's'} disputed — the Stars are frozen until someone rules on it.` });
  }
  if (d.reach.notifications_queued > 0 && (d.reach.delivery_rate ?? 1) < 0.5) {
    alarms.push({ level: 'warn', text: `Only ${Math.round((d.reach.delivery_rate ?? 0) * 100)}% of notifications are landing — wake-ups aren’t reaching phones.` });
  }
  if (d.reach.push_dead > 0) {
    alarms.push({ level: 'warn', text: `${d.reach.push_dead} push subscription${d.reach.push_dead === 1 ? '' : 's'} dead — those devices hear nothing.` });
  }
  if (d.rails.sms === false) {
    alarms.push({ level: 'warn', text: 'No SMS provider — numbers save but are never verified, so one-number-one-account isn’t enforced.' });
  }
  if (d.partners.air_failed > 0 || d.partners.sabre_failed > 0) {
    alarms.push({ level: 'warn', text: `Partner failures: ${d.partners.air_failed} AiR, ${d.partners.sabre_failed} Sabre.` });
  }

  return (
    <>
      <div className="glass" style={card}>
        <div style={kicker}>RIGHT NOW</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10 }}>
          <Stat n={fmt(d.engagement.active_1d)} label="ACTIVE TODAY" accent />
          <Stat n={fmt(d.engagement.active_7d)} label="ACTIVE · 7D" />
          <Stat n={fmt(d.app.members)} label="SIGNED UP" />
          <Stat n={fmt(d.engagement.ever_asked)} label="EVER ASKED NUM" />
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 10, lineHeight: 1.5 }}>
          {d.app.members
            ? `${Math.round((d.engagement.ever_asked / d.app.members) * 100)}% of people who signed up have actually asked Num for something. That gap is the product problem, not the funnel.`
            : 'Nobody has signed up yet.'}
        </div>
      </div>

      <div className="glass" style={card}>
        <div style={kicker}>{alarms.length ? 'NEEDS YOU' : 'NOTHING NEEDS YOU'}</div>
        {alarms.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ink-60)', marginTop: 8, lineHeight: 1.55 }}>
            Escrow balances, no disputes, notifications landing, partners answering. Quiet is the correct state.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 7, marginTop: 9 }}>
            {alarms.map((a, i) => (
              <div
                key={i}
                style={{
                  fontSize: 12, lineHeight: 1.5, padding: '9px 11px', borderRadius: 10,
                  background: a.level === 'bad' ? 'rgba(236,48,19,.12)' : 'var(--field-bg)',
                  color: a.level === 'bad' ? 'var(--color-accent-700)' : 'var(--ink-60)',
                  fontWeight: a.level === 'bad' ? 700 : 400,
                }}
              >
                {a.text}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="glass" style={card}>
        <div style={kicker}>TODAY’S MOVEMENT</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10 }}>
          <Stat n={fmt(d.ai.turns)} label={`TURNS · ${d.ai.window_days}D`} />
          <Stat n={'$' + d.ai.spend_usd.toFixed(2)} label="AI SPEND" />
          <Stat n={fmt(d.money.moves_24h)} label="STAR MOVES · 24H" />
          <Stat n={fmt(d.errands.live) + ' / ' + fmt(d.tabs.open)} label="ERRANDS / TABS LIVE" />
        </div>
      </div>

      {d.engagement.top_users.length > 0 && (
        <div className="glass" style={card}>
          <div style={kicker}>WHO IS ACTUALLY USING IT</div>
          <div style={{ marginTop: 8 }}>
            {d.engagement.top_users.slice(0, 8).map((u) => (
              <Row
                key={u.member_id}
                left={u.name ?? u.member_id.slice(0, 12)}
                right={`${fmt(u.turns)} turns · last ${u.last_day}`}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const TabCtx = createContext<AdminTab>('pulse');
type AdminTab = 'pulse' | 'people' | 'activity' | 'money' | 'system';

const TABS: Array<{ id: AdminTab; label: string; asks: string }> = [
  { id: 'pulse', label: 'PULSE', asks: 'Is anything wrong right now?' },
  { id: 'people', label: 'PEOPLE', asks: 'Who is using it?' },
  { id: 'activity', label: 'ACTIVITY', asks: 'What are they doing?' },
  { id: 'money', label: 'MONEY', asks: 'Where are the Stars?' },
  { id: 'system', label: 'SYSTEM', asks: 'What is wired, what does it cost?' },
];

function Panel({ title, summary, defaultOpen = false, in: inTab, children }: {
  title: string; summary?: string; defaultOpen?: boolean; in?: AdminTab; children: React.ReactNode;
}) {
  const active = useContext(TabCtx);
  if (inTab && inTab !== active) return null;
  return <PanelBody title={title} summary={summary} defaultOpen={defaultOpen}>{children}</PanelBody>;
}

function PanelBody({ title, summary, defaultOpen = false, children }: {
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

interface Roster {
  rows: Array<{
    member_id: string; name: string | null; country: string | null; stars: number; amount_cents: number;
    rail: string | null; rail_ready: boolean; severity: 'block' | 'hold' | 'note' | 'clear'; payable: boolean;
    findings: Array<{ severity: string; code: string; message: string }>;
  }>;
  systemic: Array<{ code: string; severity: string; message: string; fix: string }>;
  totals: { members: number; stars: number; payable_cents: number; block?: number; hold?: number };
  rails: { ready: string[]; all: Array<{ id: string; label: string; ready: boolean; needs: string }> };
}

const money = (cents: number) => '$' + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The payout desk. Read-only here by design: approving and sending are
 * deliberate acts, and this screen exists so nobody performs them blind.
 */
function PayoutPanel() {
  const [data, setData] = useState<Roster | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);

  useEffect(() => {
    const t = localStorage.getItem(PAYOUT_TOKEN_KEY);
    if (!t) {
      setErr('The payout desk has no admin key set yet.');
      return;
    }
    void fetch(`${PAYOUTS}/roster`, { headers: { 'X-Admin-Session': t } })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 401 ? 'Sign in again to reach the payout desk.' : `payouts ${r.status}`);
        setData((await r.json()) as Roster);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'unavailable'));
  }, []);

  const tone = (s: string) => (s === 'block' ? 'var(--color-accent-700)' : s === 'hold' ? 'var(--color-accent)' : 'var(--ink-60)');

  return (
    <Panel
      title="PAYOUT DESK"
      summary={data ? `${money(data.totals.payable_cents)} clear · ${data.totals.block ?? 0} blocked · ${data.totals.hold ?? 0} need a human` : (err ?? 'loading…')}
      defaultOpen
    >
      {err && <div style={{ fontSize: 12, color: 'var(--ink-60)', lineHeight: 1.5 }}>{err}</div>}
      {data && (
        <>
          {data.systemic.map((s) => (
            <div key={s.code} style={{ padding: 11, borderRadius: 'var(--r-md)', background: 'var(--field-bg)', border: '1px solid var(--ink-08)', marginBottom: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: tone(s.severity), lineHeight: 1.45 }}>{s.message}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>→ {s.fix}</div>
            </div>
          ))}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, margin: '12px 0' }}>
            <Stat n={data.totals.members} label="WITH A BALANCE" />
            <Stat n={money(data.totals.stars * 100)} label="TOTAL OWED" accent />
            <Stat n={money(data.totals.payable_cents)} label="NOT BLOCKED" />
            <Stat n={data.rails.ready.length} label="RAILS LIVE" />
          </div>

          <div style={kicker}>RAILS</div>
          {data.rails.all.map((r) => (
            <Row
              key={r.id}
              left={<>{r.label} {r.ready ? <span style={{ color: '#0e6b45' }}>✓</span> : <span style={{ color: 'var(--ink-40)' }}>not connected</span>}</>}
              right={r.ready ? 'live' : r.needs}
            />
          ))}

          <div style={{ ...kicker, marginTop: 14 }}>EVERYONE WITH A BALANCE</div>
          {data.rows.map((r) => (
            <div key={r.member_id} style={{ borderBottom: '1px solid var(--ink-08)' }}>
              <div
                {...pressable(() => setOpenRow(openRow === r.member_id ? null : r.member_id))}
                style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 10, padding: '8px 0', fontSize: 12 }}
              >
                <span style={{ minWidth: 0 }}>
                  <b style={{ color: tone(r.severity) }}>●</b> {r.name ?? r.member_id}
                  <span style={{ color: 'var(--ink-40)' }}> · {r.country ?? '—'}</span>
                </span>
                <span style={{ color: 'var(--ink-60)', flex: 'none' }}>{money(r.amount_cents)}</span>
              </div>
              {openRow === r.member_id && (
                <div style={{ paddingBottom: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--ink-60)' }}>
                    {r.stars}★ · rail {r.rail ?? 'none'} {r.rail_ready ? '(live)' : '(not connected)'}
                  </div>
                  {r.findings.map((f, i) => (
                    <div key={i} style={{ fontSize: 11.5, marginTop: 5, lineHeight: 1.5, color: tone(f.severity) }}>
                      {f.severity === 'block' ? '✕' : f.severity === 'hold' ? '!' : '·'} {f.message}
                    </div>
                  ))}
                  {!r.findings.length && <div style={{ fontSize: 11.5, marginTop: 5, color: '#0e6b45' }}>Nothing wrong — clear to pay.</div>}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}

export default function AdminView() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [key, setKey] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [tab, setTab] = useState<AdminTab>('pulse');
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
      // Best-effort: if the payout Worker has no key set, the desk simply says
      // it isn't connected rather than blocking the whole dashboard.
      try {
        const pr = await fetch(`${PAYOUTS}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: key.trim() }),
        });
        if (pr.ok) localStorage.setItem(PAYOUT_TOKEN_KEY, (await pr.json()).token);
      } catch {
        /* desk offline — the panel reports it */
      }
      setKey('');
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    localStorage.removeItem(PAYOUT_TOKEN_KEY);
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
                <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 3 }}>
                  {data?.operator?.signed_in_as ?? 'live'} · refreshes every 30s
                </div>
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

          {/* Five tabs, each answering ONE question. The old single column of
              fifteen collapsibles meant you had to know where a number lived
              before you could find it. */}
          <div className="no-scrollbar" style={{ display: 'flex', gap: 6, padding: '10px 12px 4px', overflowX: 'auto', position: 'relative', zIndex: 2 }}>
            {TABS.map((t) => (
              <span
                key={t.id}
                {...pressable(() => setTab(t.id))}
                style={{
                  cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 800, letterSpacing: '.08em',
                  padding: '7px 13px', borderRadius: 999,
                  background: tab === t.id ? 'var(--grad-accent)' : 'transparent',
                  color: tab === t.id ? '#fff' : 'var(--ink-40)',
                  border: '1px solid ' + (tab === t.id ? 'transparent' : 'var(--ink-12)'),
                }}
              >
                {t.label}
              </span>
            ))}
          </div>
          <div style={{ padding: '2px 16px 0', fontSize: 11, color: 'var(--ink-40)', position: 'relative', zIndex: 2 }}>
            {TABS.find((t) => t.id === tab)?.asks}
          </div>

          <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', position: 'relative', zIndex: 1, paddingBottom: 40 }}>
            {!data && <div style={{ ...card, fontSize: 12, color: 'var(--ink-60)' }}>Loading…</div>}
            {err && <div style={{ ...card, fontSize: 12, color: 'var(--color-accent-700)' }}>{err}</div>}
            {data && (
              <TabCtx.Provider value={tab}>
                {tab === 'pulse' && <Pulse d={data} />}
                {/* the headline: what it costs, and who is here */}
                {tab === 'system' && (
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
                )}

                <Panel in="people" title="THE APP" summary={`${fmt(data.app.members)} signed up · ${fmt(data.app.active24)} active today`} defaultOpen>
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

                <Panel in="people" title="ITSNUM.COM" summary={`${fmt(data.site.leads)} leads · ${fmt(data.site.accounts)} accounts`}>
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

                <Panel in="activity" title="LINE & WHATSAPP BRAIN" summary={`${fmt(data.brain.messages)} messages · ${fmt(data.brain.requests)} requests`}>
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

                <Panel in="activity" title="DIRECTORY" summary={`${fmt(data.directory.places)} places · ${fmt(data.directory.destinations)} destinations`}>
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

                <Panel in="activity" title="BUSINESSES" summary={`${fmt(data.business.businesses)} claimed · ${fmt(data.business.claims)} claims`}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                    <Stat n={fmt(data.business.businesses)} label="BUSINESSES" accent />
                    <Stat n={fmt(data.business.claims)} label="CLAIMS" />
                    <Stat n={fmt(data.business.owners)} label="VERIFIED OWNERS" />
                  </div>
                  {data.business.rows.map((b) => (
                    <Row key={b.id} left={b.name} right={`${b.category ?? '—'} · ${b.status ?? '—'}`} />
                  ))}
                </Panel>

                {tab === 'money' && <PayoutPanel />}

                {/* The escrow invariant is the single most important number
                    on this page: held must equal committed, or Stars have
                    moved without an errand moving. Shown first, and loudly
                    when it is wrong. */}
                <Panel in="money"
                  title="STARS & ESCROW"
                  summary={`★${fmt(data.money.circulating)} circulating · ★${fmt(data.money.escrow_held)} held${data.money.escrow_balanced ? '' : ' · LEDGER DRIFT'}`}
                  defaultOpen
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
                    <Stat n={`★${fmt(data.money.circulating)}`} label="IN WALLETS" />
                    <Stat n={`★${fmt(data.money.escrow_held)}`} label="HELD IN ESCROW" />
                    <Stat n={fmt(data.money.moves_24h)} label="MOVES · 24H" />
                    <Stat n={fmt(data.money.moves_total)} label="MOVES · ALL TIME" />
                  </div>
                  <div
                    style={{
                      marginTop: 12, padding: '9px 11px', borderRadius: 10, fontSize: 11.5, lineHeight: 1.5,
                      background: data.money.escrow_balanced ? 'var(--field-bg)' : 'rgba(236,48,19,.12)',
                      color: data.money.escrow_balanced ? 'var(--ink-60)' : 'var(--color-accent-700)',
                      fontWeight: data.money.escrow_balanced ? 400 : 700,
                    }}
                  >
                    {data.money.escrow_balanced
                      ? `Escrow balances: ★${fmt(data.money.escrow_held)} held against ★${fmt(data.money.escrow_committed)} committed by live errands.`
                      : `LEDGER DRIFT — ★${fmt(data.money.escrow_held)} is held but live errands only commit ★${fmt(data.money.escrow_committed)}. Stars have moved without an errand moving. Investigate before anything else.`}
                  </div>
                  {data.money.by_kind.length > 0 && (
                    <div style={{ marginTop: 10, display: 'grid', gap: 4 }}>
                      {data.money.by_kind.map((k) => (
                        <div key={k.kind} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, padding: '3px 0' }}>
                          <span style={{ color: 'var(--ink-60)' }}>{k.kind}</span>
                          <span style={{ fontWeight: 600 }}>{fmt(k.n)} moves · ★{fmt(k.volume)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>

                <Panel in="activity"
                  title="ERRANDS"
                  summary={`${fmt(data.errands.live)} live · ★${fmt(data.errands.bounties_paid)} paid out${data.errands.disputed ? ` · ${data.errands.disputed} disputed` : ''}`}
                  defaultOpen={data.errands.disputed > 0}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
                    <Stat n={fmt(data.errands.open)} label="ON THE BOARD" />
                    <Stat n={fmt(data.errands.live)} label="IN FLIGHT" />
                    <Stat n={fmt(data.errands.disputed)} label="DISPUTED" accent={data.errands.disputed > 0} />
                    <Stat n={`★${fmt(data.errands.bounties_paid)}`} label="BOUNTIES PAID" />
                  </div>
                  {data.errands.recent.length > 0 && (
                    <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
                      {data.errands.recent.map((e) => (
                        <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, padding: '4px 0', borderBottom: '1px solid var(--ink-08)' }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</div>
                            <div style={{ color: 'var(--ink-40)', fontSize: 10.5 }}>
                              {e.poster ?? '—'}{e.runner ? ` → ${e.runner}` : ''} · {e.state}{e.place ? ` · ${e.place}` : ''}
                            </div>
                          </div>
                          <div style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>★{fmt(e.bounty)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>

                <Panel in="money" title="LIVE TABS" summary={`${fmt(data.tabs.open)} open · ★${fmt(data.tabs.settled_value)} settled`}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
                    <Stat n={fmt(data.tabs.open)} label="OPEN NOW" />
                    <Stat n={fmt(data.tabs.all_time)} label="ALL TIME" />
                    <Stat n={`★${fmt(data.tabs.on_open_tabs)}`} label="ON OPEN TABS" />
                    <Stat n={`★${fmt(data.tabs.settled_value)}`} label="SETTLED BETWEEN PEOPLE" />
                  </div>
                </Panel>

                <Panel in="system"
                  title="REACH"
                  summary={`${fmt(data.reach.push_subscriptions)} devices · ${data.reach.delivery_rate == null ? 'nothing sent yet' : `${Math.round(data.reach.delivery_rate * 100)}% delivered`}`}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
                    <Stat n={fmt(data.reach.push_subscriptions)} label="DEVICES SUBSCRIBED" />
                    <Stat n={fmt(data.reach.push_dead)} label="DEAD SUBS" accent={data.reach.push_dead > 0} />
                    <Stat n={fmt(data.reach.notifications_queued)} label="QUEUED" />
                    <Stat n={fmt(data.reach.notifications_delivered)} label="DELIVERED" />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 10, lineHeight: 1.5 }}>
                    Queued but undelivered means the wake-ups aren’t landing — everything else can look healthy while nobody hears from Num.
                  </div>
                </Panel>

                {/* Read from the same predicates the code paths use, so this
                    cannot drift from what is really switched on. */}
                <Panel in="system" title="RAILS" summary={`${Object.values(data.rails).filter((v) => v === true).length} connected`} defaultOpen>
                  <div style={{ display: 'grid', gap: 5, marginTop: 10 }}>
                    {Object.entries(data.rails).map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '4px 0' }}>
                        <span style={{ color: 'var(--ink-60)' }}>{k.replace(/_/g, ' ')}</span>
                        <span style={{ fontWeight: 700, color: v === true ? '#1f7a48' : v === false ? 'var(--ink-40)' : 'var(--ink)' }}>
                          {v === true ? 'connected' : v === false ? 'not connected' : String(v ?? '—')}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 10, lineHeight: 1.5 }}>
                    Partners: {fmt(data.partners.air_calls)} AiR calls ({fmt(data.partners.air_failed)} failed) · {fmt(data.partners.sabre_operations)} Sabre booking ops ({fmt(data.partners.sabre_failed)} failed).
                  </div>
                </Panel>

                <Panel in="activity" title="ASKED FOR, COULDN'T DO" summary={`${data.product.open_feature_requests} open`} defaultOpen>
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
                  <Panel in="people" title="REFERRALS" summary={`${data.app.referrals.length} codes`}>
                    {data.app.referrals.map((r) => (
                      <Row key={r.code} left={<>{r.code} <span style={{ color: 'var(--ink-40)' }}>{r.owner_type}</span></>} right={`${r.joined} joined`} />
                    ))}
                  </Panel>
                )}
              </TabCtx.Provider>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
