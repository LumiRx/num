/**
 * THE ONE FUNNEL THE COMPANY IS BEING JUDGED ON.
 *
 * On 3 Sep 2026 the Reddit campaign moved to itsnum.com/ask/. Everything
 * NUM spends money on now arrives on that page, and the question — the only
 * question — is: how many of them ask Num something, and how many of them
 * keep it.
 *
 * Until today that could not be answered. The events existed for arrival and
 * for the first message, and nothing in between or after: no record that Num
 * answered, no record that the failure branch had fired, and nothing at all
 * for the home-screen invitation, which is the moment the whole page is built
 * around. `install_prompt_shown` had never once been recorded on this surface
 * because the browser event of that name does not fire inside an in-app
 * browser — which is 95% of this traffic.
 *
 * ── THE THING THIS MUST NOT DO ───────────────────────────────────────────
 *
 * It must not report one install rate.
 *
 * Three completely different experiences hide behind "add to home screen":
 *   native      Chrome/Android offered a real install prompt.
 *   ios-safari  iOS never offers one; the best we can do is show instructions.
 *   inapp       Reddit's in-app browser CANNOT add a home screen icon at all.
 * Averaging them produces a number that looks like a persuasion problem when
 * it is a browser problem, and the fix that number argues for — better copy —
 * is not the fix. So the paths are reported separately, always, and the
 * response says so in `meaning` rather than trusting a caller to remember.
 *
 * `install_accepted` is the only honest install proof on the native path, and
 * `app_launched_standalone` is the only one on iOS — a home screen icon that
 * is never opened is not an install anybody should count.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
import { adminGuard } from './adminkey.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

/** Said once, in the payload, so no caller has to remember it. */
export const MEANING = {
  arrived: 'Distinct visitors who loaded the page. Not ad clicks — a click that '
    + 'never finished loading is invisible here and visible in Ads Manager.',
  asked: 'Visitors who sent Num a first message. THE conversion this campaign '
    + 'should be optimised for.',
  answered: 'Visitors Num actually replied to. If this is materially below '
    + '`asked`, the product is failing in front of paying traffic — check `failed`.',
  offered: 'Visitors shown the home-screen invitation. It appears only after '
    + 'Num has answered twice, so it is a subset of the people who got value.',
  installed: 'Accepted a real browser install prompt, or opened Num from a home '
    + 'screen icon. A tap on an instruction is intent, not an install.',
  paths: 'native = a real prompt was available. ios-safari = iOS, where no '
    + 'prompt exists and instructions are the best available. inapp = an in-app '
    + 'browser, which CANNOT add a home screen icon at all — count these as '
    + 'unreachable, never as refusals.',
};

/** Every step, in order, and the event that proves it. */
export const STEPS = [
  ['arrived', ['landing_view', 'page_view']],
  ['asked', ['first_message_sent']],
  ['answered', ['num_answered']],
  ['failed', ['ask_failed']],
  ['offered', ['install_prompt_shown']],
  ['tapped', ['install_cta_click']],
  ['installed', ['install_accepted', 'app_launched_standalone']],
  ['declined', ['install_dismissed']],
  ['escaped', ['open_in_browser_click']],
];

/**
 * GET /api/admin/install-funnel?days=7&page=landing
 *
 * `days` is clamped to 1..365; anything nonsensical falls back to the default
 * rather than to the minimum, because `days=-5` clamped to 1 reads as "nothing
 * is happening" on a page about whether anything is happening.
 *
 * Never throws on a missing column: a funnel that 500s the first time an event
 * name is added is a funnel nobody trusts.
 */
export async function handleInstallFunnel(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const denied = adminGuard(request, env, CORS);
  if (denied) return denied;
  if (!env?.DB) return json({ error: 'Analytics unavailable.' }, 503);

  const url = new URL(request.url);
  const asked = Number(url.searchParams.get('days'));
  const days = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 365) : 7;
  // The ads landing page is the default because it is what the money buys.
  const page = String(url.searchParams.get('page') || 'landing').trim().slice(0, 40);

  const safe = async (stmt, fallback) => {
    try { return await stmt; } catch (e) {
      console.warn('[installfunnel]', e?.message ?? e);
      return fallback;
    }
  };

  const rows = await safe(
    env.DB.prepare(
      `SELECT event,
              COALESCE(detail, '') AS detail,
              COUNT(*)                   AS n,
              COUNT(DISTINCT visitor_id) AS visitors
         FROM num_web_events
        WHERE created_at > datetime('now', ?1)
          AND page = ?2
        GROUP BY event, detail`,
    ).bind(`-${days} day`, page).all().then((r) => r.results ?? []),
    [],
  );

  const byEvent = new Map();
  for (const r of rows) {
    const cur = byEvent.get(r.event) || { visitors: 0, n: 0, detail: {} };
    cur.visitors += Number(r.visitors || 0);
    cur.n += Number(r.n || 0);
    if (r.detail) cur.detail[r.detail] = (cur.detail[r.detail] || 0) + Number(r.visitors || 0);
    byEvent.set(r.event, cur);
  }

  const steps = {};
  for (const [name, events] of STEPS) {
    // Summed across the events that prove a step. Visitor counts from separate
    // GROUP BY rows can double-count one person who fired two of them — which
    // is why `installed` is reported alongside its parts rather than as a rate
    // anybody should multiply out.
    let visitors = 0, n = 0, detail = {};
    for (const ev of events) {
      const e = byEvent.get(ev);
      if (!e) continue;
      visitors += e.visitors; n += e.n;
      for (const k in e.detail) detail[k] = (detail[k] || 0) + e.detail[k];
    }
    steps[name] = { visitors, events: n, by_path: detail };
  }

  const arrived = steps.arrived.visitors;
  const rate = (x) => (arrived ? Math.round((x / arrived) * 10000) / 100 : null);

  return json({
    ok: true,
    page,
    window_days: days,
    steps,
    // Percentages of ARRIVED, every one of them, so two numbers on this page
    // can always be compared without asking which denominator each used.
    rate_of_arrivals: {
      asked: rate(steps.asked.visitors),
      answered: rate(steps.answered.visitors),
      offered: rate(steps.offered.visitors),
      installed: rate(steps.installed.visitors),
    },
    // The health check a human would actually make: did anybody who asked fail
    // to get an answer, and is the install path even available to these people.
    flags: [
      steps.failed.visitors > 0
        ? `${steps.failed.visitors} visitor(s) got no answer — the product failed in front of paid traffic`
        : null,
      steps.asked.visitors > 0 && steps.answered.visitors === 0
        ? 'people asked and nobody was answered — check /api/num from itsnum.com'
        : null,
      (steps.offered.by_path.inapp || 0) > (steps.offered.by_path.native || 0)
        ? 'most people offered the home screen cannot take it — they are in an in-app browser'
        : null,
    ].filter(Boolean),
    meaning: MEANING,
  });
}
