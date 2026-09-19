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
import { TEXT_SIZES, setTextSize } from '../../lib/textsize';
import { checkForUpdate, versionLine } from '../../lib/version';
import QrCard from './QrCard';
import Verify5arz from './Verify5arz';
import AppleSignIn from './AppleSignIn';
import PairBridge from './PairBridge';
import PeopleCard from './PeopleCard';
import DangerZone from './DangerZone';
import IdentityCard from './IdentityCard';
import ContactCard from './ContactCard';
import ConnectionsCard from './ConnectionsCard';
import GiveawaysCard from './GiveawaysCard';
import { disablePush, enablePush, pushState } from '../../lib/push';
import { apiUrl } from '../../lib/apibase';
import { guestMessage } from '../../lib/saferr';
import { T, t, LANGS, isLang, phoneLang, setLang, type Lang } from '../../lib/i18n';

const card: React.CSSProperties = { margin: '10px 12px', borderRadius: 'var(--r-lg)', padding: 14 };

const kicker: React.CSSProperties = { fontSize: 10, letterSpacing: '.14em', fontWeight: 800, color: 'var(--ink-40)' };
const field: React.CSSProperties = {
  width: '100%', height: 42, borderRadius: 12, border: '1px solid var(--ink-12)', padding: '0 13px',
  fontSize: 16, background: 'var(--field-bg)', outline: 'none', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
};

/**
 * key, label, placeholder, why it helps, and — where an answer is usually
 * one of a few — the quick answers as chips. The "why" is the whole point;
 * the chips are so filling this in takes taps, not typing.
 */
type Field = [string, string, string, string, string[]?];

/**
 * ORDER FASTER. What a good concierge asks once and never again: where you
 * are staying, how many of you, when you eat, how you like to get around and
 * pay. Every one of these is a question NUM would otherwise have to ask in
 * the thread before it can act, and every answer here is read on every turn
 * (KNOWN FACTS in worker/prompt.mjs). Card numbers are never asked: payment
 * is a preference here and a Stripe sheet at the moment of paying.
 */
const QUICK_FIELDS: Field[] = [
  ['staying_at', T('Where you are staying'), T('hotel or address'), T('cars and deliveries start from here without asking'), []],
  ['party_size', T('Usually how many of you'), T('e.g. 2'), T('tables and cars sized right first time'), ['1', '2', '3', '4', '6+']],
  ['dinner_time', T('When you like to eat'), T('e.g. 19:30'), T('“dinner tonight” lands at your hour, not a default'), ['18:30', '19:30', '20:30', T('Late')]],
  ['ride_pref', T('How you like to get around'), T('Grab, taxi, private car…'), T('the right car is requested without a follow-up question'), ['Grab', T('Taxi'), T('Private car'), T('Walk / BTS')]],
  ['pay_pref', T('How you usually pay'), T('card, Stars, cash'), T('NUM picks the right payment step when it books'), [T('Card'), T('Stars'), T('Cash')]],
  ['confirm_via', T('Where confirmations should reach you'), T('in the app, WhatsApp, LINE, SMS'), T('so a confirmation never goes to a channel you do not check'), [T('In the app'), 'WhatsApp', T('LINE'), T('SMS')]],
  ['kids', T('Kids with you'), T('ages, or none'), T('tables, menus and times that work for them'), [T('None'), T('Under 5'), T('5–12'), T('Teens')]],
];

/** key, label, placeholder, why it helps — the "why" is the whole point. */
const TRAVEL_FIELDS: Field[] = [
  ['airline_status', T('Airline status'), T('e.g. Delta Platinum, Star Alliance Gold'), T('NUM weighs status against price instead of just picking the cheapest')],
  ['hotel_status', T('Hotel programme'), T('e.g. Marriott Titanium, Hyatt Globalist'), T('gets you the upgrade you already earned')],
  ['seat', T('Seat'), 'aisle / window / bulkhead', T('so a flight suggestion already fits you'), [T('Aisle'), T('Window'), T('Bulkhead')]],
  ['home_airport', T('Home airport'), T('e.g. LAX, BKK'), T('the default origin for every fare search')],
  ['passport', T('Passport country'), T('e.g. United States'), T('drives the visa line in a trip check — never stored as a number')],
];

