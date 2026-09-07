#!/usr/bin/env node
/**
 * NUM — nightly analytics run
 * ===========================
 * Owner: `analytics-lead` (5arz HQ, department `data`).
 * Reads production D1 (`num-db`) READ-ONLY and emits one JSON blob.
 * Writes nothing, sends nothing, spends nothing.
 *
 *   node scripts/nightly-analytics.mjs                 # 14-day window, JSON to stdout
 *   node scripts/nightly-analytics.mjs --days=28
 *   node scripts/nightly-analytics.mjs --out=/tmp/num-analytics-$(date +%F).json
 *   node scripts/nightly-analytics.mjs --exclude-ids=mem_abc,mem_def   # founder/admin accounts
 *   node scripts/nightly-analytics.mjs --dry                # print the SQL, run nothing
 *
 * Requires `npx wrangler` logged in to the Cloudflare account that owns
 * num-db (823979c8-b118-4a8a-953a-e07655205cf5). Every statement below is a
 * SELECT; the script refuses to run anything that is not (see `assertReadOnly`).
 *
 * ── THE ONE RULE THIS FILE ENFORCES ──────────────────────────────────────
 *
 * Zero and not-instrumented look identical in a report and mean opposite
 * things. "0 affiliate clicks" reads as "nobody clicked"; the truth is that
 * no code has ever written an affiliate click row, so the number does not
 * exist. Every metric here therefore carries a `status`:
 *
 *   measured          — a query ran and returned rows. The number is real.
 *   measured_empty    — the query ran, the table exists, and there are no
 *                       matching rows. This is a genuine zero.
 *   not_instrumented  — nothing in the codebase ever writes this. There is no
 *                       number to get. `needs` says what would have to be built.
 *   error             — the query failed. Never silently a zero.
 *
 * A metric with no `definition` is refused at load time. analytics-lead owns
 * the metric dictionary, and a number without a binding definition is worthless.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const DB = 'num-db';
const argv = process.argv.slice(2);
const flag = (f, d) => { const a = argv.find((x) => x.startsWith(`--${f}=`)); return a ? a.slice(f.length + 3) : d; };
const has = (f) => argv.includes(`--${f}`);

const DAYS = Math.max(1, parseInt(flag('days', '14'), 10) || 14);
const OUT = flag('out', '');
const DRY = has('dry');
const EXCLUDE = (flag('exclude-ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// SQL-safe list for the exclusion. Empty list must still be valid SQL, so it
// becomes a literal that can never match an id.
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const EXCL_SQL = EXCLUDE.length ? EXCLUDE.map(sq).join(',') : `'__none__'`;

// Published monthly prices, in cents, from GET /api/membership/tiers
// (probed live 2026-08-17). Kept here rather than joined because the tier
// table is code (worker/membership.mjs:60-100), not data — if the price
// changes there, it must change here in the same commit or MRR silently drifts.
const TIER_CENTS = { free: 0, plus: 898, pro: 2898 };

/* ───────────────────────── plumbing ───────────────────────── */

function assertReadOnly(sql) {
  // Belt and braces. This script runs against live production; a stray
  // INSERT/UPDATE/DELETE/DROP must be impossible, not merely unlikely.
  if (/\b(insert|update|delete|drop|alter|create|replace|attach|pragma|vacuum)\b/i.test(sql)) {
    throw new Error(`refusing to run a non-SELECT statement:\n${sql}`);
  }
  return sql;
}

