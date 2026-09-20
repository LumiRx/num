// INVITES (19 Sep 2026) — the one shape every "someone wants you somewhere"
// takes, whichever table it came from. The rail (InviteRail.tsx) draws these;
// the PLAN badge counts them. Kept out of the component so it can be tested.
import { t } from './i18n';
import type { InboxRequests } from './types';

/** How many cards the rail shows before it folds. */
export const FOLD_AT = 3;

export interface InviteCard {
  kind: 'connect' | 'event' | 'plan';
  id: string;
  /** Who it came from — the mute key hangs off this, not the card. */
  from: string | null;
  title: string;
  sub: string;
  /** A plan you're on but haven't said whether you're in. */
  needsVote?: boolean;
}

/** The mute key for a card — who or what it came from, not the card itself. */
export const muteKeyOf = (c: { kind: InviteCard['kind']; from?: string | null; id: string }): string =>
  c.kind === 'connect' ? `friend:${c.from ?? c.id}` : c.kind === 'event' ? `host:${c.from ?? c.id}` : `plan:${c.id}`;

/**
 * The cards, from the three lists the server sends. A plan appears when you
 * haven't said whether you're in (never for the plan's owner, who is in by
 * definition) and — on TODAY, `newsToo` — when there is news you haven't
 * seen. On PLAN the plans are already tabs, so only the ones needing an
 * answer become cards.
 */
export function cardsOf(
  inbox: InboxRequests,
  muted: string[] = [],
  { newsToo = true, seen = {} }: { newsToo?: boolean; seen?: Record<string, string> } = {},
): InviteCard[] {
  const out: InviteCard[] = [];
  for (const c of inbox.connects) {
    out.push({
      kind: 'connect', id: c.id, from: c.a_id,
      title: `${c.from_name ?? t('A friend')} ${c.plan_title ? t('invited you to “{plan}”', { plan: c.plan_title }) : t('wants to connect')}`,
      sub: c.plan_title ? t('Say yes and it becomes one of your plans.') : t('Once you’re connected your two Nums can trade plans directly.'),
    });
  }
  for (const e of inbox.events) {
    out.push({
      kind: 'event', id: e.token, from: e.host_name,
      title: `${e.host_name ?? t('Someone')} — ${e.title}`,
      sub: [e.day, e.time, e.place].filter(Boolean).join(' · ') || t('details to come'),
    });
  }
  for (const p of inbox.plans) {
    const needsVote = p.my_vote == null && p.my_role !== 'owner';
    /* NEWS YOU HAVE READ IS NOT NEWS (20 Sep 2026).
     *
     * `latest` is whatever last happened in the plan, and something has
     * always last happened — so `newsToo && p.latest` drew a card that could
     * not be got rid of. Once you are in a plan there is no answer left to
     * give it, and it sat on TODAY for ever. Now a news card shows only while
     * its news differs from what this phone has recorded as read. Acting on
     * the card records it; the next real thing that happens brings it back. */
    const unread = !!p.latest && seen[p.id] !== p.latest;
    if (!needsVote && !(newsToo && unread)) continue;
    out.push({
      kind: 'plan', id: p.id, from: p.owner_name ?? null, needsVote,
      title: needsVote ? t('{plan} — are you in?', { plan: p.title }) : p.title,
      sub: p.latest ?? [p.starts_on, p.dest, `${p.members} ${p.members === 1 ? t('person') : t('people')}`].filter(Boolean).join(' · '),
    });
  }
  const mutedSet = new Set(muted);
  return out.filter((c) => !mutedSet.has(muteKeyOf(c)));
}