const TASTE_FIELDS: Field[] = [
  ['home_city', T('Home city'), T('where you live'), T('so NUM knows what is exotic to you and what is Tuesday')],
  ['dietary', T('Dietary'), T('vegetarian, halal, no shellfish…'), T('never books you somewhere you cannot eat'), [T('Vegetarian'), T('Vegan'), T('Halal'), T('No shellfish'), T('No pork')]],
  ['allergies', T('Allergies'), T('anything serious'), T('flagged to the kitchen when NUM books')],
  ['budget', T('Usual spend'), T('e.g. mid-range, no ceiling on food'), T('stops every suggestion landing in the wrong bracket'), [T('Keep it cheap'), 'Mid-range', T('No ceiling on food')]],
  ['vibe', T('Your kind of night'), T('quiet counter / big table / dancing'), T('the single most useful thing you can tell NUM'), [T('Quiet counter'), T('Big table'), T('Dancing'), T('Early night')]],
  ['work', T('What you do'), 'optional', T('context for meetings and introductions')],
  ['notes', T('Anything else'), T('the things a good concierge would remember'), T('goes straight into what NUM knows about you')],
];

/**
 * Everything on this screen collapses. Fifteen fields and eight colour tiles
 * open at once is a wall, and a wall is a screen people close — so each block
 * states what it is, how much is in it, and opens only when asked for.
 */
/**
 * THE REDESIGN (18 Sep 2026, second time): "the profile page is still a
 * disaster and a bunch of blocks."
 *
 * The first remodel kept eleven glass cards and put labels between them. The
 * eye still saw eleven boxes. This one changes the shape of the page:
 *
 *   1. WHO YOU ARE — one card: avatar, name, verified mark, the plan chip.
 *   2. THE HUB — three tiles: Stars, your code, your plan. Big number, one
 *      line, one tap. This is where "click it and upgrade" lives.
 *   3. LISTS — four grouped lists (You · Your NUM · Settings · Account), each
 *      ONE card with hairline rows inside, the way a phone's own Settings
 *      app is built. A row expands in place when it has something to show
 *      and opens a sheet when it is a door.
 *
 * The sub-cards this page composes (PeopleCard, HostCard, Notifications,
 * Connections, Contact, Identity, PairBridge, Verify5arz…) still render their
 * own `.glass` box; inside a List the `profile-list` CSS strips that box and
 * draws them as rows, so one rule restyles nine components and none of them
 * had to change.
 */
function List({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass profile-list" style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ ...kicker, padding: '14px 16px 4px' }}>{title}</div>
      {children}
    </div>
  );
}

/** A door: title, one line, chevron. 56px, the row height a thumb expects. */
function Row({ title, sub, onTap, icon, tone, ariaLabel }: { title: string; sub?: string | null; onTap: () => void; icon?: React.ReactNode; tone?: 'danger'; ariaLabel?: string }) {
  return (
    <div
      {...pressable(onTap)}
      aria-label={ariaLabel}
      className="tap"
      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', minHeight: 56, borderTop: '1px solid var(--ink-08)' }}
    >
      {icon && <span style={{ width: 30, height: 30, borderRadius: 999, flex: 'none', background: 'var(--field-bg)', border: '1px solid var(--ink-08)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-accent)' }}>{icon}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: tone === 'danger' ? 'var(--ink-60)' : 'var(--color-text)', lineHeight: 1.3 }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 2, lineHeight: 1.45, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
      </div>
      <ChevronRightIcon size={16} style={{ color: 'var(--ink-40)', flex: 'none' }} />
    </div>
  );
}

