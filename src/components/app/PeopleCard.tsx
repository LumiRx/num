// YOUR PEOPLE — and the way out.
//
// Removing someone is a two-tap action behind a per-row disclosure, never a
// button sitting next to a name. An accidental unfriend is not recoverable by
// the person who did it: they have to ask to be re-added, which is the exact
// conversation they were trying to avoid.
//
// The block checkbox is offered at the moment of removal because that is the
// only moment the distinction is live in someone's head. Buried in settings it
// would be found by nobody who needed it.
import { useState } from 'react';
import { useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { unfriend } from '../../lib/social';
import { UsersIcon } from '../../lib/icons';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };

export default function PeopleCard() {
  // A pending row has no member id yet — there is nothing to remove, and
  // offering the control would fail silently at the tap.
  const friends = useApp((s) => s.friends.filter((f) => f.state === 'active' && !!f.id));
  const [openId, setOpenId] = useState<string | null>(null);
  const [block, setBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!friends.length) return null;

  const remove = async (id: string) => {
    setBusy(true);
    const msg = await unfriend(id, block);
    setBusy(false);
    setOpenId(null);
    setBlock(false);
    setNote(msg);
    setTimeout(() => setNote(null), 4000);
  };

  return (
    <div className="glass" style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <UsersIcon size={13} style={{ color: 'var(--ink-40)' }} />
        <div style={kicker}>YOUR PEOPLE</div>
        <div style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-40)' }}>{friends.length}</div>
      </div>

      <div style={{ marginTop: 10, display: 'grid', gap: 2 }}>
        {friends.map((f) => {
          const open = openId === f.id;
          return (
            <div key={f.id ?? f.name ?? Math.random()} style={{ borderRadius: 12, background: open ? 'var(--field-bg)' : 'transparent', padding: open ? 10 : 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: open ? 0 : '7px 0' }}>
                <div
                  style={{
                    width: 30, height: 30, borderRadius: 999, flex: 'none', background: 'var(--grad-accent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', fontWeight: 800, fontSize: 13, fontFamily: 'var(--font-heading)',
                  }}
                >
                  {f.name?.[0]?.toUpperCase() ?? '?'}
                </div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.name ?? 'Someone'}
                </div>
                <div
                  {...pressable(() => { setOpenId(open ? null : f.id ?? null); setBlock(false); })}
                  aria-label={open ? 'Close' : `Options for ${f.name ?? 'this person'}`}
                  style={{ cursor: 'pointer', fontSize: 15, letterSpacing: 1, color: 'var(--ink-40)', padding: '0 4px' }}
                >
                  {open ? '×' : '···'}
                </div>
              </div>

              {open && (
                <div style={{ marginTop: 10 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 11, color: 'var(--ink-60)', lineHeight: 1.5 }}>
                    <input
                      type="checkbox"
                      checked={block}
                      onChange={(e) => setBlock(e.target.checked)}
                      style={{ marginTop: 2, accentColor: 'var(--color-accent)' }}
                    />
                    <span>
                      <b style={{ color: 'var(--ink)' }}>Also block them.</b> Without this they can add you
                      straight back — by link or by scanning your code.
                    </span>
                  </label>
                  <div
                    {...pressable(() => { if (!busy && f.id) void remove(f.id); })}
                    style={{
                      cursor: 'pointer', marginTop: 10, borderRadius: 999, padding: '10px 14px', textAlign: 'center',
                      border: '1.5px solid rgba(190,40,30,.35)', color: '#a3271c',
                      fontWeight: 800, fontSize: 11, letterSpacing: '.06em', opacity: busy ? 0.5 : 1,
                    }}
                  >
                    {busy ? 'REMOVING…' : block ? 'REMOVE AND BLOCK' : 'REMOVE'}
                  </div>
                  {/* Said plainly so nobody removes someone expecting it to
                      land as a message. */}
                  <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 7, lineHeight: 1.45, textAlign: 'center' }}>
                    They aren’t told.
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {note && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--ink-60)', lineHeight: 1.5 }}>{note}</div>
      )}
    </div>
  );
}
