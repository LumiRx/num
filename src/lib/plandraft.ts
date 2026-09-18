/**
 * PLAN DRAFTS — what you had typed is still there when you come back.
 *
 * Dre, 18 Sep: "when starting a plan also lets save the drafts so they can
 * be revisited." A plan, once created, lives on the server and is already
 * listed on PLAN. What was lost was everything BEFORE that moment and around
 * it: the title you were halfway through, the idea you had not added yet,
 * the note you were writing to the group — one accidental swipe and it was
 * gone. This keeps those, per plan, on this phone.
 *
 * Per phone on purpose (localStorage, not the server): an unsent sentence is
 * this person's, not the group's, and nobody in the plan should see a
 * half-typed comment. It is a convenience — every read and write is wrapped,
 * and the sheet works exactly the same when storage is unavailable.
 *
 * `NEW` is the draft of a plan that does not exist yet. PLAN shows it as
 * "pick up where you left off" so the intent survives a closed sheet.
 */
export interface PlanDraft {
  title?: string;
  idea?: string;
  say?: string;
  at: number;
}

export const NEW = 'new';
const KEY = (planId: string) => `num.plandraft.${planId}`;
/** A draft older than this is stale, not a memory. */
export const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

const storage = (): Storage | null => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};

export function loadDraft(planId: string | null | undefined): PlanDraft | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY(planId ?? NEW));
    if (!raw) return null;
    const d = JSON.parse(raw) as PlanDraft;
    if (!d || typeof d !== 'object' || !d.at || Date.now() - d.at > KEEP_MS) { s.removeItem(KEY(planId ?? NEW)); return null; }
    return d;
  } catch { return null; }
}

/** Save the parts that are non-empty; an all-empty draft is a cleared draft. */
export function saveDraft(planId: string | null | undefined, patch: Partial<Omit<PlanDraft, 'at'>>): void {
  const s = storage();
  if (!s) return;
  try {
    const cur = loadDraft(planId) ?? { at: Date.now() };
    const next: PlanDraft = { ...cur, ...patch, at: Date.now() };
    for (const k of ['title', 'idea', 'say'] as const) if (!String(next[k] ?? '').trim()) delete next[k];
    if (!next.title && !next.idea && !next.say) { s.removeItem(KEY(planId ?? NEW)); return; }
    s.setItem(KEY(planId ?? NEW), JSON.stringify(next));
  } catch { /* storage is a convenience */ }
}

export function clearDraft(planId: string | null | undefined, field?: 'title' | 'idea' | 'say'): void {
  if (field) { saveDraft(planId, { [field]: '' }); return; }
  const s = storage();
  if (!s) return;
  try { s.removeItem(KEY(planId ?? NEW)); } catch { /* fine */ }
}

/** Is there something worth picking up? Non-empty text, in words. */
export function draftLine(d: PlanDraft | null): string | null {
  if (!d) return null;
  const bit = d.title || d.idea || d.say;
  return bit ? String(bit).trim().slice(0, 80) : null;
}
