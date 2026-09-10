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
import { checkForUpdate, versionLine } from '../../lib/version';
import QrCard from './QrCard';
import Verify5arz from './Verify5arz';
import AppleSignIn from './AppleSignIn';
import PairBridge from './PairBridge';
import PeopleCard from './PeopleCard';
import MembershipCard from './MembershipCard';
import DangerZone from './DangerZone';
import { disablePush, enablePush, pushState } from '../../lib/push';
import { apiUrl } from '../../lib/apibase';
import { guestMessage } from '../../lib/saferr';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };

/**
 * ELEVEN IDENTICAL SQUARES IS NOT A PAGE.
 *
 * Dre, 10 Sep 2026: "lets organize the home profile page its a bunch of ugly
 * squares." He was right — every block used the same glass card, the same
 * margin and the same radius, in one unbroken column, so nothing looked more
 * or less important than anything else and the eye had nowhere to rest.
 *
 * The cards are unchanged. What was missing was RHYTHM: a quiet label every
 * few blocks that says what the next group is for. Grouping is cheaper than
 * redesigning and it is what actually makes a long settings page readable.
 */
const Group = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      margin: '26px 22px 6px', fontSize: 10, letterSpacing: '.16em',
      fontWeight: 800, color: 'var(--ink-40)',
    }}
  >
    {children}
  </div>
);
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
            INTRODUCE YOURSELF
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
      setNote(guestMessage(err, 'Couldn’t save that.'));
    }
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      await uploadAvatar(file);
    } catch (err) {
      setNote(guestMessage(err, 'That image didn’t take.'));
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
          {/* The picker this opens offers "Take Photo", which touches the
              camera — so Info.plist MUST carry NSCameraUsageDescription.
              Without it iOS terminates the process the instant the sheet
              appears (TCC SIGABRT), which is exactly how 1.0(2) crashed in
              review on an iPad. The key is in ios/App/App/Info.plist; do not
              remove it, and do not add another media input without checking
              the matching usage description exists. */}
          {/* NOT `hidden`, AND THAT IS THE WHOLE POINT ON iPad.
              On iPhone WKWebView shows the media picker as a sheet, which
              needs no anchor. On iPad it shows a POPOVER, anchored to the
              input's own rect — and `hidden` is display:none, so the rect is
              zero and there is nothing to anchor to. That is a second,
              independent iPad-only failure sitting behind the TCC one, on the
              exact device class review used (iPad Air 11-inch M3).
              So the input stays laid out and merely invisible: it covers the
              avatar, is transparent, and gives iOS a real rectangle. Do not
              put `hidden` or display:none back on it. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            aria-hidden="true"
            tabIndex={-1}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              opacity: 0, pointerEvents: 'none', border: 0, padding: 0,
            }}
            onChange={(e) => void pickPhoto(e.target.files?.[0])}
          />
        </div>
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
      {/* Its own block UNDER the identity row. As a third flex child it was
          being squeezed into the name column and printing over "Dre". */}
      <AppleSignIn />

      {/* FINDING IT IS THE FEATURE.
          Account deletion has worked since August and sits at the very bottom
          of a long profile, so in practice nobody reached it — Apple's
          reviewer reported it missing (5.1.1(v), 30 Aug 2026) and on 9 Sep
          Dre could not find it either, in his own app.
          A destructive action should be quiet, not hidden. The button stays
          exactly where it is, with all three of its frictions; this is a
          signpost to it, near the top, where someone looking for it looks.
          Apple's rule is that deletion must be discoverable in-app — a
          feature nobody can navigate to does not satisfy it. */}
      <div
        {...pressable(() => {
          document.getElementById('delete-account')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        })}
        role="button"
        aria-label="Go to delete my account"
        className="glass lift"
        style={{
          margin: '2px 12px 0', padding: '11px 14px', borderRadius: 'var(--r-md, 12px)',
          cursor: 'pointer', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 10, minHeight: 44,
          background: 'transparent', border: '1px solid var(--line, rgba(0,0,0,.08))',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-60)' }}>
          Account &amp; data · delete my account
        </div>
        <ChevronRightIcon size={16} />
      </div>
      <Verify5arz />
      {/* Finish a connection that opened in the browser instead of the app. */}
      <PairBridge installed />

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

      <MembershipCard />

      <PeopleCard />

      <HostCard />

      <ThemePicker />

      <NotificationsCard />

      <Group>TRAVEL</Group>
      <Section title="HOW YOU TRAVEL" summary="Status, seat, home airport — so a fare search already fits you" fields={TRAVEL_FIELDS} values={values} onChange={change} />

      {/* Passenger details live behind their own sheet rather than inline with
          the preference fields above, because they are a different KIND of
          thing: everything in HOW YOU TRAVEL is a hint that makes an answer
          better, and this is the legal identity an airline checks at the gate.
          Mixing them would imply the same casualness applies to both. */}
      <div
        {...pressable(() => store.set({ passengerOpen: true }))}
        className="glass"
        style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={kicker}>PASSENGER DETAILS</div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-60)', marginTop: 5, lineHeight: 1.5 }}>
            The passport name and date of birth an airline needs before it will issue a ticket. Only used for
            booking, never shown to the concierge.
          </div>
        </div>
        <ChevronRightIcon size={16} style={{ color: 'var(--ink-40)', flex: 'none' }} />
      </div>
      <Group>TASTE</Group>
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

      <Group>ACCOUNT</Group>
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

      <DangerZone />

      <VersionLine />

      <SourcesLine />

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
 * Notifications, asked for at the right moment and never before.
 *
 * The iPhone rule is the one that shapes this: Safari only allows push for a
 * PWA that has been added to the home screen, and the permission prompt is
 * one-shot — a "no" is permanent. So this is a card the user chooses to tap,
 * not a prompt on launch, and on an un-installed iPhone it says what to do
 * rather than burning the one ask on a browser that cannot deliver.
 */
function NotificationsCard() {
  const on = useApp((s) => s.pushOn);
  const me = useApp((s) => s.me);
  const [state, setState] = useState(() => pushState());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // display-mode changes when they add it to the home screen and reopen.
  useEffect(() => setState(pushState()), [me?.id]);

  const blurb =
    state === 'unsupported'
      ? 'This browser can’t do notifications — everything still waits for you in the app.'
      : state === 'needs-install'
        ? 'Add Num to your home screen first: tap Share, then “Add to Home Screen”. iPhone only allows notifications for installed apps.'
        : state === 'denied'
          ? 'Notifications are blocked in your browser settings. Turn them back on there and Num can reach you again.'
          : on
            ? 'On. Num will tell you when a table moves, a friend answers, or a plan changes — and nothing else.'
            : 'A table that moved, a friend who said yes, a flight that shifted. Only the things you’d want interrupting you.';

  const toggle = async () => {
    setBusy(true);
    if (on) {
      await disablePush();
      setMsg('Off — you’ll still see everything next time you open Num.');
    } else {
      const out = await enablePush();
      setMsg(out.message);
      setState(pushState());
    }
    setBusy(false);
  };

  const actionable = state === 'default' || state === 'granted';

  return (
    <div className="glass" style={{ ...card }}>
      <div style={kicker}>NOTIFICATIONS</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, marginTop: 4 }}>
        {on ? 'Num can reach you' : 'Let Num reach you'}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.55 }}>{blurb}</div>
      {actionable && (
        <div
          {...pressable(toggle)}
          style={{
            cursor: 'pointer', marginTop: 11, borderRadius: 999, padding: '11px 16px', textAlign: 'center',
            fontWeight: 700, fontSize: 11.5, letterSpacing: '.06em', opacity: busy ? 0.55 : 1,
            ...(on
              ? { background: 'transparent', color: 'var(--ink-60)', border: '1px solid var(--ink-12)' }
              : { background: 'var(--grad-accent)', color: '#fff' }),
          }}
        >
          {busy ? 'ONE MOMENT…' : on ? 'TURN THEM OFF' : 'TURN ON NOTIFICATIONS'}
        </div>
      )}
      {msg && <div style={{ fontSize: 10.5, color: 'var(--ink-60)', marginTop: 8, lineHeight: 1.5 }}>{msg}</div>}
    </div>
  );
}

