// LEAVING FOR GOOD.
//
// Three deliberate frictions, each earning its place:
//
//   1. It is collapsed. Nobody deletes an account by scrolling.
//   2. The first tap shows the INVENTORY — the actual count of Stars, friends,
//      plans and messages about to go. "Are you sure?" asks a question the
//      person cannot answer; a list of what they'd lose is answerable.
//   3. They type DELETE. Not to be obstructive — to make the last action
//      deliberate rather than muscle memory.
//
// And the server refuses outright while they hold Stars or stand in a live
// errand or open tab, because deleting then destroys their own money or
// strands somebody who is waiting on them.
import { useState } from 'react';
import { useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { deleteAccount } from '../../lib/social';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };

type Look = {
  inventory?: Record<string, number>;
  blockers?: string[];
  // What the member permanently gives up by leaving — a Stars balance, today.
  // Shown and acknowledged, NEVER used to refuse: see the note in
  // worker/account.mjs. Holding Stars used to make deletion impossible.
  forfeits?: string[];
  can_delete?: boolean;
  note?: string;
};

const LABEL: Record<string, (n: number) => string> = {
  stars: (n) => `★${n.toLocaleString()}`,
  friends: (n) => `${n} connection${n === 1 ? '' : 's'}`,
  plans_owned: (n) => `${n} plan${n === 1 ? '' : 's'} you made`,
  plans_joined: (n) => `${n} plan${n === 1 ? '' : 's'} you joined`,
  messages: (n) => `${n} message${n === 1 ? '' : 's'} with Num`,
  live_errands: (n) => `${n} live errand${n === 1 ? '' : 's'}`,
  open_tabs: (n) => `${n} open tab${n === 1 ? '' : 's'}`,
};