/** A hub tile: the number or the word, then what it is. One tap. */
function Tile({ big, label, sub, onTap }: { big: React.ReactNode; label: string; sub?: string; onTap: () => void }) {
  return (
    <div
      {...pressable(onTap)}
      className="glass lift tap"
      style={{ cursor: 'pointer', borderRadius: 'var(--r-lg)', padding: '14px 12px 12px', display: 'grid', gap: 4, minHeight: 92, alignContent: 'start' }}
    >
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, lineHeight: 1, letterSpacing: '-.01em' }}>{big}</div>
      <div style={{ ...kicker, marginTop: 6 }}>{label}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--ink-60)', lineHeight: 1.35 }}>{sub}</div>}
    </div>
  );
}

function Collapsible({ title, summary, defaultOpen = false, children }: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="profile-row" style={{ borderTop: '1px solid var(--ink-08)' }}>
      <div
        {...pressable(() => setOpen((v) => !v))}
        aria-expanded={open}
        className="tap"
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', minHeight: 56 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3 }}>{title}</div>
          {summary && <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 2, lineHeight: 1.45 }}>{summary}</div>}
        </div>
        <ChevronRightIcon
          size={16}
          style={{ color: 'var(--ink-40)', flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}
        />
      </div>
      {open && <div style={{ padding: '0 16px 16px' }}>{children}</div>}
    </div>
  );
}

function Section({ title, summary, fields, values, onChange, defaultOpen = false }: {
  title: string;
  summary: string;
  fields: Field[];
  values: Record<string, string>;
  onChange: (k: string, v: string) => void;
  defaultOpen?: boolean;
}) {
  const filled = fields.filter(([k]) => (values[k] ?? '').trim()).length;
  return (
    <Collapsible title={title} summary={filled ? t('{n} of {total} filled in', { n: filled, total: fields.length }) : summary} defaultOpen={defaultOpen}>
      <div style={{ display: 'grid', gap: 12 }}>
        {fields.map(([key, label, placeholder, why, chips]) => {
          const v = values[key] ?? '';
          return (
            <div key={key}>
              <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>{t(label)}</div>
              <input style={field} placeholder={t(placeholder)} value={v} onChange={(e) => onChange(key, e.target.value)} />
              {chips && chips.length > 0 && (
                <div className="no-scrollbar" style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 6, padding: '2px 0' }}>
                  {chips.map((c) => {
                    const on = v.trim().toLowerCase() === t(c).toLowerCase();
                    return (
                      <span key={c} {...pressable(() => onChange(key, on ? '' : t(c)))} aria-pressed={on} className="tap press"
                        style={{ cursor: 'pointer', flex: 'none', minWidth: 56, textAlign: 'center', fontSize: 11.5, fontWeight: 600, padding: '8px 14px', borderRadius: 12, whiteSpace: 'nowrap',
                          background: on ? 'var(--color-accent)' : 'var(--field-bg)', color: on ? '#fff' : 'var(--ink-60)', border: '1px solid ' + (on ? 'var(--color-accent)' : 'var(--ink-12)') }}>
                        {t(c)}
                      </span>
                    );
                  })}
                </div>
              )}
              <div style={{ fontSize: 10, color: 'var(--ink-40)', marginTop: 4, lineHeight: 1.45 }}>{t(why)}</div>
            </div>
          );
        })}
      </div>
    </Collapsible>
  );
}

