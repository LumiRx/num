// YOU — the profile. Three layers, deliberately separated:
//
//   1. IDENTITY — picture, name, number. The name is frozen once the number is
//      verified, because it is what a friend sees next to a proved number.
//   2. TRAVEL — loyalty programmes and seat/room habits, so a recommendation
//      can weigh status instead of only price.
//   3. TASTE — the things that make a recommendation right for this person.
//
// Everything past identity is optional and says why it helps. A profile form
// with no stated payoff is a form nobody fills in.
import { useEffect, useRef, useState } from 'react';
import { store, useApp } from '../../lib/store';
import { pressable } from '../../lib/a11y';
import { saveProfile, uploadAvatar } from '../../lib/profile';
import { REACTIONS } from '../../lib/prefs';
import { CameraIcon, CheckIcon, ChevronRightIcon, SparklesIcon, UsersIcon } from '../../lib/icons';
import { THEMES, setTheme } from '../../lib/themes';
import QrCard from './QrCard';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };
const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };
const field: React.CSSProperties = {
  width: '100%', height: 42, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 13px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};

/** key, label, placeholder, why it helps — the "why" is the whole point. */
const TRAVEL_FIELDS: Array<[string, string, string, string]> = [
  ['airline_status', 'Airline status', 'e.g. Delta Platinum, Star Alliance Gold', 'Num weighs status against price instead of just picking the cheapest'],
  ['hotel_status', 'Hotel programme', 'e.g. Marriott Titanium, Hyatt Globalist', 'gets you the upgrade you already earned'],
  ['seat', 'Seat', 'aisle / window / bulkhead', 'so a flight suggestion already fits you'],
  ['home_airport', 'Home airport', 'e.g. LAX, BKK', 'the default origin for every fare search'],
  ['passport', 'Passport country', 'e.g. United States', 'drives the visa line in a trip check — never stored as a number'],
];

const TASTE_FIELDS: Array<[string, string, string, string]> = [
  ['home_city', 'Home city', 'where you live', 'so Num knows what is exotic to you and what is Tuesday'],
  ['dietary', 'Dietary', 'vegetarian, halal, no shellfish…', 'never books you somewhere you cannot eat'],
  ['allergies', 'Allergies', 'anything serious', 'flagged to the kitchen when Num books'],
  ['budget', 'Usual spend', 'e.g. mid-range, no ceiling on food', 'stops every suggestion landing in the wrong bracket'],
  ['vibe', 'Your kind of night', 'quiet counter / big table / dancing', 'the single most useful thing you can tell Num'],
  ['work', 'What you do', 'optional', 'context for meetings and introductions'],
  ['notes', 'Anything else', 'the things a good concierge would remember', 'goes straight into what Num knows about you'],
];

/**
 * Everything on this screen collapses. Fifteen fields and eight colour tiles
 * open at once is a wall, and a wall is a screen people close — so each block
 * states what it is, how much is in it, and opens only when asked for.
 */
function Collapsible({ title, summary, defaultOpen = false, children }: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass" style={card}>
      <div
        {...pressable(() => setOpen((v) => !v))}
        aria-expanded={open}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={kicker}>{title}</div>
          {summary && <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 3, lineHeight: 1.45 }}>{summary}</div>}
        </div>
        <ChevronRightIcon
          size={15}
          style={{ color: 'var(--ink-40)', flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}
        />
      </div>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

function Section({ title, summary, fields, values, onChange }: {
  title: string;
  summary: string;
  fields: Array<[string, string, string, string]>;
  values: Record<string, string>;
  onChange: (k: string, v: string) => void;
}) {
  const filled = fields.filter(([k]) => (values[k] ?? '').trim()).length;
  return (
    <Collapsible title={title} summary={filled ? `${filled} of ${fields.length} filled in` : summary}>
      <div style={{ display: 'grid', gap: 12 }}>
        {fields.map(([key, label, placeholder, why]) => (
          <div key={key}>
            <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>{label}</div>
            <input style={field} placeholder={placeholder} value={values[key] ?? ''} onChange={(e) => onChange(key, e.target.value)} />
            <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 4, lineHeight: 1.45 }}>{why}</div>
          </div>
        ))}
      </div>
    </Collapsible>
  );
}

