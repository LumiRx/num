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
  receipt?: string; // set once a receipt is filed, e.g. '#LD-2841 · ★529'
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

  txns: Txn[];
  meetings: Meeting[];
  memories: MemoryItem[];
  chips: Chip[];
  msgs: Msg[];
  bookings: Booking[];
}