export default function ProfileView() {
  const me = useApp((s) => s.me);
  const profile = useApp((s) => s.profile);
  const style = useApp((s) => s.style);
  const friends = useApp((s) => s.friends.filter((f) => f.state === 'active').length);
  const stars = useApp((s) => s.stars);
  // A member is verified if EITHER channel is proved. Since 12 Sep 2026 an
  // email address is a first-class way to sign up, so it has to be a
  // first-class way to be verified.
  const contactVerified = !!(me?.phone_verified || me?.email_verified);
  // MUST stay above the `!me` early return below: a hook called conditionally
  // changes the hook count the moment an account appears mid-session, which is
  // React error #310 and a blank screen.
  const reactionCount = Object.keys(useApp((s) => s.reactions)).length;
  const fileRef = useRef<HTMLInputElement>(null);

  const [values, setValues] = useState<Record<string, string>>({});
  const autosave = useRef<ReturnType<typeof setTimeout> | null>(null);
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
          <div style={kicker}>{t('YOUR PROFILE')}</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, marginTop: 6 }}>{t('Nothing here yet')}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 6, lineHeight: 1.55 }}>{t('Add your name and number and this becomes the place NUM learns who you are — how you travel, what you eat, the kind of night you actually want.')}</div>
          <div
            {...pressable(() => store.set({ inviteOpen: {} }))}
            className="press glow"
            style={{ cursor: 'pointer', marginTop: 14, borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '12px 16px', textAlign: 'center' }}
          >
            {t('INTRODUCE YOURSELF')}
          </div>
        </div>
        {/* Language and light are not account settings: a stranger in Bangkok
            needs Thai before they need a name. */}
        <ThemePicker />
      </div>
    );
  }

  const change = (k: string, v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
    // A chip tap or a finished field saves itself a moment later; the SAVE
    // button stays for people who want to see it happen.
    if (autosave.current) clearTimeout(autosave.current);
    autosave.current = setTimeout(() => { void save(); }, 1200);
  };

  const save = async () => {
    try {
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
      await saveProfile({ name: me.name_locked ? undefined : name.trim() || undefined, bio: filled });
      setSaved(true);
      setNote(null);
      setTimeout(() => setSaved(false), 2600);
    } catch (err) {
      setNote(guestMessage(err, t('Couldn’t save that.')));
    }
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      await uploadAvatar(file);
    } catch (err) {
      setNote(guestMessage(err, t('That image didn’t take.')));
    }
  };

  // ── THE REMODEL (18 Sep 2026) ────────────────────────────────────────────
  //
  // Dre: "so many boxes and text fields, it's so ugly, we need a full remodel
  // of the profile page. Click it and upgrade, that simple." The page was
  // eleven open cards and twenty text fields in one column. It is now six
  // groups in the order a person needs them: who you are (with the plan one
  // tap away), the plan itself, your Stars and codes, what NUM knows about
  // you (one collapsed card with a count instead of three open ones), your
  // NUM (people, hosting, business, expert), and settings. Nothing was
  // removed — every card that existed still exists — the difference is what
  // is open, and where.
  const ALL_FIELDS = [...QUICK_FIELDS, ...TRAVEL_FIELDS, ...TASTE_FIELDS];
  const filled = ALL_FIELDS.filter(([k]) => values[k]?.trim()).length;

  return (
    <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', paddingBottom: 110 }}>
      {/* 1 · WHO YOU ARE */}
      <div className="glass" style={{ ...card, display: 'flex', gap: 13, alignItems: 'center' }}>
        <div
          {...pressable(() => fileRef.current?.click())}
          aria-label={t('Change profile picture')}
          style={{
            cursor: 'pointer', width: 62, height: 62, borderRadius: 999, flex: 'none', position: 'relative',
            background: me.avatar ? `center/cover url(${me.avatar})` : 'var(--grad-accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
            fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22,
            boxShadow: '0 6px 18px var(--accent-30)',
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
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 20, lineHeight: 1.15 }}>{me.name ?? 'Traveller'}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-60)', marginTop: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>{me.phone ?? me.email ?? 'no number'}</span>
            <span
              style={{
                fontSize: 9, fontWeight: 800, letterSpacing: '.08em', padding: '3px 7px', borderRadius: 999,
                // Either channel counts. Reading only phone_verified meant a
                // member who proved an email address was labelled UNVERIFIED
                // for ever, on a channel they never claimed to have.
                background: contactVerified ? 'var(--ok-soft)' : 'var(--ink-08)',
                color: contactVerified ? 'var(--ok)' : 'var(--ink-60)',
                display: 'inline-flex', gap: 3, alignItems: 'center',
              }}
            >
              {contactVerified && <CheckIcon size={9} />}
              {contactVerified ? 'VERIFIED' : 'UNVERIFIED'}
            </span>
          </div>
          {friends > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 3, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <UsersIcon size={11} /> {t('{n} connected', { n: friends })}
            </div>
          )}
        </div>
        {/* CLICK IT AND UPGRADE. The plans live on the wallet sheet — the
            full sell, with badges — so the chip opens that, not a scroll. */}
        <div
          {...pressable(() => store.set({ walletOpen: true }))}
          aria-label={t('Your plan')}
          className="press tap"
          style={{ cursor: 'pointer', flex: 'none', alignSelf: 'flex-start', fontSize: 10, fontWeight: 800, letterSpacing: '.1em', padding: '0 12px', minHeight: 32, display: 'flex', alignItems: 'center', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff' }}
        >
          {t('UPGRADE')}
        </div>
      </div>

      {/* Its own block UNDER the identity row. As a third flex child it was
          being squeezed into the name column and printing over "Dre". */}
      <AppleSignIn />

      {/* 2 · THE HUB. Three tiles, one tap each. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, margin: '10px 12px 0' }}>
        <Tile big={`★${stars.toLocaleString()}`} label={t('STARS')} sub={t('Top up, tabs')} onTap={() => store.set({ walletOpen: true })} />
        <Tile big={<QrGlyph />} label={t('MY CODE')} sub={t('Share, connect')} onTap={() => store.set({ shareOpen: true })} />
        <Tile big={friends > 0 ? String(friends) : '+'} label={t('PEOPLE')} sub={friends > 0 ? t('connected') : t('Invite a friend')} onTap={() => (friends > 0 ? document.getElementById('your-people')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : store.set({ shareOpen: true }))} />
      </div>

      {/* Giveaways — the Friday pack draw today, whatever is live tomorrow.
          The card lists from the server, so a new giveaway needs no app
          release; it renders nothing when nothing is running. */}
      <GiveawaysCard />

      {/* 3 · LISTS */}
      <List title={t('YOU')}>
        {/* ONE ROW, NOT THREE. The quick fields, how you travel and your taste
            were three open cards under three headers — most of the page. */}
        <Collapsible
          title={t('Tell NUM about you')}
          summary={filled ? t('{n} of {total} filled in — every answer saves a question later', { n: filled, total: ALL_FIELDS.length }) : t('Two minutes, then every ask is one message')}
        >
          <div style={{ margin: '0 -16px' }}>
            <Section title={t('The things NUM would otherwise ask')} summary={t('Where you stay, how many, when you eat, how you move and pay')} fields={QUICK_FIELDS} values={values} onChange={change} defaultOpen />
            <Section title={t('How you travel')} summary={t('Status, seat, home airport — so a fare search already fits you')} fields={TRAVEL_FIELDS} values={values} onChange={change} />
            <Section title={t('So NUM gets you right')} summary={t('Diet, budget, the kind of night you actually want')} fields={TASTE_FIELDS} values={values} onChange={change} />
          </div>
          <div style={{ padding: '12px 0 0' }}>
            <div
              {...pressable(save)}
              className="tap press"
              style={{ cursor: 'pointer', borderRadius: 999, background: 'var(--grad-accent)', color: '#fff', fontWeight: 700, fontSize: 12, letterSpacing: '.06em', padding: '13px 16px', textAlign: 'center' }}
            >
              {saved ? t('SAVED — NUM KNOWS') : t('SAVE')}
            </div>
            {note && <div style={{ fontSize: 11, color: 'var(--color-accent-700)', marginTop: 8, textAlign: 'center' }}>{note}</div>}
          </div>
        </Collapsible>
        <Collapsible
          title={t('What NUM has picked up')}
          summary={reactionCount ? `${reactionCount} reaction${reactionCount === 1 ? '' : 's'} so far` : t('Nothing learned yet')}
        >
          {reactionCount === 0 && !Object.keys(style).length ? (
            <div style={{ fontSize: 12, color: 'var(--ink-60)', lineHeight: 1.55 }}>
              Nothing yet. React to NUM’s suggestions with {REACTIONS.map((r) => r.emoji).join(' ')} and it learns what to send you and what to drop.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {style.length === 'short' && <Line>{t('Keeps replies short for you.')}</Line>}
              {style.length === 'long' && <Line>{t('Gives you the reasoning, not just the answer.')}</Line>}
              {style.decisiveness === 'one' && <Line>{t('One pick, no menus.')}</Line>}
              {style.decisiveness === 'options' && <Line>{t('Offers a couple of options with a house pick.')}</Line>}
              {style.emoji === 'no' && <Line>{t('No emoji in replies.')}</Line>}
              {!!style.loved?.length && <Line>More like: {style.loved.slice(-3).join(', ')}</Line>}
              {!!style.rejected?.length && <Line>Never again: {style.rejected.slice(-3).join(', ')}</Line>}
              <div
                {...pressable(() => store.set({ style: {}, reactions: {} }))}
                className="tap"
                style={{ cursor: 'pointer', fontSize: 11, fontWeight: 800, letterSpacing: '.08em', color: 'var(--color-accent-700)', marginTop: 4, minHeight: 44, display: 'flex', alignItems: 'center' }}
              >
                RESET WHAT NUM LEARNED
              </div>
            </div>
          )}
        </Collapsible>
        {/* Passenger details live behind their own sheet rather than inline
            with the preference fields, because they are a different KIND of
            thing: a hint that makes an answer better versus the legal identity
            an airline checks at the gate. */}
        <Row title={t('Passenger details')} sub={t('Passport name and date of birth, for tickets only')} onTap={() => store.set({ passengerOpen: true })} />
        <Verify5arz />
      </List>

      <List title={t('YOUR NUM')}>
        <div id="your-people"><PeopleCard /></div>
        <HostCard />
        <Row icon={<SparklesIcon size={15} />} title={t('Own a place on NUM?')} sub={t('Claim your listing and get the owner tools')} onTap={() => store.set({ businessOpen: true })} />
        {/* Scout tools. Shown to everyone, because sign-up is open — the sheet
            itself explains the programme to somebody who is not one yet. */}
        <Row icon={<SparklesIcon size={15} />} title={t('NUM Expert')} sub={t('Sign businesses up — your code, your businesses, what you have earned')} onTap={() => store.set({ scoutOpen: true })} ariaLabel={t('NUM EXPERT')} />
        {/* Finish a connection that opened in the browser instead of the app. */}
        <PairBridge installed />
      </List>

      <List title={t('SETTINGS')}>
        <ThemePicker />
        <NotificationsCard />
        {/* CONNECT YOUR WORLD, moved off TODAY on 18 Sep 2026. */}
        <ConnectionsCard />
        <Collapsible title={t('Name on the account')} summary={me.name_locked ? t('Locked to your verified number') : t('What friends see when you connect')}>
          <input
            style={{ ...field, opacity: me.name_locked ? 0.6 : 1 }}
            value={name}
            disabled={me.name_locked}
            onChange={(e) => { setName(e.target.value); setSaved(false); }}
            placeholder={t('Your name')}
          />
          <div style={{ fontSize: 11, color: 'var(--ink-40)', marginTop: 6, lineHeight: 1.5 }}>
            {me.name_locked
              ? t('Locked to your verified number — this is what friends see next to it, so changing it goes through us. Ask NUM and we’ll sort it.')
              : t('This is the name on your invites and what friends see when you connect. Once your number is verified it’s locked to it.')}
          </div>
        </Collapsible>
      </List>

      <List title={t('ACCOUNT & DATA')}>
        <ContactCard />
        <IdentityCard />
        {/* FINDING IT IS THE FEATURE. Deletion has to be discoverable in-app
            (5.1.1(v)); it is the last row of the last list, which is where a
            person looking for it looks. One tap opens the question. */}
        <Row
          tone="danger"
          ariaLabel={t('Delete my account')}
          title={t('Delete my account')}
          onTap={() => {
            store.set({ deleteOpen: true });
            requestAnimationFrame(() => {
              document.getElementById('delete-account')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
          }}
        />
      </List>
      <DangerZone />
      <VersionLine />
      <SourcesLine />
    </div>
  );
}

/** A small QR glyph for the hub tile — a picture of the thing it opens. */
function QrGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M5.5 5.5h2v2h-2zM16.5 5.5h2v2h-2zM5.5 16.5h2v2h-2zM14 14h3v3h-3zM19 14h2v2h-2zM14 19h2v2h-2zM18 18h3v3h-3z" fill="currentColor" />
    </svg>
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
      ? t('This browser can’t do notifications — everything still waits for you in the app.')
      : state === 'needs-install'
        ? t('Add NUM to your home screen first: tap Share, then “Add to Home Screen”. iPhone only allows notifications for installed apps.')
        : state === 'denied'
          ? t('Notifications are blocked in your browser settings. Turn them back on there and NUM can reach you again.')
          : on
            ? t('On. NUM will tell you when a table moves, a friend answers, or a plan changes — and nothing else.')
            : t('A table that moved, a friend who said yes, a flight that shifted. Only the things you’d want interrupting you.');

  const toggle = async () => {
    setBusy(true);
    if (on) {
      await disablePush();
      setMsg(t('Off — you’ll still see everything next time you open NUM.'));
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
      <div style={kicker}>{t('NOTIFICATIONS')}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, marginTop: 4 }}>
        {on ? t('NUM can reach you') : t('Let NUM reach you')}
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
          {busy ? t('ONE MOMENT…') : on ? t('TURN THEM OFF') : t('TURN ON NOTIFICATIONS')}
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
        <div style={kicker}>{t('A PERSON, NOT JUST AN APP')}</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, marginTop: 4 }}>{t('Want a VIP host?')}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.55 }}>
          A real concierge who knows the city and knows you. NUM does the finding; your host does the arranging, in person.
        </div>
        {mine.find && <a href={mine.find} target="_blank" rel="noreferrer" style={link}>{t('FIND A HOST NEAR YOU')}</a>}
      </div>
    );
  }
  const does = mine.host.services.map((k) => SERVICE_WORDS[k] ?? k).join(', ');
  return (
    <div className="glass" style={{ ...card }}>
      <div style={kicker}>{t('YOUR HOST')}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13.5, marginTop: 4 }}>{mine.host.name}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-60)', marginTop: 4, lineHeight: 1.55 }}>
        {does ? `Arranges ${does} for you.` : t('Arranges things for you, in person.')} Ask NUM for any of it and say “send it to {mine.host.name}” — it lands in their console, and they confirm with you directly.
      </div>
      {mine.page && <a href={mine.page} target="_blank" rel="noreferrer" style={link}>{t('MY HOST PAGE')}</a>}
      {mine.calendar && <a href={mine.calendar.replace(/^https?:/, 'webcal:')} style={link}>{t('SUBSCRIBE TO THEIR BOOKINGS')}</a>}
    </div>
  );
}

