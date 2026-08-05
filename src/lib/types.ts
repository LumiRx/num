// Domain model for Num — ported from the Concierge.dc.html prototype state.
import type { TabState } from './tabs';
import type { Errand } from './errands';
import type { FlightOffer, FlightQuery } from './flights';
import type { DmMessage, DmPeer } from './dm';

export type View = 'dash' | 'thread' | 'plan' | 'mem';

export type CityGroup = 'BKK' | 'HKT' | 'SIN' | 'KP';

export type BookingStatus = 'confirmed' | 'hold' | 'deposit' | 'rebooked' | 'cancelled';

/** Everything tagOf() can label — booking statuses plus card-only tags. */
export type TagKind = BookingStatus | 'meeting' | 'memory' | 'bill' | 'paid' | 'shared';

export interface Booking {
  id: string;
  mo: number; // 7 = Jul, 8 = Aug (2026)
  day: number;
  time: string; // 'HH:MM'
  dur: number; // minutes
  place: string;
  title: string;
  grp: CityGroup;
  status: BookingStatus;
  holdBy?: string | null; // e.g. 'FRI' — deadline label while status === 'hold'
  note: string;
  cost: string;
  receipt?: string;
  /** Venue photo carried over from the reply card, so the PLAN shelf shows it too. */
  photo?: string; // set once a receipt is filed, e.g. '#LD-2841 · ★529'
}

export interface Meeting {
  id: string;
  mo: number;
  day: number;
  time: string;
  dur: number;
  title: string;
  src: 'GCAL' | 'NUM';
  place: string;
}

export interface MemoryItem {
  id: string;
  trip: 'TOKYO' | 'LISBON';
  date: string; // display date, e.g. 'Thu 23 Apr'
  time: string;
  photos: number;
  title: string;
  place: string;
  note: string;
}

export interface CardRef {
  title: string;
  meta: string;
  tag: TagKind;
  /** Real venue photo, attached server-side from the places directory. */
  photo?: string;
  photoAttr?: string | null;
  photoLicense?: string | null;
}

export interface Msg {
  who: 'c' | 'u';
  text: string;
  card?: CardRef;
}

export interface Chip {
  id: string;
  label: string;
}

export interface Txn {
  id: string;
  t: string;
  meta: string;
  amt: string;
  dir: 0 | 1; // 1 = credit (top-up), 0 = debit
}

export type Disruption = 'none' | 'active' | 'rebooked';

/** 0 = off, 1 = listening, 2 = heard/on it, 3 = done */
export type VoicePhase = 0 | 1 | 2 | 3;

// ── Taste: how this user likes to be talked to, learned as they talk ────────

export type Reaction = 'love' | 'like' | 'meh' | 'no' | 'long';

export type ThemeId = 'ember' | 'bloom' | 'midnight' | 'neon' | 'mono' | 'heritage' | 'forest' | 'plain';

export interface StyleProfile {
  length?: 'short' | 'long';
  decisiveness?: 'one' | 'options';
  emoji?: 'yes' | 'no';
  pace?: 'fast';
  /** Suggestions they reacted well / badly to — fed back to the model. */
  loved?: string[];
  rejected?: string[];
  /** Recent message lengths; kept on-device only, never sent up. */
  lengths?: number[];
}

/** One provider Num can hand the user into, resolved server-side by country. */
export interface ServiceOption {
  id: string;
  name: string;
  url: string;
  app?: string | null;
  note?: string | null;
  connected?: boolean;
}

export interface ServiceHandoff {
  kind: 'ride' | 'food' | 'table' | 'wellness' | 'flight' | 'hotel' | 'rail';
  /** 'connected' = Num completes it; 'handoff' = one tap into their own app. */
  mode: 'connected' | 'handoff';
  note?: string | null;
  to?: string | null;
  query?: string | null;
  options: ServiceOption[];
}

// ── Events: invite by text, RSVP with no app on the other side ──────────────

export interface NumEvent {
  id: string;
  title: string;
  day?: string | null;
  time?: string | null;
  place?: string | null;
  address?: string | null;
  dress?: string | null;
  note?: string | null;
  slug?: string | null;
  url?: string;
  invited?: number;
  yes?: number;
}

export interface EventGuest {
  token: string;
  name: string | null;
  phone: string | null;
  /** Set when the guest is on Num — their agent was asked, not their phone. */
  member_id?: string | null;
  /** 'agent' — delivered into their Num. 'link' — the host sends a link. */
  via?: 'agent' | 'link';
  rsvp: 'pending' | 'yes' | 'no' | 'maybe';
  plus_ones: number;
  message?: string | null;
  opened_at?: string | null;
  replied_at?: string | null;
}

