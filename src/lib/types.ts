// Domain model for Num — ported from the Concierge.dc.html prototype state.

export type View = 'thread' | 'plan' | 'mem';

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

// ── Social layer: identity, friends, and plans a group builds together ──────

export interface Member {
  id: string;
  name: string | null;
  phone: string | null;
  phone_verified: boolean;
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
}

export interface PartyPlan {
  id: string;
  title: string;
  dest?: string | null;
  owner_id: string;
  starts_on?: string | null;
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
  /** Candidates to disambiguate "send invite to dre" before anything is sent. */
  candidates?: Array<{ name: string; phone?: string }>;
  minted?: {
    token: string;
    link: string;
    message: string;
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

  /** This device's Num account. Null until they give a name and number. */
  me: Member | null;
  /** Mutual connections — only 'active' ones share anything. */
  friends: Friend[];
  /** People this user has named, so "invite dre" resolves without contacts. */
  contacts: Array<{ name: string; phone?: string }>;
  /** Plans this member belongs to, and the one currently open. */
  plans: PartyPlan[];
  planId: string | null;
  planItems: PlanItem[];
  planMembers: Array<{ member_id: string; name: string | null; role: string }>;
  /** Last plan event narrated into the thread — the AI-to-AI read cursor. */
  planCursor: number;
  /** Referral that brought this user in, and the invite token to accept. */
  refCode: string | null;
  inviteToken: string | null;

  inviteOpen: InviteDraft | null;
  partyOpen: boolean;

  txns: Txn[];
  meetings: Meeting[];
  memories: MemoryItem[];
  chips: Chip[];
  msgs: Msg[];
  bookings: Booking[];
}