function d1(sql) {
  assertReadOnly(sql);
  if (DRY) return [];
  const out = execFileSync('npx', [
    'wrangler@latest', 'd1', 'execute', DB, '--remote', '--json', '--command', sql,
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const i = out.indexOf('[');
  if (i < 0) throw new Error(`wrangler returned no JSON:\n${out.slice(0, 400)}`);
  const parsed = JSON.parse(out.slice(i));
  return parsed[0]?.results ?? [];
}

/* ───────────────────────── table inventory ─────────────────────────
 * Which tables exist at all, and which of the ones that exist have ever
 * been written to. An empty table is a finding in its own right: it means
 * the code path that fills it has never fired in production.
 */

// Every table this run cares about, and which module owns the writes.
const OWNED_TABLES = {
  num_asks: 'worker/asks.mjs — one row per answered concierge turn',
  num_usage: 'worker/console.mjs — one row per model call, with cost',
  num_members: 'worker/social.mjs — the member record',
  num_memberships: 'worker/membership.mjs — tier, renewal',
  num_usage_counters: 'worker/membership.mjs — entitlement consumption (countUse has zero callers)',
  num_payments: 'worker/pay.mjs — Stripe checkout sessions and their state',
  num_star_ledger: 'worker/pay.mjs — Stars minted by a purchase',
  num_star_moves: 'worker/social.mjs — Stars moving between members',
  num_star_balances: 'worker/social.mjs — current balance per member',
  num_place_impressions: 'worker/impressions.mjs — which business Num actually showed',
  num_affiliate_clicks: 'worker/affiliateclicks.mjs — outbound partner links handed over, and whether they were tagged',
  num_scouts: 'worker/migrations/0006_scouts.sql — people credited with introducing a business',
  num_scout_places: 'worker/migrations/0006_scouts.sql — one business, one scout, first come',
  num_scout_earnings: 'worker/migrations/0006_scouts.sql — what a scout is owed, gated on real revenue',
  num_health: 'worker/health.mjs — 5-minute self-check verdicts',
  num_brain_events: 'worker/brainstate.mjs — brain failures and their class',
  num_answer_cache: 'worker/answercache.mjs — cached concierge answers',
  num_web_events: 'growth/worker.js — the web/install funnel (POST itsnum.com/api/ev)',
  num_referral_codes: 'worker/referral.mjs — referral code issue',
  num_links: 'worker/social.mjs — friend/invite edges',
  num_plans: 'worker/social.mjs — plans',
  num_errands: 'worker/errands.mjs — errand board',
  num_events: 'worker/events.mjs — events and RSVPs',
  num_dms: 'worker/dm.mjs — direct messages',
  num_cashouts: 'worker/cashout.mjs — cash-out requests',
  num_sms_consent: 'growth/worker.js — SMS opt-in consent records',
  num_sms_delivery: 'worker/sms.mjs — Twilio delivery receipts',
  num_consent_funnel: 'PROPOSED — HQ/divisions/num/CONSENT_FUNNEL_INSTRUMENTATION.md §4. Does not exist yet.',
  num_consent_grants: 'PROPOSED — HQ/divisions/num/CONSENT_ARCHITECTURE.md §6.1. Does not exist yet.',
  num_consent_audit: 'PROPOSED — HQ/divisions/num/CONSENT_ARCHITECTURE.md §4.2. Does not exist yet.',
  num_crossing_log: 'PROPOSED — HQ/divisions/num/CONSENT_ARCHITECTURE.md §4.3. Does not exist yet.',
};

/* ───────────────────────── the metric dictionary ─────────────────────────
 *
 * Each entry is: what the number MEANS (definition), what it needs to exist
 * (requires), and the exact SQL that produces it. Nothing is computed anywhere
 * else. If you want to change what a number means, change it here, and note
 * the change in HQ/DECISIONS.md — that is how definition drift is prevented.
 *
 * `d` = the window in days, substituted as a literal.
 */

const M = (o) => {
  if (!o.definition || o.definition.trim().length < 20) {
    throw new Error(`metric ${o.id} has no usable definition — refusing to emit an undefined number`);
  }
  return o;
};

function metrics(d) {
  return [

    /* ══════════════════ 1 · USAGE ══════════════════ */

    M({
      id: 'asks_per_day',
      section: 'usage',
      definition:
        'ASK = one row in num_asks. A row is written once per concierge turn that produced a reply, ' +
        'either from the answer cache (worker/index.mjs:857) or from a brain that answered ' +
        '(worker/index.mjs:1036). It is NOT written when every brain failed and lastresort.mjs or the ' +
        'apology path answered — see metric `asks_that_got_no_answer`. So this is "answered turns", ' +
        'not "turns attempted", and it is biased UPWARD relative to demand during an outage.',
      requires: ['num_asks'],
      sql: `SELECT substr(ts,1,10) AS day, COUNT(*) AS asks,
                   SUM(cached) AS from_cache, SUM(degraded) AS degraded
            FROM num_asks WHERE ts >= datetime('now', '-${d} days')
            GROUP BY day ORDER BY day DESC`,
    }),

    M({
      id: 'unique_actors_per_day',
      section: 'usage',
      definition:
        'ACTOR = COALESCE(member_id, anon_id) on num_asks. member_id is the signed-in member; anon_id ' +
        'is a device-stable id of shape a_[a-z0-9]{8,64} (worker/asks.mjs:104). A row with BOTH null ' +
        'is an ask that cannot be attributed to anybody at all and is counted separately as ' +
        '`unattributable` — it must never be silently treated as one more unique person, which is the ' +
        'error that turns 3 heavy users into 40 "uniques".',
      requires: ['num_asks'],
      sql: `SELECT substr(ts,1,10) AS day,
                   COUNT(DISTINCT COALESCE(member_id, anon_id)) AS actors,
                   SUM(CASE WHEN member_id IS NULL AND anon_id IS NULL THEN 1 ELSE 0 END) AS unattributable
            FROM num_asks WHERE ts >= datetime('now', '-${d} days')
            GROUP BY day ORDER BY day DESC`,
    }),

    M({
      id: 'attribution_coverage',
      section: 'usage',
      definition:
        'The share of asks in the window carrying a member_id, an anon_id, or neither. This is the ' +
        'honesty metric for every per-person number below: at low member_id coverage the funnel is ' +
        'measuring a small biased subset, and any funnel percentage must be read with this figure ' +
        'next to it. As of worker/asks.mjs:50-55, member_id is null on ~99% of asks by design ' +
        '(most people asking Num are not members).',
      requires: ['num_asks'],
      sql: `SELECT COUNT(*) AS asks,
                   SUM(CASE WHEN member_id IS NOT NULL THEN 1 ELSE 0 END) AS with_member_id,
                   SUM(CASE WHEN anon_id IS NOT NULL THEN 1 ELSE 0 END)  AS with_anon_id,
                   SUM(CASE WHEN member_id IS NULL AND anon_id IS NULL THEN 1 ELSE 0 END) AS with_neither
            FROM num_asks WHERE ts >= datetime('now', '-${d} days')`,
    }),

    M({
      id: 'sessions_and_length',
      section: 'usage',
      definition:
        'SESSION = a run of asks by one ACTOR with no gap longer than 30 minutes between consecutive ' +
        'asks. SESSION LENGTH = seconds between the first and last ask of that run; a one-ask session ' +
        'therefore has length 0, which is correct and is why `single_ask_sessions` is reported ' +
        'alongside. 30 minutes is the industry-conventional cut and is arbitrary — it is stated here ' +
        'so that a future change to 15 or 60 is a visible decision rather than a silent redefinition. ' +
        'Unattributable asks (no member_id and no anon_id) cannot be sessionized and are excluded.',
      requires: ['num_asks'],
      sql: `WITH a AS (
              SELECT COALESCE(member_id, anon_id) AS actor, strftime('%s', ts) AS t
              FROM num_asks
              WHERE ts >= datetime('now', '-${d} days')
                AND COALESCE(member_id, anon_id) IS NOT NULL
            ), g AS (
              SELECT actor, t,
                     CASE WHEN t - LAG(t) OVER (PARTITION BY actor ORDER BY t) > 1800
                            OR LAG(t) OVER (PARTITION BY actor ORDER BY t) IS NULL
                          THEN 1 ELSE 0 END AS new_session
              FROM a
            ), s AS (
              SELECT actor, t, SUM(new_session) OVER (PARTITION BY actor ORDER BY t
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS sess FROM g
            ), spans AS (
              SELECT actor, sess, COUNT(*) AS asks, MAX(t) - MIN(t) AS secs
              FROM s GROUP BY actor, sess
            )
            SELECT COUNT(*) AS sessions,
                   COUNT(DISTINCT actor) AS actors,
                   SUM(asks) AS asks_in_sessions,
                   ROUND(AVG(asks), 2) AS mean_asks_per_session,
                   SUM(CASE WHEN asks = 1 THEN 1 ELSE 0 END) AS single_ask_sessions,
                   ROUND(AVG(secs), 1) AS mean_seconds,
                   MAX(secs) AS max_seconds
            FROM spans`,
    }),

    M({
      id: 'repeat_rate',
      section: 'usage',
      definition:
        'REPEAT ACTOR = an ACTOR who asked on two or more DISTINCT CALENDAR DAYS (UTC) inside the ' +
        'window. Distinct days, not distinct sessions: two sessions an hour apart is one visit, and ' +
        'coming back the next day is the behaviour that matters. REPEAT RATE = repeat actors / actors. ' +
        'At current volume this is a handful of people; read the raw counts, not the percentage.',
      requires: ['num_asks'],
      sql: `WITH a AS (
              SELECT COALESCE(member_id, anon_id) AS actor, COUNT(DISTINCT substr(ts,1,10)) AS days,
                     COUNT(*) AS asks
              FROM num_asks
              WHERE ts >= datetime('now', '-${d} days') AND COALESCE(member_id, anon_id) IS NOT NULL
              GROUP BY actor
            )
            SELECT COUNT(*) AS actors,
                   SUM(CASE WHEN days >= 2 THEN 1 ELSE 0 END) AS repeat_actors,
                   ROUND(100.0 * SUM(CASE WHEN days >= 2 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1) AS repeat_pct,
                   MAX(days) AS most_days_by_one_actor,
                   MAX(asks) AS most_asks_by_one_actor
            FROM a`,
    }),

    M({
      id: 'capability_routing',
      section: 'usage',
      definition:
        'Which CAPABILITY an ask was routed to. Three independent columns, reported together because ' +
        'each answers a different question and they are routinely conflated: `lane` is the router\'s ' +
        'cost decision (big / small / cache / fallback:<brain>, worker/index.mjs:1047), `brain` is ' +
        'which model actually answered, and `category` is what the ask was ABOUT. A specialist brief ' +
        '(worker/specialists.mjs) is recorded in num_usage.specialist, not here — see ' +
        '`specialist_mix`. Rows with lane NULL predate the column.',
      requires: ['num_asks'],
      sql: `SELECT COALESCE(lane,'(null)') AS lane, COALESCE(brain,'(null)') AS brain,
                   COALESCE(category,'(null)') AS category, COUNT(*) AS asks
            FROM num_asks WHERE ts >= datetime('now', '-${d} days')
            GROUP BY lane, brain, category ORDER BY asks DESC LIMIT 60`,
    }),

    M({
      id: 'specialist_mix',
      section: 'usage',
      definition:
        'SPECIALIST = the per-domain brief appended to the system prompt (worker/specialists.mjs), ' +
        'recorded on the model call in num_usage.specialist. This is the closest thing Num has to ' +
        '"which capability did this ask need". NULL means no specialist was selected, which is the ' +
        'majority case and is not a failure.',
      requires: ['num_usage'],
      sql: `SELECT COALESCE(specialist,'(none)') AS specialist, COUNT(*) AS calls,
                   SUM(micro_usd) AS micro_usd, ROUND(AVG(ms),0) AS mean_ms
            FROM num_usage WHERE day >= date('now', '-${d} days')
            GROUP BY specialist ORDER BY calls DESC`,
    }),

    M({
      id: 'destination_mix',
      section: 'usage',
      definition:
        'DESTINATION = num_asks.dest, the slug the grounding step resolved the guest to ' +
        '(worker/grounding.mjs). NULL means grounding could not place them — which is itself a ' +
        'product signal, because an unplaced guest gets a materially worse answer.',
      requires: ['num_asks'],
      sql: `SELECT COALESCE(dest,'(unresolved)') AS dest, COUNT(*) AS asks
            FROM num_asks WHERE ts >= datetime('now', '-${d} days')
            GROUP BY dest ORDER BY asks DESC LIMIT 30`,
    }),

    M({
      id: 'cost_per_day',
      section: 'usage',
      definition:
        'COST = SUM(num_usage.micro_usd), millionths of a USD, priced from the published per-model ' +
        'rate table at worker/console.mjs. An unrecognised model falls back to the Opus row, so this ' +
        'figure OVERSTATES rather than understates. Cost is here in the usage section deliberately: ' +
        'it is a usage fact, not revenue.',
      requires: ['num_usage'],
      sql: `SELECT day, COUNT(*) AS calls, SUM(in_tokens) AS in_tokens, SUM(out_tokens) AS out_tokens,
                   SUM(micro_usd) AS micro_usd, ROUND(SUM(micro_usd)/1000000.0, 4) AS usd
            FROM num_usage WHERE day >= date('now', '-${d} days')
            GROUP BY day ORDER BY day DESC`,
    }),

    M({
      id: 'business_impressions',
      section: 'usage',
      definition:
        'IMPRESSION = a business that was actually PUT IN FRONT of a guest — either the featured card ' +
        '(`card`) or named in the reply text (`named`). Being considered by the ranker and passed over ' +
        'is NOT an impression (worker/impressions.mjs header). This is the only number a merchant will ' +
        'ever pay for, so it is deliberately the conservative one.',
      requires: ['num_place_impressions'],
      sql: `SELECT date(ts,'unixepoch') AS day, surface, COUNT(*) AS impressions,
                   COUNT(DISTINCT place_id) AS distinct_places
            FROM num_place_impressions WHERE ts >= strftime('%s', 'now', '-${d} days')
            GROUP BY day, surface ORDER BY day DESC`,
    }),

    /* ══════════════════ 2 · THE FUNNEL ══════════════════ */

    M({
      id: 'funnel_member_cohort',
      section: 'funnel',
      definition:
        'The four-step funnel, computed over members CREATED in the window. Steps, each with its ' +
        'binding definition:\n' +
        '  NEW MEMBER      — a row in num_members with created_at in the window.\n' +
        '  FIRST ASK       — that member_id appears at least once in num_asks, at any time.\n' +
        '  FIRST USEFUL    — at least one of their asks has quality = \'\' (checked and clean, per\n' +
        '                    worker/asks.mjs:45-47) AND degraded = 0. NULL quality means NEVER CHECKED\n' +
        '                    and is deliberately NOT counted as useful — that distinction is the whole\n' +
        '                    point of the empty-string convention.\n' +
        '  RETURNED 7d     — asked on a SECOND distinct calendar day, no more than 7 days after their\n' +
        '                    first ask. Same-day repeat is not a return.\n' +
        'READ THIS WITH `attribution_coverage`: an ask carries member_id only when the client sent ' +
        'state.me.id (worker/funnel.test.mjs guards this), so a member who asked while signed out is ' +
        'invisible here and will read as a drop-out at step 2 when they were not one.',
      requires: ['num_members', 'num_asks'],
      sql: `WITH c AS (
              SELECT id, created_at FROM num_members
              WHERE created_at >= datetime('now', '-${d} days') AND id NOT IN (${EXCL_SQL})
            ), f AS (
              SELECT c.id,
                     (SELECT COUNT(*) FROM num_asks a WHERE a.member_id = c.id) AS asks,
                     (SELECT COUNT(*) FROM num_asks a WHERE a.member_id = c.id
                        AND a.quality = '' AND a.degraded = 0) AS clean_asks,
                     (SELECT MIN(substr(a.ts,1,10)) FROM num_asks a WHERE a.member_id = c.id) AS first_day,
                     (SELECT COUNT(DISTINCT substr(a.ts,1,10)) FROM num_asks a WHERE a.member_id = c.id
                        AND substr(a.ts,1,10) <= date(
                              (SELECT MIN(substr(a2.ts,1,10)) FROM num_asks a2 WHERE a2.member_id = c.id),
                              '+7 days')) AS days_in_first_week
              FROM c
            )
            SELECT COUNT(*) AS new_members,
                   SUM(CASE WHEN asks > 0 THEN 1 ELSE 0 END) AS reached_first_ask,
                   SUM(CASE WHEN clean_asks > 0 THEN 1 ELSE 0 END) AS reached_first_useful_answer,
                   SUM(CASE WHEN days_in_first_week >= 2 THEN 1 ELSE 0 END) AS returned_within_7d
            FROM f`,
    }),

    M({
      id: 'funnel_all_members_lifetime',
      section: 'funnel',
      definition:
        'The same four steps computed over EVERY member ever, not just the window cohort. At 125 ' +
        'members the windowed cohort is often a single-digit count where one person moves the ' +
        'percentage by 20 points; the lifetime figure is the one that is stable enough to trend. ' +
        'Excludes any id passed to --exclude-ids (the founder/admin account).',
      requires: ['num_members', 'num_asks'],
      sql: `WITH c AS (SELECT id FROM num_members WHERE id NOT IN (${EXCL_SQL})),
                 f AS (
              SELECT c.id,
                     (SELECT COUNT(*) FROM num_asks a WHERE a.member_id = c.id) AS asks,
                     (SELECT COUNT(*) FROM num_asks a WHERE a.member_id = c.id
                        AND a.quality = '' AND a.degraded = 0) AS clean_asks,
                     (SELECT COUNT(DISTINCT substr(a.ts,1,10)) FROM num_asks a WHERE a.member_id = c.id) AS days
              FROM c)
            SELECT COUNT(*) AS members,
                   SUM(CASE WHEN asks > 0 THEN 1 ELSE 0 END) AS ever_asked,
                   SUM(CASE WHEN clean_asks > 0 THEN 1 ELSE 0 END) AS ever_got_clean_answer,
                   SUM(CASE WHEN days >= 2 THEN 1 ELSE 0 END) AS asked_on_2plus_days
            FROM f`,
    }),

    M({
      id: 'funnel_web_events',
      section: 'funnel',
      definition:
        'The pre-signup web funnel from num_web_events (growth/worker.js, POST itsnum.com/api/ev), ' +
        'split by `page` so the landing page, /install and the app are never collapsed into one step ' +
        'happening twice (worker/funnel.test.mjs enforces this). An event name the worker does not ' +
        'recognise returns HTTP 200 {"ignored":true} and writes NOTHING — so a missing event name here ' +
        'may mean "never fired" OR "fired and silently dropped". Cross-check the KNOWN list in ' +
        'app-public/num-track.js against EVENTS in growth/worker.js before drawing a conclusion.\n' +
        'CORRECTED 26 Aug 2026. num_web_events.created_at is TEXT — "2026-08-26 20:27:19" — and this ' +
        'query read it as epoch MILLISECONDS: date(created_at/1000,\'unixepoch\'). SQLite returns 0 ' +
        'for the division, so EVERY row landed on 1970-01-01 and the day split was one bucket. The ' +
        'window was wrong in the opposite direction and hid it: comparing text against ' +
        "strftime('%s',…)*1000 is a cross-type comparison, and SQLite sorts every TEXT above every " +
        'INTEGER, so the WHERE matched the whole table forever. A funnel that showed all 1,752 events ' +
        'on one day in 1970 looked like a rendering quirk rather than a broken metric.',
      requires: ['num_web_events'],
      sql: `SELECT substr(created_at,1,10) AS day, page, event, COUNT(*) AS n,
                   COUNT(DISTINCT visitor_id) AS visitors
            FROM num_web_events WHERE created_at >= datetime('now','-${d} days')
            GROUP BY day, page, event ORDER BY day DESC, n DESC LIMIT 200`,
    }),

    M({
      id: 'funnel_web_events_lifetime_by_event',
      section: 'funnel',
      definition:
        'Every event name ever recorded in num_web_events, with first and last occurrence. This is the ' +
        'instrumentation-coverage check, not a usage metric: an event defined in the tracker but ' +
        'ABSENT from this list has never once been recorded, which is a broken tracker, not a ' +
        'behavioural finding. On 10 Aug 2026 exactly three event types existed here while fifteen were ' +
        'defined in the client (worker/funnel.test.mjs header).',
      requires: ['num_web_events'],
      sql: `SELECT event, page, COUNT(*) AS n,
                   MIN(substr(created_at,1,10)) AS first_seen,
                   MAX(substr(created_at,1,10)) AS last_seen
            FROM num_web_events GROUP BY event, page ORDER BY n DESC`,
    }),

    M({
      id: 'utm_attribution',
      section: 'funnel',
      definition:
        'Arrivals by utm_source/medium/campaign, from num_web_events. A blank utm_source is ' +
        '"organic OR a /go/ code that was not in the GO map". worker/index.mjs:621-652 defines exactly ' +
        'six codes (yt, ytb, ig, tt, rd, dg); an unknown code redirects to /watch/ UNTAGGED by design ' +
        '(a typo on a poster must cost attribution, never a visitor), so blank utm_source is an upper ' +
        'bound on organic, not a measurement of it.',
      requires: ['num_web_events'],
      sql: `SELECT COALESCE(NULLIF(utm_source,''),'(blank)') AS source,
                   COALESCE(NULLIF(utm_medium,''),'(blank)') AS medium,
                   COALESCE(NULLIF(utm_campaign,''),'(blank)') AS campaign,
                   COUNT(*) AS events, COUNT(DISTINCT visitor_id) AS visitors
            FROM num_web_events WHERE created_at >= datetime('now','-${d} days')
            GROUP BY source, medium, campaign ORDER BY visitors DESC LIMIT 40`,
    }),

    /* ══════════════════ 3 · QUALITY ══════════════════ */

    M({
      id: 'quality_flag_mix',
      section: 'quality',
      definition:
        'num_asks.quality holds the comma-joined flags from worker/quality.mjs `inspect()`, applied ' +
        'without a second model call. THE THREE STATES ARE NOT THE SAME:\n' +
        '  NULL  — the ask predates the quality check (added 11 Aug 2026). Never checked.\n' +
        "  ''    — checked, nothing wrong. This is the good case and the denominator of `clean_pct`.\n" +
        '  text  — one or more flags fired.\n' +
        'Counting NULL as clean would have made every pre-11-Aug ask look perfect, which is why the ' +
        'empty string exists at all (worker/asks.mjs:45-47).',
      requires: ['num_asks'],
      sql: `SELECT COUNT(*) AS asks,
                   SUM(CASE WHEN quality IS NULL THEN 1 ELSE 0 END) AS never_checked,
                   SUM(CASE WHEN quality = '' THEN 1 ELSE 0 END) AS clean,
                   SUM(CASE WHEN quality <> '' THEN 1 ELSE 0 END) AS flagged,
                   SUM(CASE WHEN quality LIKE '%invented-%' THEN 1 ELSE 0 END) AS f_invented,
                   SUM(CASE WHEN quality LIKE '%deflected-with-context%' THEN 1 ELSE 0 END) AS f_deflected,
                   SUM(CASE WHEN quality LIKE '%question-only%' THEN 1 ELSE 0 END) AS f_question_only,
                   SUM(CASE WHEN quality LIKE '%thin-recommendation%' THEN 1 ELSE 0 END) AS f_thin,
                   SUM(CASE WHEN quality LIKE '%no-verdict%' THEN 1 ELSE 0 END) AS f_no_verdict,
                   SUM(CASE WHEN quality LIKE '%off-topic%' THEN 1 ELSE 0 END) AS f_off_topic,
                   SUM(CASE WHEN quality LIKE '%long:%' THEN 1 ELSE 0 END) AS f_long
            FROM num_asks WHERE ts >= datetime('now', '-${d} days')`,
    }),

    M({
      id: 'could_not_help',
      section: 'quality',
      definition:
        'The closest available proxy for "Num said it could not help": asks whose quality flags ' +
        'include `deflected-with-context` (the model had real partner data in front of it and still ' +
        'deflected) or `question-only` (the reply asked a question back instead of answering). This ' +
        'is a PROXY, not a measurement — there is no explicit "I cannot help" signal in the reply ' +
        'schema. See `refusal_explicit` in the not-instrumented list.',
      requires: ['num_asks'],
      sql: `SELECT substr(ts,1,10) AS day, COUNT(*) AS asks,
                   SUM(CASE WHEN quality LIKE '%deflected-with-context%'
                             OR quality LIKE '%question-only%' THEN 1 ELSE 0 END) AS could_not_help_proxy
            FROM num_asks WHERE ts >= datetime('now', '-${d} days')
            GROUP BY day ORDER BY day DESC`,
    }),

    M({
      id: 'degraded_answers',
      section: 'quality',
      definition:
        'DEGRADED = the ask was answered by a fallback brain rather than the primary ' +
        '(worker/index.mjs:1041). A degraded answer is a real answer and is never cached ' +
        '(worker/index.mjs:1098) — it is counted here because a rising degraded rate is the earliest ' +
        'visible sign of a quota or provider problem, usually before num_health notices anything.',
      requires: ['num_asks'],
      sql: `SELECT substr(ts,1,10) AS day, COUNT(*) AS asks, SUM(degraded) AS degraded,
                   COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN degraded=1 THEN brain END),'') AS fallback_brains
            FROM num_asks WHERE ts >= datetime('now', '-${d} days')
            GROUP BY day ORDER BY day DESC`,
    }),

    M({
      id: 'cache_hit_rate',
      section: 'quality',
      definition:
        'CACHE HIT = num_asks.cached = 1, i.e. the answer came from num_answer_cache and cost no model ' +
        'call (worker/index.mjs:857). Reported under quality rather than cost because a high hit rate ' +
        'on a concierge is ambiguous: it is either efficiency or it is everyone asking the same ' +
        'shallow question, and the two need different responses.',
      requires: ['num_asks'],
      sql: `SELECT COUNT(*) AS asks, SUM(cached) AS from_cache,
                   ROUND(100.0 * SUM(cached) / NULLIF(COUNT(*),0), 1) AS cache_pct
            FROM num_asks WHERE ts >= datetime('now', '-${d} days')`,
    }),

    /* ══════════════════ 4 · MONEY ══════════════════ */

    M({
      id: 'subscriptions_active',
      section: 'money',
      definition:
        'ACTIVE SUBSCRIPTION = a row in num_memberships with tier <> \'free\' AND (renews_at IS NULL OR ' +
        'renews_at >= now). Granted by the Stripe webhook at worker/pay.mjs:388, renewed at :463, ' +
        'lapsed at :472. NOTE THE KNOWN DEFECT: the entitlements this tier sells are inert — ' +
        'membership.may() has zero callers (BACKEND_AUDIT_2026-08-17.md §6.2) — so a paying member ' +
        'currently receives exactly what a free member receives. This number is revenue, not value ' +
        'delivered, and must not be quoted as the latter.',
      requires: ['num_memberships'],
      sql: `SELECT tier, COUNT(*) AS members,
                   SUM(CASE WHEN renews_at IS NULL OR renews_at >= datetime('now') THEN 1 ELSE 0 END) AS active,
                   SUM(CASE WHEN renews_at IS NOT NULL AND renews_at < datetime('now') THEN 1 ELSE 0 END) AS lapsed,
                   COALESCE(GROUP_CONCAT(DISTINCT source),'') AS sources
            FROM num_memberships GROUP BY tier ORDER BY members DESC`,
    }),

    M({
      id: 'mrr_cents',
      section: 'money',
      definition:
        `MRR = SUM over ACTIVE subscriptions of the published monthly price of their tier, in cents ` +
        `(free 0, plus ${TIER_CENTS.plus}, pro ${TIER_CENTS.pro} — from GET /api/membership/tiers, ` +
        `probed 2026-08-17). This is CONTRACTED recurring revenue, not cash collected: a Stripe ` +
        `subscription that will fail its next charge still counts here. Cash collected is ` +
        `\`payments_collected\`. Star pack purchases are NOT MRR — they are one-off prepaid credit ` +
        `for Num's own service (docs/STATUS_FOR_DUKE Addendum 3) and are reported separately.`,
      requires: ['num_memberships'],
      sql: `SELECT
              SUM(CASE WHEN tier='plus' AND (renews_at IS NULL OR renews_at >= datetime('now'))
                       THEN ${TIER_CENTS.plus} ELSE 0 END) +
              SUM(CASE WHEN tier='pro'  AND (renews_at IS NULL OR renews_at >= datetime('now'))
                       THEN ${TIER_CENTS.pro}  ELSE 0 END) AS mrr_cents,
              SUM(CASE WHEN tier<>'free' AND (renews_at IS NULL OR renews_at >= datetime('now'))
                       THEN 1 ELSE 0 END) AS paying_members
            FROM num_memberships`,
    }),

    M({
      id: 'churn_30d',
      section: 'money',
      definition:
        'CHURN, AS FAR AS THIS SCHEMA ALLOWS: subscriptions whose renews_at fell in the last 30 days ' +
        'and is now in the past, i.e. they lapsed. THIS IS A WEAK MEASURE and must be labelled as ' +
        'such: num_memberships has one row per member with no state history, so a member who ' +
        'subscribed, cancelled and resubscribed is indistinguishable from one who never left, and a ' +
        'member downgraded straight to free leaves no trace of ever having paid. A proper churn ' +
        'number needs a membership_events table — see the not-instrumented list.',
      requires: ['num_memberships'],
      sql: `SELECT COUNT(*) AS lapsed_30d,
                   COALESCE(GROUP_CONCAT(DISTINCT tier),'') AS tiers
            FROM num_memberships
            WHERE renews_at IS NOT NULL AND renews_at < datetime('now')
              AND renews_at >= datetime('now','-30 days')`,
    }),

    M({
      id: 'payments_collected',
      section: 'money',
      definition:
        'CASH COLLECTED = num_payments rows with state = \'paid\', summed by amount_cents. This is the ' +
        'only money figure on this page that represents money that actually arrived. A row in state ' +
        '\'created\' is an abandoned or pending Stripe Checkout session and is NEVER revenue — it is ' +
        'reported alongside because the ratio of created to paid is the checkout abandonment rate.',
      requires: ['num_payments'],
      sql: `SELECT state, COUNT(*) AS n, SUM(amount_cents) AS cents,
                   MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
            FROM num_payments GROUP BY state ORDER BY n DESC`,
    }),

    M({
      id: 'payments_recent',
      section: 'money',
      definition:
        'The same cash figure restricted to the window, so a lifetime total can never be mistaken for ' +
        'this period\'s revenue — the single most common way a revenue number gets overstated.',
      requires: ['num_payments'],
      sql: `SELECT substr(COALESCE(paid_at, created_at),1,10) AS day, state, COUNT(*) AS n,
                   SUM(amount_cents) AS cents
            FROM num_payments WHERE COALESCE(paid_at, created_at) >= datetime('now','-${d} days')
            GROUP BY day, state ORDER BY day DESC`,
    }),

    M({
      id: 'stars_movement',
      section: 'money',
      definition:
        'Star flow, kept strictly separate from cash. num_star_ledger = Stars MINTED by a purchase ' +
        '(worker/pay.mjs). num_star_moves = Stars moving BETWEEN members (transfers, tab settlement, ' +
        'errand escrow, worker/social.mjs). Num Stars are closed-loop: purchased Stars have no path to ' +
        'money, earned Stars cash out only via the 5arz payout desk, which is currently switched off ' +
        '(/api/cashout/status → open:false). A Star balance is a liability, never revenue.',
      requires: ['num_star_moves'],
      sql: `SELECT kind, COUNT(*) AS moves, SUM(delta) AS net_stars,
                   MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
            FROM num_star_moves GROUP BY kind ORDER BY moves DESC`,
    }),

    M({
      id: 'affiliate_handoffs',
      section: 'money',
      definition:
        'HANDOFF = one outbound partner link Num put in front of a guest, one row in ' +
        'num_affiliate_clicks (worker/affiliateclicks.mjs), deduplicated per host per reply. It is ' +
        'NOT a click: the tap happens on somebody else\'s domain and Num never sees it, so this is ' +
        'the DENOMINATOR of a click-through rate we cannot yet compute. Never report a handoff count ' +
        'as traffic delivered.\n' +
        'Two call sites write it: worker/index.mjs (surface=service_option — every provider link in a ' +
        'concierge reply, and today the only one that fires) and worker/openapi.mjs (surface=book_link ' +
        '— POST /api/book/link, which returns bookable:false for almost every venue because only a ' +
        'handful of rows in `places` carry a booking_platform).\n' +
        'tagged=1 means a ref parameter actually landed on the URL, so the destination could pay us. ' +
        'tagged=0 means we handed the traffic away for nothing — and the hosts at the top of that ' +
        'list, ranked by volume, ARE the list of programmes to apply for next. That is what this ' +
        'metric is for. Money earned is NOT here and cannot be: it lives in each network\'s own ' +
        'dashboard, and only lands weeks later net of cancellations (see `affiliate_revenue`).',
      requires: ['num_affiliate_clicks'],
      sql: `SELECT host,
                   COALESCE(programme, '(none)') AS programme,
                   SUM(CASE WHEN tagged = 1 THEN 1 ELSE 0 END) AS tagged_handoffs,
                   SUM(CASE WHEN tagged = 0 THEN 1 ELSE 0 END) AS untagged_handoffs,
                   COUNT(*) AS handoffs,
                   COUNT(DISTINCT kind) AS kinds,
                   COUNT(DISTINCT dest) AS dests
            FROM num_affiliate_clicks
            WHERE event = 'handoff' AND ts >= strftime('%s','now','-${d} days')
            GROUP BY host, programme
            ORDER BY handoffs DESC`,
    }),

    M({
      id: 'sourced_handoffs',
      section: 'money',
      definition:
        'Handoffs for venues somebody INTRODUCED, grouped by the scout credited with them.\n' +
        'This is the answer to "if we use one of the links Adam and Sean brought us, is their ' +
        'commission tied to it" — a question that had no answer anywhere in the system until ' +
        'num_affiliate_clicks.place_id and .scout_id existed, because the click log recorded a HOST ' +
        '(synxis.com, one engine a thousand hotels share) and never the PLACE.\n' +
        'scout_id is COPIED onto the row at the moment of the handoff, not joined at read time. So ' +
        'this number keeps saying what it said even after an introduction is transferred, ended or ' +
        'voided — it is a record of what happened, not a live view of the programme.\n' +
        'HANDOFFS ARE NOT MONEY, and this is the metric where that mistake would be most expensive. ' +
        'A handoff is a link Num put in front of a guest; whether anyone booked is known only to the ' +
        "booking platform, and what NUM collected on it lives in num_commissions. Nothing here is " +
        'owed to anybody. What is owed is num_scout_earnings, gated on the venue having produced its ' +
        'first finder_gate_minor of real revenue — see worker/migrations/0006_scouts.sql for why ' +
        'paying on anything earlier is a trap.\n' +
        'attributed_places < the scout\'s total introductions is normal and not a fault: it counts ' +
        'the venues whose links were actually handed out in the window.',
      requires: ['num_affiliate_clicks', 'num_scouts'],
      sql: `SELECT COALESCE(s.name, '(scout ' || a.scout_id || ')') AS scout,
                   s.code AS code,
                   COUNT(*) AS handoffs,
                   COUNT(DISTINCT a.place_id) AS attributed_places,
                   SUM(CASE WHEN a.tagged = 1 THEN 1 ELSE 0 END) AS tagged_handoffs,
                   COUNT(DISTINCT a.host) AS hosts,
                   MAX(a.ts) AS last_ts
            FROM num_affiliate_clicks a
            LEFT JOIN num_scouts s ON s.id = a.scout_id
            WHERE a.scout_id IS NOT NULL
              AND a.event = 'handoff'
              AND a.ts >= strftime('%s','now','-${d} days')
            GROUP BY a.scout_id
            ORDER BY handoffs DESC`,
    }),

    M({
      id: 'unattributed_bookable_handoffs',
      section: 'money',
      definition:
        'Venue booking links handed out for places NOBODY is credited with. The counterpart to ' +
        'sourced_handoffs, and the more useful of the two while the scout programme is young: a ' +
        'venue appearing here with real volume is either genuinely unsourced, or an introduction ' +
        'that was never recorded. The second case is the expensive one, because usage that happens ' +
        'before a record exists is usage nobody can ever reconstruct.\n' +
        'Rows with a NULL place_id are excluded on purpose — those are city-level provider links ' +
        '(a ride app, an airline) which belong to nobody in particular and never will.',
      requires: ['num_affiliate_clicks'],
      sql: `SELECT a.place_id,
                   COALESCE(p.name, '(unknown place)') AS name,
                   a.dest AS dest,
                   COUNT(*) AS handoffs,
                   COUNT(DISTINCT a.host) AS hosts,
                   MAX(a.ts) AS last_ts
            FROM num_affiliate_clicks a
            LEFT JOIN places p ON p.id = a.place_id
            WHERE a.place_id IS NOT NULL
              AND a.scout_id IS NULL
              AND a.event = 'handoff'
              AND a.ts >= strftime('%s','now','-${d} days')
            GROUP BY a.place_id
            ORDER BY handoffs DESC
            LIMIT 25`,
    }),

    /* ══════════════════ 5 · THE 5arz LINK RATE ══════════════════ */

    M({
      id: 'link_rate_5arz',
      section: 'link_5arz',
      definition:
        'THE COMPANY\'S MOST IMPORTANT NUMBER.\n' +
        'LINKED MEMBER = num_members.identity_verified = 1, written only by verifyVia5arz on a ' +
        'successful Google-Identity link to a verified 5arz account (worker/social.mjs:911, :917).\n' +
        'LINK RATE = linked members / total members.\n' +
        'REAL LINK RATE = the same, with the founder\'s admin account(s) excluded via --exclude-ids. ' +
        'Reporting the un-excluded figure is how 1 real link becomes "2 members linked" — at n=125 a ' +
        'single internal account is 0.8 percentage points and half the numerator.\n' +
        'This metric measures the OUTCOME only. It cannot tell you how many members were ever ASKED, ' +
        'which is the number that actually diagnoses the problem — see `consent_funnel` below.',
      requires: ['num_members'],
      sql: `SELECT COUNT(*) AS members,
                   SUM(CASE WHEN identity_verified = 1 THEN 1 ELSE 0 END) AS linked_all,
                   SUM(CASE WHEN identity_verified = 1 AND id NOT IN (${EXCL_SQL}) THEN 1 ELSE 0 END) AS linked_excl,
                   SUM(CASE WHEN id NOT IN (${EXCL_SQL}) THEN 1 ELSE 0 END) AS members_excl,
                   ROUND(100.0 * SUM(CASE WHEN identity_verified = 1 AND id NOT IN (${EXCL_SQL}) THEN 1 ELSE 0 END)
                         / NULLIF(SUM(CASE WHEN id NOT IN (${EXCL_SQL}) THEN 1 ELSE 0 END),0), 2) AS real_link_rate_pct,
                   SUM(CASE WHEN phone_verified = 1 THEN 1 ELSE 0 END) AS phone_verified
            FROM num_members`,
    }),

    M({
      id: 'link_rate_by_cohort',
      section: 'link_5arz',
      definition:
        'The same link rate split by signup month, so that a change in the ASK (copy, placement, ' +
        'trigger) can be attributed to the cohort that saw it rather than diluted across every member ' +
        'who ever joined. Without this split, a doubled conversion on new members is invisible for ' +
        'months behind the lifetime average.',
      requires: ['num_members'],
      sql: `SELECT substr(created_at,1,7) AS cohort_month, COUNT(*) AS members,
                   SUM(CASE WHEN identity_verified = 1 THEN 1 ELSE 0 END) AS linked,
                   SUM(CASE WHEN phone_verified = 1 THEN 1 ELSE 0 END) AS phone_verified
            FROM num_members WHERE id NOT IN (${EXCL_SQL})
            GROUP BY cohort_month ORDER BY cohort_month DESC`,
    }),

    M({
      id: 'members_growth',
      section: 'link_5arz',
      definition:
        'New members per day, the denominator of everything above. num_members.created_at is set by ' +
        'the row default and is the moment the record was made, which for Num is the moment somebody ' +
        'typed a name — not a verified identity and not an active user.',
      requires: ['num_members'],
      sql: `SELECT substr(created_at,1,10) AS day, COUNT(*) AS new_members
            FROM num_members WHERE created_at >= datetime('now','-${d} days')
            GROUP BY day ORDER BY day DESC`,
    }),

    /* ══════════════════ 6 · ERRORS AND SILENCE ══════════════════ */

    M({
      id: 'health_verdicts',
      section: 'errors',
      definition:
        'The 5-minute self-check (worker/health.mjs, cron in wrangler.app.jsonc). VERDICT is `ok` or ' +
        'degraded/failing with a `failing` list. The checks are aimed specifically at failures that ' +
        'return HTTP 200 — a read-only database, a dead brain key, a pay rail that can charge but ' +
        'never deliver — so `ok` here means more than "the site responded".',
      requires: ['num_health'],
      sql: `SELECT substr(at,1,10) AS day, verdict, COUNT(*) AS checks,
                   COALESCE(GROUP_CONCAT(DISTINCT failing),'') AS failing_seen
            FROM num_health WHERE at >= datetime('now','-${d} days')
            GROUP BY day, verdict ORDER BY day DESC`,
    }),

    M({
      id: 'health_incidents',
      section: 'errors',
      definition:
        'Every individual non-ok check in the window, listed rather than counted. At this volume a ' +
        'count hides the thing that matters — whether five failures were one 25-minute incident or ' +
        'five separate ones on five days. If this returns no rows, that is a genuine zero: the table ' +
        'is written every 5 minutes regardless of verdict.',
      requires: ['num_health'],
      sql: `SELECT at, verdict, failing FROM num_health
            WHERE at >= datetime('now','-${d} days') AND verdict <> 'ok'
            ORDER BY at DESC LIMIT 100`,
    }),

    M({
      id: 'brain_failures',
      section: 'errors',
      definition:
        'Per-brain failures from num_brain_events (worker/brainstate.mjs): which brain failed, its ' +
        'error class, and when. This is the supply side of `degraded_answers` — that metric says how ' +
        'many guests got a fallback, this one says why. A brain with many events is not necessarily ' +
        'bad; a brain with many events AND a high position in the chain is what costs answers.',
      requires: ['num_brain_events'],
      sql: `SELECT brain, COALESCE(class,'(none)') AS class, COUNT(*) AS events,
                   MAX(datetime(ts,'unixepoch')) AS last_seen
            FROM num_brain_events WHERE ts >= strftime('%s','now','-${d} days')
            GROUP BY brain, class ORDER BY events DESC`,
    }),

    M({
      id: 'silent_days',
      section: 'errors',
      definition:
        'Calendar days in the window with ZERO rows in num_asks. A silent day is either a real day ' +
        'with no users or a day the recording path was broken, and those look identical here — which ' +
        'is precisely why it is listed as a metric rather than left to be noticed. Cross-check any ' +
        'silent day against `health_verdicts` and against a deploy in CHANGELOG.md before concluding ' +
        'anything about demand.',
      requires: ['num_asks'],
      sql: `WITH RECURSIVE days(d) AS (
              SELECT date('now', '-${d} days')
              UNION ALL SELECT date(d, '+1 day') FROM days WHERE d < date('now')
            )
            SELECT days.d AS day,
                   (SELECT COUNT(*) FROM num_asks a WHERE substr(a.ts,1,10) = days.d) AS asks
            FROM days ORDER BY days.d DESC`,
    }),
  ];
}

/* ───────────────────────── what cannot be measured at all ─────────────────────────
 *
 * These are NOT zeros. Nothing in the codebase writes them. Each names the
 * instrumentation that would have to exist. They are emitted in the JSON so a
 * reader of the output can never mistake absence for a finding.
 */

const NOT_INSTRUMENTED = [
  {
    id: 'consent_funnel',
    section: 'link_5arz',
    definition:
      'The Num → 5arz consent funnel: eligible → shown → engaged → screen viewed → identity ' +
      'challenge → outcome → granted, per HQ/divisions/num/CONSENT_FUNNEL_INSTRUMENTATION.md §3. ' +
      'Without it, `link_rate_5arz` gives the numerator and no denominator: we cannot tell an ask ' +
      'nobody accepts from an ask nobody sees, and those have opposite fixes.',
    needs:
      'worker/consent.mjs + table num_consent_funnel (spec §4) + POST /api/consent/event (spec §5.1) ' +
      '+ funnel writes at all eight terminal returns of verifyVia5arz (worker/social.mjs:800, 806, ' +
      '817, 821, 844, 851, 867, 888) + Consent5arzTeaser.tsx / Consent5arzSheet.tsx. ' +
      'The single highest-value instrumentation gap in the company.',
  },
  {
    id: 'consent_ask_shown_count',
    section: 'link_5arz',
    definition:
      'How many members have ever SEEN the 5arz ask. The card at src/components/app/Verify5arz.tsx ' +
      'is rendered inside the profile screen (ProfileView.tsx:225), which is reached from a "YOU" ' +
      'affordance, not a tab. Nobody has ever measured how many members open it.',
    needs: 'consent_prompt_shown (IntersectionObserver ≥50% for ≥400ms) per spec §3.1.',
  },
  {
    id: 'asks_that_got_no_answer',
    section: 'errors',
    definition:
      'Turns where the guest got NOTHING useful: every brain failed and either lastresort.mjs ' +
      'answered from the directory, or the apology path fired. VERIFIED ABSENT: recordAsk() is ' +
      'called at worker/index.mjs:857 (cache lane) and :1036 (successful answer) and NOWHERE in the ' +
      'catch block at :1112-1183. So an outage makes num_asks go QUIET rather than go RED, and the ' +
      'worst days in the product\'s history are the ones that look like low demand.',
    needs:
      'A recordAsk() call in the catch path with lane=\'lastresort\' | \'apology\' and degraded=1. ' +
      '~6 lines in worker/index.mjs. Cheapest high-value fix on this list.',
  },
  {
    id: 'answer_not_acted_on',
    section: 'quality',
    definition:
      'Whether the guest DID anything with the answer — tapped the card, opened the booking deep ' +
      'link, saved the place, asked a follow-up about it. Today an answer that delighted somebody and ' +
      'an answer they ignored are the same row.',
    needs:
      'A client action event joined to num_asks.id (the id is already returned by recordAsk for ' +
      'exactly this kind of join, worker/asks.mjs:90-93), plus a click-through record on ' +
      '/api/book/link and the card CTA.',
  },
  {
    id: 'refusal_explicit',
    section: 'quality',
    definition:
      'How often Num explicitly said it could not help. The reply schema (worker/prompt.mjs ' +
      'REPLY_SCHEMA) has no refusal field, so this is currently inferred from quality flags, which is ' +
      'a proxy and is reported as one (`could_not_help`).',
    needs: 'A `refused` boolean (and reason) in REPLY_SCHEMA, persisted to num_asks.',
  },
  {
    id: 'lastresort_served',
    section: 'quality',
    definition:
      'How many guests were served by lastresort.mjs — the no-model directory answer. It logs one ' +
      'console.warn (worker/index.mjs:1160) and writes no row.',
    needs: 'Same fix as `asks_that_got_no_answer`, or a counter table.',
  },
  {
    id: 'affiliate_revenue',
    section: 'money',
    definition:
      'MONEY EARNED on outbound partner traffic. Half of this gap closed on 2026-08-18: ' +
      'num_affiliate_clicks now exists and every outbound link is logged tagged or not (see the ' +
      'measured metric `affiliate_handoffs`). What is still absent is the revenue itself, and it ' +
      'cannot be inferred from this side of the link. A commission is created by a booking Num never ' +
      'sees, on somebody else\'s domain, and is confirmed weeks later net of cancellations — ' +
      'Booking.com in particular pays only after the stay COMPLETES and reverses the commission if ' +
      'the guest cancels. Any revenue figure computed from handoffs × a rate card would be a ' +
      'forecast wearing an actual\'s clothes. Do not build one.\n' +
      'Also note this is zero until NUM_AFFILIATES is set: with the secret unset, affiliate.mjs:52-59 ' +
      'returns an empty table, every handoff logs tagged=0, and no programme can pay us.',
    needs:
      'NUM_AFFILIATES set (config only — see HQ/divisions/num/AFFILIATE_ACTIVATION.md), at least one ' +
      'programme approved, and then a monthly reconciliation against each network\'s own statement — ' +
      'Travelpayouts and Impact both expose a reporting API. Book that as a finance import, never as ' +
      'a number this script derives.',
  },
  {
    id: 'affiliate_taps',
    section: 'money',
    definition:
      'Whether the guest actually FOLLOWED an outbound link. num_affiliate_clicks reserves ' +
      'event=\'tap\' for exactly this and nothing writes it: the tap happens in the guest\'s browser ' +
      'on a third-party domain. Until it exists, `affiliate_handoffs` is a denominator with no ' +
      'numerator and no click-through rate can be honestly quoted.',
    needs:
      'A client-side beacon on the service-option and booking CTAs posting {host, kind} to a small ' +
      'endpoint that calls recordHandoffs(..., { event: \'tap\' }). The table and the write path ' +
      'already exist; this is the client half only.',
  },
  {
    id: 'http_error_rate',
    section: 'errors',
    definition:
      'The 4xx/5xx rate per endpoint. No request log exists in D1 by design — the Worker records ' +
      'domain events, not traffic. `observability: { enabled: true }` in wrangler.app.jsonc means the ' +
      'data exists in Cloudflare for the retention window, but it is not queryable from this script.',
    needs:
      'Either a Logpush job to R2 plus a nightly rollup, or the Cloudflare GraphQL Analytics API ' +
      '(workersInvocationsAdaptive) with an account token — the latter is a few hours\' work and ' +
      'gives status-code-by-route directly.',
  },
  {
    id: 'membership_state_history',
    section: 'money',
    definition:
      'True churn, upgrade and downgrade counts. num_memberships holds current state only, one row ' +
      'per member, so every transition overwrites its own history.',
    needs:
      'A num_membership_events append-only table written at worker/pay.mjs:388 (grant), :463 ' +
      '(renew) and :472 (lapse) — the three places that already know a transition happened.',
  },
  {
    id: 'entitlement_consumption',
    section: 'money',
    definition:
      'What paying members actually consume against their tier limits. num_usage_counters exists and ' +
      'is written by membership.countUse(), which has ZERO CALLERS ' +
      '(BACKEND_AUDIT_2026-08-17.md §6.2). The table will therefore be present and empty — the ' +
      'canonical example of why empty and not-instrumented must be told apart.',
    needs: 'Wire membership.may() / countUse() into the four gated features. ~2 days.',
  },
  {
    id: 'session_length_true',
    section: 'usage',
    definition:
      'Time actually spent with Num, including reading. `sessions_and_length` measures the span ' +
      'between first and last ASK, so a member who asked once and read the answer for four minutes ' +
      'scores 0 seconds. The number is honest about what it is and is not a time-in-app metric.',
    needs: 'Client heartbeat or a foreground/background event pair; low priority next to the above.',
  },
];

/* ───────────────────────── run ───────────────────────── */

function main() {
  const startedAt = new Date().toISOString();
  const report = {
    report: 'num-nightly-analytics',
    version: 1,
    generated_at: startedAt,
    window_days: DAYS,
    database: DB,
    excluded_member_ids: EXCLUDE,
    caveat:
      'Num has ~125 members. At this sample size almost every rate below is anecdote, not statistics: ' +
      'one person changes a percentage by a full point, and a day-over-day move of a few units is ' +
      'noise. Trend the counts over weeks; do not act on a single night\'s percentage. The metrics ' +
      'worth watching nightly anyway are the ones where a single event is meaningful in itself — a ' +
      'new 5arz link, a paid subscription, a non-ok health verdict, a silent day.',
    tables: {},
    metrics: {},
    not_instrumented: {},
    errors: [],
  };

  // 1 · which of the tables we care about actually exist
  let present = new Set();
  if (!DRY) {
    const rows = d1(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${Object.keys(OWNED_TABLES).map(sq).join(',')})`,
    );
    present = new Set(rows.map((r) => r.name));
  }

  // 2 · row counts, so an existing-but-empty table is visibly different from a missing one
  for (const [t, owner] of Object.entries(OWNED_TABLES)) {
    if (!present.has(t)) {
      report.tables[t] = { exists: false, rows: null, status: 'not_created', owner };
      continue;
    }
    try {
      const n = DRY ? 0 : (d1(`SELECT COUNT(*) AS n FROM ${t}`)[0]?.n ?? 0);
      report.tables[t] = {
        exists: true, rows: n, owner,
        status: n === 0 ? 'exists_empty_never_written' : 'populated',
      };
    } catch (e) {
      report.tables[t] = { exists: true, rows: null, status: 'error', owner, error: String(e.message ?? e).slice(0, 300) };
    }
  }

  // 3 · the metrics
  for (const m of metrics(DAYS)) {
    const missing = m.requires.filter((t) => !present.has(t));
    const entry = { section: m.section, definition: m.definition, requires: m.requires, sql: m.sql.replace(/\s+/g, ' ').trim() };
    if (DRY) { report.metrics[m.id] = { ...entry, status: 'dry_run' }; continue; }
    if (missing.length) {
      report.metrics[m.id] = { ...entry, status: 'not_instrumented', reason: `missing table(s): ${missing.join(', ')}`, rows: null };
      continue;
    }
    try {
      const rows = d1(m.sql);
      report.metrics[m.id] = { ...entry, status: rows.length ? 'measured' : 'measured_empty', rows };
    } catch (e) {
      const msg = String(e.message ?? e).slice(0, 500);
      report.metrics[m.id] = { ...entry, status: 'error', rows: null, error: msg };
      report.errors.push({ metric: m.id, error: msg });
    }
  }

  // 4 · the honest blank spaces
  for (const n of NOT_INSTRUMENTED) {
    report.not_instrumented[n.id] = { section: n.section, definition: n.definition, needs: n.needs, status: 'not_instrumented', rows: null };
  }

  report.finished_at = new Date().toISOString();

  const json = JSON.stringify(report, null, 2);
  if (OUT) { writeFileSync(OUT, json); console.error(`wrote ${OUT} (${json.length} bytes)`); }
  else process.stdout.write(json + '\n');
}

main();