/** Everything waiting on this member's answer. */
export interface InboxRequests {
  connects: Array<{ id: string; a_id: string; plan_id: string | null; from_name: string | null; from_avatar: string | null; plan_title: string | null; created_at: string }>;
  plans: Array<{ id: string; title: string; dest: string | null; members: number; open_items: number; latest: string | null }>;
  events: Array<{
    token: string; event_id: string; title: string; day: string | null; time: string | null;
    place: string | null; host_name: string | null;
    /** 'agent' — their Num asked yours. 'link' — a link was sent to you. */
    via: 'agent' | 'link';
  }>;
}

/**
 * A dash widget. The list is state, not markup, so Num can add and remove
 * widgets as the trip needs them — a directions card appears when there is
 * somewhere to be, and goes when there isn't.
 */
export type WidgetId =
  | 'next' | 'requests' | 'directions' | 'calendar' | 'tripcheck'
  | 'group' | 'events' | 'wallet' | 'connections';

/** Outside data the user has chosen to plug in. Off until they say otherwise. */
export interface Connections {
  contacts: boolean;
  photos: boolean;
  calendar: boolean;
  crypto: boolean;
  email: boolean;
  texts: boolean;
}

// ── Social layer: identity, friends, and plans a group builds together ──────

export interface Member {
  id: string;
  name: string | null;
  phone: string | null;
  phone_verified: boolean;
  /** True once the number is proved — the name is then part of the identity. */
  name_locked?: boolean;
  /** Small square data URL, resized on-device before it ever leaves. */
  avatar?: string | null;
  /** Free-form facts the traveller chose to share so Num knows them. */
  bio?: Record<string, string>;
  ref: string | null;
}

export interface Friend {
  id: string | null;
  name: string;
  /** 'pending' until they open the invite on their own device. */
  state: 'pending' | 'active' | 'declined';
  direction: 'sent' | 'received';
  token?: string;
  plan_id?: string | null;
}

/** An item can exist as a pure idea — that is what lets friends plan first. */
export type PlanItemStatus = 'idea' | 'proposed' | 'held' | 'confirmed' | 'cancelled';

export interface PlanItem {
  id: string;
  plan_id: string;
  kind: 'idea' | 'booking' | 'note' | 'photo' | 'bill';
  title: string;
  place?: string | null;
  address?: string | null;
  day?: string | null;
  time?: string | null;
  status: PlanItemStatus;
  cost?: string | null;
  note?: string | null;
  photo?: string | null;
  by_id?: string | null;
  by_name?: string | null;
  /** Who is actually coming. A guest with no member_id has no Num account. */
  attendees?: Array<{ member_id: string | null; name: string; rsvp: 'going' | 'maybe' | 'out' }>;
  /** Everyone who hasn't said no — the number the venue holds seats against. */
  party_size?: number;
}

/** One entry in a plan's shared feed — a member comment or a system event. */
export interface PlanEvent {
  id: number;
  ts: string;
  by_id: string | null;
  by_name: string | null;
  /** 'comment' is a human talking; everything else is their Num reporting. */
  kind: string;
  summary: string;
}

export interface PartyPlan {
  id: string;
  title: string;
  dest?: string | null;
  owner_id: string;
  starts_on?: string | null;
  starts_time?: string | null;
  state: 'planning' | 'booked' | 'done' | 'archived';
  join_code?: string | null;
  members?: number;
  items?: number;
}

/** Open state for the invite sheet — what Num is about to send, and to whom. */
export interface InviteDraft {
  name?: string;
  phone?: string;
  planId?: string | null;
  /** Candidates to disambiguate "send invite to sam" before anything is sent. */
  candidates?: Array<{ name: string; phone?: string }>;
  minted?: {
    token: string;
    link: string;
    message: string;
    /** True = invitee is already a member: delivered app-to-app, no text needed. */
    on_num?: boolean;
    sms_url: string;
    whatsapp_url: string;
    install_steps: { ios: string[]; android: string[] };
  };
}

export interface AppState {
  view: View;
  typing: boolean;
  notifOn: boolean;
  disr: Disruption;
  laLine: string;

  /** True when running the scripted Viv/SE-Asia demo trip. */
  demo: boolean;
  /** A REAL device fix, when the guest has granted location. Distinct from
   *  `place`, which is what they told us, and from the edge's IP guess, which
   *  is never treated as knowledge. */
  here: { lat: number; lng: number } | null;

  /** Where the user told Num they are (null until onboarding answers it). */
  place: string | null;
  /** First-run onboarding completed (a place is known or demo entered). */
  onboarded: boolean;
  /** Facts Num has learned about the traveller ('remember' actions). */
  profile: Record<string, string>;

  calOpen: boolean;
  calM: 0 | 1; // month index: 0 = Jul 2026, 1 = Aug 2026
  selDay: string | null; // 'mo-day', e.g. '7-28'

  shareOpen: boolean;
  shLive: boolean;
  shHide: boolean;
  copied: boolean;
  killed: boolean;