export default function DangerZone() {
  const me = useApp((s) => s.me);
  const [stage, setStage] = useState<'shut' | 'look' | 'confirm'>('shut');
  const [look, setLook] = useState<Look | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!me) return null;

  const inspect = async () => {
    setBusy(true);
    const out = await deleteAccount(false);
    setBusy(false);
    if (!out) { setNote('Couldn’t reach Num just now.'); return; }
    setLook(out);
    setStage('look');
  };

  const destroy = async () => {
    if (typed.trim().toUpperCase() !== 'DELETE') return;
    setBusy(true);
    const out = await deleteAccount(true);
    setBusy(false);
    // On success the helper wipes local storage and reloads, so anything
    // rendered after this point means it did not happen.
    // A refusal must say what to do about it. `note` is absent on the 409
    // blocked response, so falling straight to a shrug told the member
    // nothing — which is how a working guard reads as a broken button.
    if (out && !out.ok) {
      setNote(out.blockers?.length ? out.blockers.join(' ') : (out.note ?? 'That didn’t go through.'));
      if (out.blockers?.length) setLook({ ...(look ?? {}), ...out, can_delete: false });
    }
    if (!out) setNote('Couldn’t reach Num just now. Nothing was deleted.');
  };

  if (stage === 'shut') {
    // GUIDELINE 5.1.1(v). App Review rejected 1.0(2) saying the app "does not
    // include an option to initiate account deletion". It did — this control,
    // and POST /api/account/delete behind it. What it did not do was LOOK like
    // one: 10.5px, `--ink-40`, no border, at the foot of a long scroll, under
    // a screen the reviewer's device crashed on before reaching.
    //
    // "It exists" is not the bar. A control a reviewer cannot find is one a
    // user cannot find, and the guideline is about users being able to leave.
    // So it is now a legible, labelled row that says what it does — still
    // quiet, still last, still two confirmations away from destroying
    // anything, but no longer hiding.
    return (
      <div id="delete-account" style={{ ...card, padding: '2px 14px 0' }}>
        <div
          {...pressable(() => { if (!busy) void inspect(); })}
          role="button"
          aria-label="Delete my account"
          style={{
            cursor: 'pointer', padding: '13px 14px', borderRadius: 'var(--r-md, 12px)',
            border: '1px solid rgba(163,39,28,.22)', background: 'rgba(163,39,28,.045)',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}
        >
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#a3271c' }}>
            {busy ? 'Checking…' : 'Delete my account'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', lineHeight: 1.45 }}>
            Permanently erases your account, your thread and everything Num remembers.
          </div>
        </div>
        {note && <div style={{ fontSize: 11, color: '#a3271c', padding: '8px 2px 0' }}>{note}</div>}
      </div>
    );
  }

  const inv = Object.entries(look?.inventory ?? {}).filter(([, n]) => n > 0);
  const blocked = !look?.can_delete;

  return (
    <div className="glass" style={{ ...card, border: '1.5px solid rgba(190,40,30,.28)' }}>
      <div style={{ ...kicker, color: '#a3271c' }}>DELETE YOUR ACCOUNT</div>

      {inv.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 8, lineHeight: 1.55 }}>
          There’s nothing stored against this account yet — deleting it removes it and nothing else.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 8, lineHeight: 1.55 }}>
            This goes, permanently:
          </div>
          <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
            {inv.map(([k, n]) => (
              <div key={k} style={{ fontSize: 12, color: 'var(--ink)' }}>· {(LABEL[k] ?? ((x: number) => `${x} ${k}`))(n)}</div>
            ))}
          </div>
        </>
      )}

      {/* What they lose by leaving. Always shown when present, on the same
          screen as the confirmation, so nobody discovers it afterwards. */}
      {!!(look?.forfeits ?? []).length && (
        <div style={{ marginTop: 12, borderRadius: 12, background: 'var(--field-bg)', padding: 11 }}>
          {(look?.forfeits ?? []).map((f) => (
            <div key={f} style={{ fontSize: 11.5, color: 'var(--ink)', lineHeight: 1.5 }}>· {f}</div>
          ))}
        </div>
      )}

      {blocked ? (
        <div style={{ marginTop: 12, borderRadius: 12, background: 'var(--field-bg)', padding: 11 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 5 }}>Not yet — finish these first:</div>
          {(look?.blockers ?? []).map((b) => (
            <div key={b} style={{ fontSize: 11.5, color: 'var(--ink-60)', lineHeight: 1.5 }}>· {b}</div>
          ))}
          <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 7, lineHeight: 1.5 }}>
            Deleting now would burn what you’re holding or leave someone waiting on you.
          </div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 12, lineHeight: 1.5 }}>
            There’s no undo and no export. Type <b style={{ color: 'var(--ink)' }}>DELETE</b> to confirm.
          </div>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="DELETE"
            autoCapitalize="characters"
            style={{
              width: '100%', height: 42, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 13px',
              fontSize: 16, background: 'var(--field-bg)', outline: 'none', marginTop: 8,
              fontFamily: 'var(--font-body)', color: 'var(--color-text)', letterSpacing: '.1em',
            }}
          />
          <div
            {...pressable(() => { if (!busy) void destroy(); })}
            aria-disabled={typed.trim().toUpperCase() !== 'DELETE'}
            style={{
              cursor: 'pointer', marginTop: 10, borderRadius: 999, padding: '12px 16px', textAlign: 'center',
              background: typed.trim().toUpperCase() === 'DELETE' ? '#a3271c' : 'var(--ink-08)',
              color: typed.trim().toUpperCase() === 'DELETE' ? '#fff' : 'var(--ink-40)',
              fontWeight: 800, fontSize: 11.5, letterSpacing: '.06em', opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'DELETING…' : 'DELETE EVERYTHING'}
          </div>
        </>
      )}

      <div
        {...pressable(() => { setStage('shut'); setTyped(''); setNote(null); })}
        style={{ cursor: 'pointer', marginTop: 10, textAlign: 'center', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--ink-40)' }}
      >
        KEEP MY ACCOUNT
      </div>

      {note && <div style={{ marginTop: 9, fontSize: 11.5, color: '#a3271c', lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}
