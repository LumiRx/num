// Deep research, from the app's side: start a run, then watch for it to land.
//
// The server does the thinking (worker/research.mjs) and it takes 15–60
// seconds, which is why none of this is a request/response. POST returns an
// id in milliseconds; the answer arrives later, and the guest is free to go
// on using NUM — or to close the app entirely, because a push follows.
//
// So the client's whole job is: hand over the brief, remember the id, and
// stop asking once there is nothing left to wait for.
import { store } from './store';
import { apiUrl } from './apibase';
import type { ResearchRun } from './types';

/** Long enough not to hammer a 15–60s job, short enough to feel prompt. */
const POLL_MS = 3_000;
/**
 * The server closes an abandoned run after ten minutes (ORPHAN_AFTER_MINUTES).
 * Polling past that is asking a question that already has its answer, so the
 * client gives up a minute later and says so rather than spinning for ever —
 * the failure mode this feature had on its first night in production.
 */
const GIVE_UP_MS = 11 * 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;

export function stopWatchingResearch(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}

/** One poll. Returns true when there is nothing left to wait for. */
async function pollOnce(id: string, me: string): Promise<boolean> {
  try {
    const res = await fetch(apiUrl(`/api/research?id=${encodeURIComponent(id)}&me=${encodeURIComponent(me)}`));
    if (!res.ok) return false;
    const body = await res.json() as { research?: ResearchRun };
    const run = body?.research;
    if (!run) return false;
    store.set({ research: run });
    return run.state === 'done' || run.state === 'failed' || run.state === 'empty';
  } catch {
    // A dropped poll is not a dropped run. The work is happening on the
    // server whatever this device's connection is doing.
    return false;
  }
}

function watch(id: string, me: string, startedAt = Date.now()): void {
  stopWatchingResearch();
  timer = setTimeout(async () => {
    const settled = await pollOnce(id, me);
    if (settled) { timer = null; return; }
    if (Date.now() - startedAt > GIVE_UP_MS) {
      timer = null;
      store.set((s) => ({
        research: s.research && s.research.id === id
          ? { ...s.research, state: 'failed', error: 'this one stopped before it finished — nothing was charged' }
          : s.research,
      }));
      return;
    }
    watch(id, me, startedAt);
  }, POLL_MS);
}

/**
 * Start a run. Returns null and narrates when the server refuses — which for
 * this feature most often means the monthly allowance is spent, and that
 * refusal already carries a sentence written for a person to read.
 */
export async function startResearch(brief: string): Promise<ResearchRun | null> {
  const s = store.get();
  const me = s.me?.id;
  if (!me) {
    store.set({ inviteOpen: {} });
    return null;
  }
  store.set({ research: null, researchError: null, researchBusy: true });
  try {
    const res = await fetch(apiUrl('/api/research'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ me, brief, dest: s.place ?? null }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      // 402 carries the allowance line from membership.mjs verbatim. It was
      // written to be read by a guest, so it is shown rather than replaced.
      store.set({ researchBusy: false, researchError: String(body.error ?? 'I could not start that just now.') });
      return null;
    }
    const run: ResearchRun = {
      id: String(body.id), state: 'queued', brief, dest: s.place ?? null,
      questions: [], constraints: [], answer: null, unmet: [], places: [],
      ms: null, error: null,
    };
    store.set({ research: run, researchBusy: false, researchLeft: typeof body.left === 'number' ? body.left : null });
    watch(run.id, me);
    return run;
  } catch (err) {
    store.set({ researchBusy: false, researchError: `I couldn't reach NUM — ${(err as Error).message}` });
    return null;
  }
}

/**
 * Pick up a run again after a reload, so closing the app does not lose it.
 *
 * This is also the boundary where a saved blob first gets used, and that
 * boundary has taken this app down before: a malformed value written by an
 * older build is restored on every launch, for as long as the app stays
 * installed, and the only escape is deleting it (see src/lib/restore.test.mjs
 * and the iPhone crash of 15 Sep). The sheet maps over four of these arrays,
 * so anything that is not the shape it claims is dropped here rather than
 * rendered.
 */
export function resumeResearch(): void {
  const s = store.get();
  const me = s.me?.id;
  const raw = s.research as Partial<ResearchRun> | null;
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
    if (raw) store.set({ research: null });
    return;
  }
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);
  const run: ResearchRun = {
    id: raw.id,
    state: (['queued', 'running', 'done', 'empty', 'failed'] as const).includes(raw.state as never)
      ? raw.state as ResearchRun['state'] : 'failed',
    brief: typeof raw.brief === 'string' ? raw.brief : '',
    dest: typeof raw.dest === 'string' ? raw.dest : null,
    questions: arr(raw.questions),
    constraints: arr(raw.constraints),
    answer: typeof raw.answer === 'string' ? raw.answer : null,
    unmet: arr(raw.unmet),
    places: arr(raw.places),
    ms: typeof raw.ms === 'number' ? raw.ms : null,
    error: typeof raw.error === 'string' ? raw.error : null,
  };
  store.set({ research: run });
  if (!me) return;
  if (run.state === 'done' || run.state === 'failed' || run.state === 'empty') return;
  watch(run.id, me);
}
