/**
 * The roster: which agents exist, what each is for, and what each may not do.
 *
 * One file, so "what is running against our merchants and our guests" is a
 * question with a single answer that fits on a screen. An agent that is not in
 * here does not exist, and spawn.mjs will not create one that skips it.
 */
import { charter } from './charter.mjs';

/* ── the business email agent ────────────────────────────────────────────
   The one that can run today. RESEND_KEY is set, 14,403 leads are queued in
   outreach-2026-08-25, and invitecron.mjs already carries the ramp and the
   windows — so this charter deliberately mirrors that code rather than
   inventing a second, competing set of limits. Two systems with different
   opinions about the daily cap is how a ramp gets quietly doubled. */
export const OUTREACH_EMAIL = charter({
  id: 'outreach-email',
  role: 'Invite a business to claim the listing NUM already holds for it, and answer the reply.',
  may: [
    'Send one invitation to a business address published on that business\'s own listing.',
    'Say what NUM holds about them: name, area, category, and that the listing exists already.',
    'Quote the commercial terms exactly as worker/commission.mjs computes them — never a rounder number.',
    'Answer a reply, including "how did you get my address" and "take me off this".',
    'Record an opt-out immediately and without argument.',
  ],
  never: [
    'Send a second invitation to a business that did not reply to the first. One is an invitation; two is a campaign nobody asked for.',
    'Claim a traveller asked about them, or invent demand, unless num_asks actually holds it.',
    'Attach anything, or link anywhere except itsnum.com.',
    'Send to a personal address that happens to appear on a listing — the address must be the business\'s own.',
  ],
  // Matches invitecron.mjs exactly: Tue/Wed/Thu, Edinburgh and LA mornings.
  windows: { days: [2, 3, 4], utcHours: [8, 9, 10, 11, 16, 17, 18, 19] },
  budget: { perRun: 25, perDay: 50 },
  requires: ['resend_key_present', 'lead_batch_configured'],
});

/* ── the business SMS agent ──────────────────────────────────────────────
   CANNOT RUN TODAY, and the charter says so rather than the code discovering
   it at send time. The A2P 10DLC campaign is still in review; 3 of 137 members
   are phone-verified; 11 messages have ever been sent and real sends fail
   30034. `requires` is what stops this being a live liability: canAct()
   refuses until a human sets a2p_approved, and an unapproved US send is not a
   deliverability problem, it is a carrier violation with a fine attached. */
export const OUTREACH_SMS = charter({
  id: 'outreach-sms',
  role: 'Reach a business on the number already published on its listing, where consent exists and the carrier permits it.',
  may: [
    'Send one message to a business number that carries recorded consent in num_sms_consent.',
    'Answer STOP and HELP on the first message, every time, in one segment.',
    'Identify NUM by name in the first line — a business receiving an unexplained text treats it as a scam, correctly.',
  ],
  never: [
    'Send to any number without a consent row. There is no "probably fine" here.',
    'Send to a consumer number. This charter covers businesses only.',
    'Send more than one message before a reply.',
    'Send outside 9am-6pm in the recipient\'s own timezone — not ours.',
  ],
  windows: { days: [2, 3, 4], utcHours: [8, 9, 10, 11, 16, 17, 18, 19] },
  budget: { perRun: 10, perDay: 20 },
  requires: ['a2p_approved', 'twilio_configured', 'consent_row_present'],
});

/* ── the reply reader ────────────────────────────────────────────────────
   The cheapest agent to justify and the one most likely to be skipped. 1,051
   businesses have already been invited. Nothing currently reads what came
   back, which means an interested merchant and an angry one are being handled
   identically: not at all. */
export const REPLY_TRIAGE = charter({
  id: 'reply-triage',
  role: 'Read what a business sent back and route it: interested, question, complaint, or opt-out.',
  may: [
    'Classify an inbound reply and attach the classification to the lead.',
    'Record an opt-out the moment one is expressed, in any wording, in any language.',
    'Draft an answer for a human to send.',
    'Escalate anything mentioning legal action, data protection or the press, immediately and unanswered.',
  ],
  never: [
    'Send its own reply without a human releasing it. A drafted answer is not a sent one.',
    'Treat ambiguity as consent. "Not right now" is a no.',
  ],
  budget: { perRun: 100, perDay: 500 },
  requires: ['inbox_configured'],
});

export const ROSTER = Object.freeze([OUTREACH_EMAIL, OUTREACH_SMS, REPLY_TRIAGE]);

export const byId = (id) => ROSTER.find((c) => c.id === id) || null;