  expanded: string | null; // booking / memory id expanded in a list

  voice: VoicePhase;

  stars: number;
  walletOpen: boolean;
  permOn: boolean;
  photosOn: boolean;
  billPaid: boolean;
  bought: string;

  /** Notifications are on for this device. */
  pushOn: boolean;

  /** Chosen colour layout — just a data-theme attribute on <html>. */
  theme: ThemeId;
  /** The owner console, open only for a claimed business. */
  businessOpen: boolean;
  /** YOU lives in the header now, not the tab bar — it opens as an overlay. */
  profileOpen: boolean;

  /** Recent Stars movements — server truth, display only. */
  starMoves: Array<{ id: string; delta: number; kind: string; note: string | null; other_name: string | null; created_at: string }>;
  /** A scanned pay request waiting for confirmation. */
  payOpen: { to: string; toName?: string; amount?: number; note?: string } | null;

  /** The live tab on screen, or null. Server truth — never computed here. */
  tabOpen: TabState | null;
  /** The tab to reopen on next launch, so a night out survives a reload. */
  tabId: string | null;

  /** The errand board: what's open nearby, and what's yours. */
  errandsOpen: boolean;
  errands: Errand[];
  myErrands: Errand[];

  /** Requests waiting on an answer, refreshed with the plan sync. */
  inbox: InboxRequests;
  /** Which dash widgets are showing, in order. Num may rewrite this. */
  widgets: WidgetId[];

  /** Learned response preferences, and the reactions they came from. */
  style: StyleProfile;
  reactions: Record<number, Reaction>;
  /** The last service hand-off Num offered, shown as tappable providers. */
  handoff: ServiceHandoff | null;
  /** Outside data sources the user has switched on. */
  connections: Connections;
  /** What each live connection actually points at — the forwarding address,
   *  the SMS number, the wallet — shown right on the row. */
  connDetail: Partial<Record<keyof Connections, string>>;

  /** Events this member hosts, and the one open in the dashboard. */
  events: NumEvent[];
  eventId: string | null;
  eventOpen: boolean;

  /** THREAD is an overlay now, reached from the floating dot. */
  threadOpen: boolean;
  /** Concierge messages arrived while the thread was closed. */
  unread: number;

  // ── messages with other members ──────────────────────────────────────────
  // All four are server truth and none of them are persisted: a stale thread
  // restored from localStorage would show messages that may since have been
  // read on another device.

  /** The messages surface is open (the people list, or one conversation). */
  dmOpen: boolean;
  /** The person whose conversation is on screen, or null for the list. */
  dmWith: { id: string; name: string | null } | null;
  dmThread: DmMessage[];
  /** Everyone with something unread — one badge per person. */
  dmInbox: DmPeer[];
  dmError: string | null;
  /** A `?dm=` deep link that landed before this device had an account. */
  dmPending: string | null;

  /** This device's Num account. Null until they give a name and number. */
  me: Member | null;
  /** Mutual connections — only 'active' ones share anything. */
  friends: Friend[];
  /** People this user has named, so "invite sam" resolves without contacts. */
  contacts: Array<{ name: string; phone?: string }>;
  /** Plans this member belongs to, and the one currently open. */
  plans: PartyPlan[];
  planId: string | null;
  planItems: PlanItem[];
  planMembers: Array<{ member_id: string; name: string | null; role: string; vote?: 'in' | 'out' | null }>;
  /** Last plan event narrated into the thread — the AI-to-AI read cursor. */
  planCursor: number;
  /**
   * The group thread, oldest first: members' comments interleaved with what
   * their Nums did (joined, booked, changed). One feed because the server
   * stores one feed — see planComment in worker/social.mjs.
   */
  planFeed: PlanEvent[];
  /** Referral that brought this user in, and the invite token to accept. */
  refCode: string | null;
  inviteToken: string | null;
  /** A scanned connect code waiting to be acted on (survives sign-up). */
  connectTo: string | null;
  /** A connect/invite that arrived outside the installed app, parked as a
   *  six-character code to carry across the Safari ↔ home-screen wall. */
  pairCode: string | null;

  /** Live fares from the last search, plus what was asked for. */
  flightOffers: { query: FlightQuery; offers: FlightOffer[] } | null;
  flightSearching: boolean;
  flightError: string | null;
  /** An errand the concierge proposed — pre-fills the sheet, never posts. */
  errandDraft: { title: string; detail?: string | null; where_from?: string | null; deliver_to: string; bounty: number; spend_cap: number } | null;

  inviteOpen: InviteDraft | null;
  partyOpen: boolean;

  txns: Txn[];
  /** The real money story from the server — see lib/wallet.ts. */
  activity: import('./wallet').Activity[];
  meetings: Meeting[];
  memories: MemoryItem[];
  chips: Chip[];
  msgs: Msg[];
  bookings: Booking[];
}