/**
 * Your VIP host, if you have one. Until 4 Sep 2026 the app had no host
 * surface at all: a member could not discover that hosts exist, and a member
 * who HAD a host saw nothing about them here. The server decides who your
 * host is (worker/hostaware.mjs, matched on your verified number); this only
 * shows it, with the two links that matter — their page and their calendar
 * feed of what they have confirmed for you — or, with no host, where to find
 * one. Nothing here sends anything.
 */
interface MyHost {
  host: { name: string; services: string[]; since: string | null } | null;
  page?: string | null;
  calendar?: string | null;
  find?: string | null;
}
const SERVICE_WORDS: Record<string, string> = {
  car: 'cars', reservation: 'tables', stay: 'stays', activity: 'activities', appointment: 'appointments', delivery: 'deliveries',
};
function HostCard() {
  const me = useApp((s) => s.me);
  const [mine, setMine] = useState<MyHost | null>(null);
  useEffect(() => {
    if (!me?.id) { setMine(null); return; }
    let live = true;
    fetch(`${apiUrl('/api/host/mine')}?me=${encodeURIComponent(me.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: MyHost | null) => { if (live) setMine(j); })
      .catch(() => { if (live) setMine(null); });
    return () => { live = false; };
  }, [me?.id]);
  if (!me?.id || !mine) return null;
  const link: React.CSSProperties = {
    display: 'inline-block', marginTop: 10, marginRight: 8, borderRadius: 999, padding: '9px 14px', textDecoration: 'none',
    fontWeight: 700, fontSize: 11, letterSpacing: '.06em', color: 'var(--ink)', border: '1px solid var(--ink-12)',
  };
  if (!mine.host) {
    return (
      <div className="glass" style={{ ...card }}>
        <div style={kicker}>A PERSON, NOT JUST AN APP</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, marginTop: 4 }}>Want a VIP host?</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.55 }}>
          A real concierge who knows the city and knows you. Num does the finding; your host does the arranging, in person.
        </div>
        {mine.find && <a href={mine.find} target="_blank" rel="noreferrer" style={link}>FIND A HOST NEAR YOU</a>}
      </div>
    );
  }
  const does = mine.host.services.map((k) => SERVICE_WORDS[k] ?? k).join(', ');
  return (
    <div className="glass" style={{ ...card }}>
      <div style={kicker}>YOUR HOST</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, marginTop: 4 }}>{mine.host.name}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.55 }}>
        {does ? `Arranges ${does} for you.` : 'Arranges things for you, in person.'} Ask Num for any of it and say “send it to {mine.host.name}” — it lands in their console, and they confirm with you directly.
      </div>
      {mine.page && <a href={mine.page} target="_blank" rel="noreferrer" style={link}>MY HOST PAGE</a>}
      {mine.calendar && <a href={mine.calendar.replace(/^https?:/, 'webcal:')} style={link}>SUBSCRIBE TO THEIR BOOKINGS</a>}
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

/**
 * Which build this phone is actually running, and a nudge if it is behind.
 * Small, quiet, and the single fastest way to answer "why am I seeing the old
 * copy?" — which is otherwise pure guesswork.
 */
function VersionLine() {
  const [stale, setStale] = useState<string | null>(null);
  useEffect(() => {
    void checkForUpdate().then((r) => r?.stale && setStale(r.server));
  }, []);
  return (
    <div style={{ padding: '14px 14px 0', textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: 'var(--ink-40)', letterSpacing: '.04em' }}>Num {versionLine}</div>
      {stale && (
        <div
          {...pressable(() => {
            void navigator.serviceWorker?.getRegistration().then((r) => r?.update());
            location.reload();
          })}
          style={{ cursor: 'pointer', marginTop: 8, fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: 'var(--color-accent)' }}
        >
          v{stale} IS OUT — TAP TO UPDATE
        </div>
      )}
    </div>
  );
}

/**
 * Where the places come from.
 *
 * Num's directory is built on OpenStreetMap, which is ODbL-licensed: using the
 * data obliges us to say so wherever it is used. The website already carries
 * this in /privacy and /terms — but a guest inside the app is not reading our
 * privacy page, and the licence follows the data, not the domain. So it lives
 * here too: quiet, permanent, and honest about whose work this is built on.
 */
function SourcesLine() {
  return (
    <div style={{ padding: '8px 14px 0', textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: 'var(--ink-40)', lineHeight: 1.5 }}>
        Places from{' '}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
          style={{ color: 'var(--ink-40)', textDecoration: 'underline' }}
        >
          © OpenStreetMap contributors
        </a>{' '}
        (ODbL), Google, and Num&rsquo;s own verification.
      </div>
    </div>
  );
}

const Line = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11.5, color: 'var(--ink)', lineHeight: 1.5 }}>· {children}</div>
);
