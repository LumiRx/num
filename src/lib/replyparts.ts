// ONE ANSWER, UP TO THREE BUBBLES (19 Sep 2026).
//
// Dre: "we can send multiple answers if need to give more suggestions, also
// max 3 messages and what we can fit inside those 3". A concierge's answer
// has a shape — the answer, the places, the question — and a single tall
// bubble with everything in it reads as a wall. Split into its parts it reads
// as a person talking: one line, a row of cards, one question.
//
// Pure: the thread pushes what this returns. Nothing is invented — the model
// wrote the text; this only decides where the seams are.
//
//   lead  — the reply up to (and including) the sentence that answers.
//   picks — the place cards, when there are any.
//   tail  — the last paragraph when it is a question or a next step and the
//           reply has more than one paragraph. Never the whole reply.
import type { Msg, Pick } from './types';

export const MAX_PARTS = 3;

/** Paragraphs, the way the model writes them: blank-line separated. */
export function paragraphs(text: string): string[] {
  return String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** A closing line NUM would say on its own: a question, or a "tell me / say the word" next step. */
export function isTail(p: string): boolean {
  const s = p.trim();
  if (!s || s.length > 220) return false;
  if (/[?？]\s*$/.test(s)) return true;
  return /^(say|tell me|want me to|shall i|let me know|just say|give me|pick one|which|tap|when you|if you)/i.test(s);
}

/**
 * Split one reply into its bubbles. With picks, the lead is what comes before
 * the cards and the tail what comes after; without picks the split is only
 * made when the tail is a real question and the lead is not tiny.
 */
export function splitReply(text: string, picks: Pick[] | null | undefined, extra: Partial<Msg> = {}): Msg[] {
  const paras = paragraphs(text);
  const hasPicks = !!picks?.length;
  const base: Msg = { who: 'c', text: '', ...extra };
  if (!paras.length) {
    return hasPicks ? [{ ...base, text: '', picks: picks!, part: 'picks' }] : [{ ...base, text: String(text ?? '').trim() }];
  }
  let tail: string | null = null;
  if (paras.length > 1 && isTail(paras[paras.length - 1])) tail = paras.pop()!;
  const lead = paras.join('\n\n');
  const out: Msg[] = [];
  if (lead) out.push({ ...base, text: lead, part: hasPicks || tail ? 'lead' : undefined });
  if (hasPicks) {
    // The cards ride with the lead when the lead is one short line — a bubble
    // holding only "Three that fit:" above a grid is a bubble too many.
    if (out.length && lead.length <= 90 && !/\n/.test(lead)) out[out.length - 1] = { ...out[out.length - 1], picks: picks! };
    else out.push({ ...base, text: '', picks: picks!, part: 'picks' });
  }
  if (tail) out.push({ ...base, text: tail, part: 'tail' });
  // Never more than three, and never lose text: fold overflow into the lead.
  while (out.length > MAX_PARTS) {
    const dropped = out.splice(1, 1)[0];
    out[0] = { ...out[0], text: [out[0].text, dropped.text].filter(Boolean).join('\n\n'), ...(dropped.picks ? { picks: dropped.picks } : {}) };
  }
  return out;
}

/** The pause between bubbles of one turn — long enough to read as typing, short enough not to feel staged. */
export const PART_GAP_MS = 420;
