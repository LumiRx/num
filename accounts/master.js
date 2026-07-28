/**
 * NUM · master database endpoint.
 *
 * One screen over 63 tables. The SQL lives in scripts/master_views.sql as eight
 * v_master_* views; this file reads them, transposes the wide totals row into
 * labelled sections, and hands the result to the console. No business logic
 * lives here — if a number is wrong, the view is wrong.
 *
 * Mounted at itsnum.com/api/master. Admin session required: this surface
 * carries money, guest counts and the whole supply picture. It is HQ data, not
 * partner data.
 *
 * v_master_totals scans the entire places table (455k rows and climbing), so
 * the payload is cached at the edge for five minutes. The admin check runs on
 * every request BEFORE the cache is consulted, so a cache hit can never be
 * served to someone who is not entitled to it. ?fresh=1 skips the cache.
 */

const TTL_SECONDS = 300;
const CACHE_KEY = 'https://itsnum.com/__cache/master/v1';

// [column, label, format, denominator]
// The denominator turns a bare count into a share — "96,302 phone numbers" is
// a number; "96,302 of 455,227" is a coverage figure you can act on.
const SECTIONS = [
  {
    title: 'Supply',
    note: 'What the database physically holds.',
    metrics: [
      ['places', 'Places', 'int'],
      ['destinations_ingested', 'Destinations ingested', 'int'],
      ['destinations_live', 'Destinations live', 'int'],
      ['ranked_places', 'Ranked recommendations', 'int'],
      ['claimed', 'Claimed by owners', 'int', 'places'],
    ],
  },
  {
    title: 'Reachability',
    note: 'How many of those businesses we can actually contact. This is the outreach ceiling.',
    metrics: [
      ['with_phone', 'With phone', 'int', 'places'],
      ['with_email', 'With email', 'int', 'places'],
      ['with_website', 'With website', 'int', 'places'],
    ],
  },
  {
    title: 'Quality signal',
    note: 'A rating is customer opinion. A hygiene score is a council inspection. They are different claims about the world and are never merged into one number.',
    metrics: [
      ['with_rating', 'With customer rating', 'int', 'places'],
      ['with_hygiene', 'With hygiene score', 'int', 'places'],
      ['with_local_name', 'With local-script name', 'int', 'places'],
    ],
  },
  {
    title: 'Outreach',
    metrics: [
      ['leads', 'Leads', 'int'],
      ['leads_worked', 'Worked', 'int', 'leads'],
    ],
  },
  {
    title: 'Guests',
    metrics: [
      ['guests', 'Guest profiles', 'int'],
      ['guests_7d', 'Active in last 7 days', 'int', 'guests'],
      ['messages', 'Messages', 'int'],
      ['messages_7d', 'Messages, last 7 days', 'int', 'messages'],
      ['requests', 'Requests', 'int'],
      ['requests_fulfilled', 'Fulfilled', 'int', 'requests'],
      ['unmet_demand', 'Unmet demand logged', 'int'],
    ],
  },
  {
    title: 'Commerce',
    metrics: [
      ['bookings', 'Bookings', 'int'],
      ['orders', 'Orders', 'int'],
      ['taps', 'Taps', 'int'],
      ['businesses', 'Businesses', 'int'],
      ['claims', 'Claims', 'int'],
      ['accounts', 'Accounts', 'int'],
    ],
  },
  {
    title: 'Money',
    note: 'Held in integer minor units end to end. Nothing is divided in SQL; the display below is the only place a decimal point appears.',
    metrics: [
      ['order_value_cs', 'Order value', 'money'],
      ['order_commission_cs', 'Order commission', 'money'],
      ['booking_value_cs', 'Booking value', 'money'],
      ['booking_commission_cs', 'Booking commission', 'money'],
      ['stars_issued', 'Stars issued', 'int'],
      ['stars_outstanding', 'Stars outstanding', 'int'],
    ],
  },
];

// The eleven v_num_* invariant views each return rows that should not exist.
// A row here is not a metric — it is a named bug.
const ALARMS = [
  ['wallet_unbalanced', 'Wallets that do not balance'],
  ['wallet_drift', 'Wallet drift'],
  ['stale_holds', 'Stale holds'],
  ['orphan_claims', 'Orphan claims'],
  ['charged_not_confirmed', 'Charged but never confirmed'],
  ['bookings_without_claims', 'Bookings without claims'],
  ['silent_failures', 'Silent failures'],
  ['tenant_violations', 'Tenant violations'],
  ['template_gaps', 'Template coverage gaps'],
  ['lessons_underperforming', 'Lessons underperforming'],
];

function build(totals, alarms, destinations, sources, buckets, leads) {
  const sections = SECTIONS.map((s) => ({
    title: s.title,
    note: s.note || null,
    metrics: s.metrics
      // A view that loses a column should drop that metric, not render "undefined".
      .filter(([key]) => totals && totals[key] !== undefined && totals[key] !== null)
      .map(([key, label, format, of]) => ({
        key, label, format,
        value: totals[key],
        of: of ? (totals[of] || 0) : null,
      })),
  })).filter((s) => s.metrics.length);

  const alarmRows = ALARMS.map(([key, label]) => ({
    key, label, value: (alarms && alarms[key]) || 0,
  }));

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    sections,
    alarms: alarmRows,
    alarms_total: alarmRows.reduce((a, r) => a + r.value, 0),
    destinations,
    // Attribution is a publishing condition, not a footnote. Anything arriving
    // from a source we have not cleared is flagged here so the console can
    // refuse to render it rather than quietly putting it on a page.
    sources: (sources || []).map((r) => ({
      ...r, publishable: String(r.attribution || '').indexOf('do not publish') === -1,
    })),
    buckets,
    leads,
  };
}

export async function handleMaster(env, request, requireAdmin) {
  const admin = await requireAdmin(env, request);
  if (!admin) {
    return new Response(JSON.stringify({ error: 'forbidden' }),
      { status: 403, headers: { 'content-type': 'application/json' } });
  }

  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  // The cache key carries no cookie and no account identity on purpose: the
  // payload is identical for every admin, and the entitlement check above has
  // already run. Nothing reaches this line unauthenticated.
  const cache = caches.default;
  const cacheKey = new Request(CACHE_KEY, { method: 'GET' });

  if (!fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      return new Response(await hit.text(), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-master-cache': 'hit' },
      });
    }
  }

  const [t, a, d, s, b, l] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM v_master_totals'),
    env.DB.prepare('SELECT * FROM v_master_alarms'),
    env.DB.prepare('SELECT * FROM v_master_destination ORDER BY places DESC, dest ASC'),
    env.DB.prepare('SELECT * FROM v_master_source ORDER BY places DESC'),
    env.DB.prepare('SELECT * FROM v_master_top_places ORDER BY ranked DESC'),
    env.DB.prepare('SELECT * FROM v_master_leads ORDER BY leads DESC'),
  ]);

  const body = JSON.stringify(build(
    (t.results || [])[0] || {}, (a.results || [])[0] || {},
    d.results || [], s.results || [], b.results || [], l.results || [],
  ));

  // Two responses off one string: the cached copy carries a max-age so the edge
  // will keep it, the returned copy carries no-store so the browser will not.
  // Caching in the browser would survive sign-out, which is the one place this
  // data must never linger.
  await cache.put(cacheKey, new Response(body, {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${TTL_SECONDS}` },
  }));

  return new Response(body, {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-master-cache': 'miss' },
  });
}