export default function ProfileView() {
  const me = useApp((s) => s.me);
  const profile = useApp((s) => s.profile);
  const style = useApp((s) => s.style);
  const friends = useApp((s) => s.friends.filter((f) => f.state === 'active').length);
  // MUST stay above the `!me` early return below: a hook called conditionally
  // changes the hook count the moment an account appears mid-session, which is
  // React error #310 and a blank screen.
  const reactionCount = Object.keys(useApp((s) => s.reactions)).length;
  const fileRef = useRef<HTMLInputElement>(null);

  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    // The AI's own KNOWN FACTS and the fields the user typed are the same
    // store — whichever learned a fact first, the other one shows it.
    setValues({ ...(me?.bio ?? {}), ...profile });
    setName(me?.name ?? '');
  }, [me?.id]);

  if (!me) {
    return (
      <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 96 }}>
        <div className="glass" style={{ ...card, marginTop: 16 }}>
          <div style={kicker}>YOUR PROFILE</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>Nothing here yet</div>
          <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 6, lineHeight: 1.55 }}>
            Add your name and number and this becomes the place Num learns who you are — how you travel, what you eat, the kind of night you actually want.
          </div>
          <div
            {...pressable(() => store.set({ inviteOpen: {} }))}
            style={{ cursor: 'pointer', marginTop: 14, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '12px 16px', textAlign: 'center' }}
          >
            ADD MY NAME &amp; NUMBER
          </div>
        </div>
      </div>
    );
  }

  const change = (k: string, v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  };

  const save = async () => {
    try {
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
      await saveProfile({ name: me.name_locked ? undefined : name.trim() || undefined, bio: filled });
      setSaved(true);
      setNote(null);
      setTimeout(() => setSaved(false), 2600);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Couldn’t save that.');
    }
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      await uploadAvatar(file);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'That image didn’t take.');
    }
  };

  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 110 }}>
      {/* identity */}
      <div className="glass" style={{ ...card, display: 'flex', gap: 13, alignItems: 'center' }}>
        <div
          {...pressable(() => fileRef.current?.click())}
          aria-label="Change profile picture"
          style={{
            cursor: 'pointer', width: 62, height: 62, borderRadius: 999, flex: 'none', position: 'relative',
            background: me.avatar ? `center/cover url(${me.avatar})` : 'var(--grad-accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
            fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22,
            boxShadow: '0 6px 18px rgba(236,48,19,.25)',
          }}
        >
          {!me.avatar && (me.name?.[0]?.toUpperCase() ?? '?')}
          <span style={{ position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: 999, background: '#fff', color: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,.18)' }}>
            <CameraIcon size={12} />
          </span>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void pickPhoto(e.target.files?.[0])} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={kicker}>YOU</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, marginTop: 2 }}>{me.name ?? 'Traveller'}</div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 3, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {me.phone ?? 'no number'}
            <span
              style={{
                fontSize: 9, fontWeight: 800, letterSpacing: '.08em', padding: '3px 7px', borderRadius: 999,
                background: me.phone_verified ? 'rgba(22,140,90,.14)' : 'rgba(32,30,29,.07)',
                color: me.phone_verified ? '#0e6b45' : 'var(--ink-60)',
                display: 'inline-flex', gap: 3, alignItems: 'center',
              }}
            >
              {me.phone_verified && <CheckIcon size={9} />}
              {me.phone_verified ? 'VERIFIED' : 'UNVERIFIED'}
            </span>
            {friends > 0 && (
              <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <UsersIcon size={11} /> {friends} connected
              </span>
            )}
          </div>
        </div>
      </div>

      <Collapsible title="NAME ON THE ACCOUNT" summary={me.name_locked ? 'Locked to your verified number' : 'What friends see when you connect'}>
        <input
          style={{ ...field, opacity: me.name_locked ? 0.6 : 1 }}
          value={name}
          disabled={me.name_locked}
          onChange={(e) => { setName(e.target.value); setSaved(false); }}
          placeholder="Your name"
        />
        <div style={{ fontSize: 10.5, color: 'var(--ink-40)', marginTop: 6, lineHeight: 1.5 }}>
          {me.name_locked
            ? 'Locked to your verified number — this is what friends see next to it, so changing it goes through us. Ask Num and we’ll sort it.'
            : 'This is the name on your invites and what friends see when you connect. Once your number is verified it’s locked to it.'}
        </div>
      </Collapsible>

      <Collapsible title="YOUR CODES" summary="Scan to connect, or to pay you in Stars" defaultOpen>
        <QrCard />
      </Collapsible>

      <ThemePicker />

      <Section title="HOW YOU TRAVEL" summary="Status, seat, home airport — so a fare search already fits you" fields={TRAVEL_FIELDS} values={values} onChange={change} />
      <Section title="SO NUM GETS YOU RIGHT" summary="Diet, budget, the kind of night you actually want" fields={TASTE_FIELDS} values={values} onChange={change} />

      {/* what Num has worked out on its own */}
      <Collapsible
        title="WHAT NUM HAS PICKED UP"
        summary={reactionCount ? `${reactionCount} reaction${reactionCount === 1 ? '' : 's'} so far` : 'Nothing learned yet'}
      >
        {reactionCount === 0 && !Object.keys(style).length ? (
          <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 6, lineHeight: 1.55 }}>
            Nothing yet. React to Num’s suggestions with {REACTIONS.map((r) => r.emoji).join(' ')} and it learns what to send you and what to drop.
          </div>
        ) : (
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {style.length === 'short' && <Line>Keeps replies short for you.</Line>}
            {style.length === 'long' && <Line>Gives you the reasoning, not just the answer.</Line>}
            {style.decisiveness === 'one' && <Line>One pick, no menus.</Line>}
            {style.decisiveness === 'options' && <Line>Offers a couple of options with a house pick.</Line>}
            {style.emoji === 'no' && <Line>No emoji in replies.</Line>}
            {!!style.loved?.length && <Line>More like: {style.loved.slice(-3).join(', ')}</Line>}
            {!!style.rejected?.length && <Line>Never again: {style.rejected.slice(-3).join(', ')}</Line>}
            <div
              {...pressable(() => store.set({ style: {}, reactions: {} }))}
              style={{ cursor: 'pointer', fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', color: 'var(--color-accent-700)', marginTop: 4 }}
            >
              RESET WHAT NUM LEARNED
            </div>
          </div>
        )}
      </Collapsible>

      {/* business tools, only if they have one */}
      <div
        {...pressable(() => store.set({ businessOpen: true }))}
        className="glass lift"
        style={{ ...card, cursor: 'pointer', display: 'flex', gap: 11, alignItems: 'center' }}
      >
        <div style={{ width: 30, height: 30, borderRadius: 999, flex: 'none', background: 'var(--field-bg)', border: '1px solid var(--ink-08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <SparklesIcon size={15} style={{ color: 'var(--color-accent)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={kicker}>BUSINESS</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, marginTop: 3 }}>Own a place on Num?</div>
          <div style={{ fontSize: 11, color: 'var(--ink-60)', marginTop: 2 }}>Claim your listing and get the owner tools</div>
        </div>
        <ChevronRightIcon size={15} style={{ color: 'var(--ink-40)' }} />
      </div>

      <div style={{ padding: '4px 12px 0' }}>
        <div
          {...pressable(save)}
          style={{ cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center', boxShadow: '0 4px 14px rgba(236,48,19,.3)' }}
        >
          {saved ? 'SAVED — NUM KNOWS' : 'SAVE MY PROFILE'}
        </div>
        {note && <div style={{ fontSize: 10.5, color: 'var(--color-accent-700)', marginTop: 8, textAlign: 'center' }}>{note}</div>}
      </div>
    </div>
  );
}

/**
 * The colour picker. A theme is a token override, so the preview is honest —
 * those three swatches are literally the page background, the accent and the
 * aurora the theme will use.
 */
function ThemePicker() {
  const current = useApp((s) => s.theme);
  const name = THEMES.find((t) => t.id === current)?.name ?? 'Ember';
  return (
    <Collapsible title="COLOUR" summary={`${name} — tap to change`}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {THEMES.map((t) => {
          const on = current === t.id;
          return (
            <div
              key={t.id}
              {...pressable(() => setTheme(t.id))}
              aria-pressed={on}
              style={{
                cursor: 'pointer', borderRadius: 14, padding: 10,
                border: '1.5px solid ' + (on ? 'var(--color-accent)' : 'var(--ink-08)'),
                background: 'var(--field-bg)',
              }}
            >
              <div style={{ display: 'flex', gap: 4, marginBottom: 7 }}>
                {t.swatch.map((c, i) => (
                  <span key={i} style={{ width: 18, height: 18, borderRadius: 999, background: c, border: '1px solid var(--ink-08)' }} />
                ))}
                {on && <CheckIcon size={13} style={{ marginLeft: 'auto', color: 'var(--color-accent)' }} />}
              </div>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{t.name}</div>
              <div style={{ fontSize: 10, color: 'var(--ink-40)', lineHeight: 1.4, marginTop: 2 }}>{t.blurb}</div>
            </div>
          );
        })}
      </div>
    </Collapsible>
  );
}

const Line = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11.5, color: 'var(--ink)', lineHeight: 1.5 }}>· {children}</div>
);