/**
 * Look and language. One brand in two lights (Auto follows the phone), and
 * the nine languages NUM speaks. A language change swaps the whole app's
 * strings (src/lib/i18n.ts) and tells the concierge which language to answer
 * in when a message leaves it ambiguous.
 */
function ThemePicker() {
  const current = useApp((s) => s.theme);
  const textSize = useApp((s) => s.textSize);
  const lang = useApp((s) => s.lang);
  const chosen = isLang(lang) ? lang : phoneLang();
  const name = THEMES.find((th) => th.id === current)?.name ?? 'Auto';
  const tile: React.CSSProperties = { cursor: 'pointer', borderRadius: 14, padding: '10px 10px', background: 'var(--field-bg)', display: 'grid', gap: 6 };
  return (
    <Collapsible title={t('Look, text & language')} summary={`${t(name)} · ${t(TEXT_SIZES.find((x) => x.id === textSize)?.name ?? 'Standard')} · ${LANGS[chosen].name}`}>
      <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--ink-40)', margin: '2px 0 8px' }}>{t('LOOK')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {THEMES.map((th) => {
          const on = current === th.id;
          return (
            <div key={th.id} {...pressable(() => setTheme(th.id))} aria-pressed={on} className="tap" style={{ ...tile, border: '1.5px solid ' + (on ? 'var(--color-accent)' : 'var(--ink-08)') }}>
              <div style={{ display: 'flex', gap: 4 }}>
                {th.swatch.map((c, i) => <span key={i} style={{ width: 16, height: 16, borderRadius: 999, background: c, border: '1px solid var(--ink-08)' }} />)}
                {on && <CheckIcon size={13} style={{ marginLeft: 'auto', color: 'var(--color-accent)' }} />}
              </div>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{t(th.name)}</div>
            </div>
          );
        })}
      </div>
      {/* TEXT SIZE (18 Sep 2026): for people who cannot see as well. Each
          tile is drawn at its own size so the choice is visible before it is
          made. lib/textsize.ts. */}
      <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--ink-40)', margin: '14px 0 8px' }}>{t('TEXT SIZE')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {TEXT_SIZES.map((ts) => {
          const on = textSize === ts.id;
          return (
            <div key={ts.id} {...pressable(() => setTextSize(ts.id))} aria-pressed={on} className="tap" style={{ ...tile, border: '1.5px solid ' + (on ? 'var(--color-accent)' : 'var(--ink-08)'), textAlign: 'center', alignContent: 'center', minHeight: 64 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15 * ts.zoom / 1.07, lineHeight: 1.1 }}>Aa</div>
              <div style={{ fontSize: 11.5, fontWeight: 700 }}>{t(ts.name)}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-40)', lineHeight: 1.5, marginTop: 8 }}>{t('Everything grows together — text, buttons, spacing. Pick what reads best.')}</div>
      <div style={{ fontSize: 10, letterSpacing: '.12em', fontWeight: 700, color: 'var(--ink-40)', margin: '14px 0 8px' }}>{t('LANGUAGE')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {(Object.keys(LANGS) as Lang[]).map((code) => {
          const on = chosen === code;
          return (
            <div key={code} {...pressable(() => setLang(code))} aria-pressed={on} lang={code} className="tap" style={{ ...tile, border: '1.5px solid ' + (on ? 'var(--color-accent)' : 'var(--ink-08)'), fontSize: 12.5, fontWeight: 700, textAlign: 'center', alignContent: 'center' }}>
              {LANGS[code].name}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-40)', lineHeight: 1.5, marginTop: 10 }}>{t('NUM answers in whatever language you write. This sets the app itself.')}</div>
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
      <div style={{ fontSize: 10, color: 'var(--ink-40)', letterSpacing: '.04em' }}>NUM {versionLine}</div>
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
 * NUM's directory is built on OpenStreetMap, which is ODbL-licensed: using the
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
        (ODbL), Google, and NUM&rsquo;s own verification.
      </div>
    </div>
  );
}

const Line = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11.5, color: 'var(--ink)', lineHeight: 1.5 }}>· {children}</div>
);
