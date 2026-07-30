/**
 * NUM · Scout — the always-on "what's new" agent.
 *
 * Every destination gets swept on a cron for openings, closings and lists:
 * new restaurants, bar and club launches, hotel debuts, "best of" roundups.
 * Sources are free and public RSS — Google News queries plus city food-press
 * feeds. Nothing is scraped behind a paywall; we store the headline, source
 * link and a one-line summary, then link OUT to the publisher.
 *
 * Results land in the `buzz` table of num-db, which every channel reads:
 * the app (/api/num), the LINE brain, and WhatsApp — one shared memory.
 *
 * Deploy:  cd scout && npx wrangler deploy
 * Manual:  curl -X POST https://num-scout.<sub>.workers.dev/sweep?key=...
 */

const GNEWS = 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=';

/** Per-destination query set — deliberately narrow so the signal stays high. */
const QUERIES = [
  (city) => `"new restaurant" OR "now open" ${city}`,
  (city) => `restaurant opening ${city} this month`,
  (city) => `best new bars OR nightlife ${city}`,
  (city) => `hotel opening ${city}`,
];

/** City food/travel press with public feeds — higher quality than news search. */
const CITY_FEEDS = {
  'los-angeles': ['https://la.eater.com/rss/index.xml', 'https://www.timeout.com/los-angeles/restaurants/rss.xml'],
  'new-york': ['https://ny.eater.com/rss/index.xml', 'https://www.timeout.com/newyork/restaurants/rss.xml'],
  miami: ['https://miami.eater.com/rss/index.xml', 'https://www.timeout.com/miami/restaurants/rss.xml'],
  'orange-county': ['https://la.eater.com/rss/index.xml'],
  dubai: ['https://www.timeout.com/dubai/restaurants/rss.xml'],
  'abu-dhabi': ['https://www.timeout.com/abu-dhabi/restaurants/rss.xml'],
  london: ['https://london.eater.com/rss/index.xml', 'https://www.timeout.com/london/restaurants/rss.xml'],
  paris: ['https://www.timeout.com/paris/restaurants/rss.xml'],
  bangkok: ['https://www.timeout.com/bangkok/restaurants/rss.xml'],
  singapore: ['https://www.timeout.com/singapore/restaurants/rss.xml'],
  tokyo: ['https://www.timeout.com/tokyo/restaurants/rss.xml'],
};

const UA = 'NUM-scout/1.0 (+https://itsnum.com; info@5arz.com)';

// ── tiny XML helpers (no deps; RSS and Atom both) ──────────────────────
const strip = (s = '') =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
      if (named[e.toLowerCase()]) return named[e.toLowerCase()];
      if (e[0] === '#') return String.fromCharCode(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? strip(m[1]) : null;
};

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) ?? [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    let link = tag(b, 'link');
    if (!link) link = b.match(/<link[^>]+href=["']([^"']+)/i)?.[1] ?? null;
    const date = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published');
    const summary = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content');
    const source = tag(b, 'source');
    if (title && link) items.push({ title, link, date, summary: summary?.slice(0, 400) ?? null, source });
  }
  return items;
}

// Openings/launches/lists only — filters out reviews of old places, closures
// framed as news, and generic travel chatter.
const RELEVANT = /\b(open(s|ed|ing)?|debut|launch(es|ed|ing)?|new|arriv(es|ed|ing)|unveil|best|top \d+|hottest|coming soon)\b/i;
const NOISE = /\b(recall|lawsuit|shooting|fire|closes? for good|permanently closed|bankrupt)\b/i;

async function fetchFeed(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: ctrl.signal });
    if (!res.ok) return [];
    return parseFeed(await res.text());
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS buzz (
       id TEXT PRIMARY KEY,
       dest TEXT NOT NULL,
       title TEXT NOT NULL,
       url TEXT NOT NULL,
       summary TEXT,
       publisher TEXT,
       published_at TEXT,
       kind TEXT,
       seen_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS buzz_dest_seen ON buzz (dest, seen_at DESC)').run();
}

const hash = async (s) => {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
};

const kindOf = (t) =>
  /hotel|resort/i.test(t) ? 'hotel'
  : /bar|club|nightlife|cocktail/i.test(t) ? 'nightlife'
  : /best|top \d+|guide|roundup/i.test(t) ? 'list'
  : 'opening';

const publisherOf = (item, feedUrl) => {
  if (item.source) return item.source;
  try { return new URL(item.link || feedUrl).hostname.replace(/^www\./, ''); } catch { return null; }
};

async function sweepDest(env, dest) {
  const city = dest.name;
  const urls = [
    ...(CITY_FEEDS[dest.slug] ?? []),
    ...QUERIES.map((q) => GNEWS + encodeURIComponent(q(city))),
  ];
  const batches = await Promise.all(urls.map((u) => fetchFeed(u).then((items) => ({ u, items }))));

  const rows = [];
  for (const { u, items } of batches) {
    for (const it of items.slice(0, 25)) {
      const text = `${it.title} ${it.summary ?? ''}`;
      if (!RELEVANT.test(text) || NOISE.test(text)) continue;
      // Google News wraps links; keep as-is (they redirect to the publisher).
      rows.push({
        id: await hash(`${dest.slug}|${it.title}`),
        dest: dest.slug,
        title: it.title.slice(0, 300),
        url: it.link.slice(0, 900),
        summary: it.summary?.slice(0, 400) ?? null,
        publisher: publisherOf(it, u)?.slice(0, 120) ?? null,
        published_at: it.date ? new Date(it.date).toISOString() : null,
        kind: kindOf(text),
      });
    }
  }
  if (!rows.length) return 0;

  const stmt = env.DB.prepare(
    `INSERT INTO buzz (id, dest, title, url, summary, publisher, published_at, kind, seen_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET seen_at=datetime('now'), url=excluded.url, summary=excluded.summary`,
  );
  await env.DB.batch(rows.map((r) => stmt.bind(r.id, r.dest, r.title, r.url, r.summary, r.publisher, r.published_at, r.kind)));
  return rows.length;
}

async function sweep(env, only) {
  await ensureTable(env);
  const { results: dests } = await env.DB.prepare(
    'SELECT slug, name FROM destinations WHERE live=1 ORDER BY place_count DESC LIMIT 60',
  ).all();
  const targets = only ? dests.filter((d) => only.includes(d.slug)) : dests;

  let total = 0;
  const report = [];
  // Sequential with a small gap: polite to the feeds, and a cron has time.
  for (const d of targets) {
    const n = await sweepDest(env, d);
    total += n;
    if (n) report.push(`${d.slug}:${n}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  // 60-day window keeps "what's new" actually new.
  await env.DB.prepare("DELETE FROM buzz WHERE seen_at < datetime('now','-60 days')").run();
  console.log(`[scout] ${total} items · ${report.join(' ')}`);
  return { total, destinations: targets.length, report };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/sweep' && request.method === 'POST') {
      if (!env.SCOUT_KEY || url.searchParams.get('key') !== env.SCOUT_KEY) {
        return new Response('unauthorized', { status: 401 });
      }
      const only = url.searchParams.get('dest')?.split(',').filter(Boolean) ?? null;
      const out = await sweep(env, only);
      return Response.json(out);
    }
    if (url.pathname === '/latest') {
      const dest = url.searchParams.get('dest');
      if (!dest) return Response.json({ error: 'dest required' }, { status: 400 });
      const { results } = await env.DB.prepare(
        'SELECT title, url, summary, publisher, kind, published_at FROM buzz WHERE dest=?1 ORDER BY COALESCE(published_at, seen_at) DESC LIMIT 12',
      ).bind(dest).all();
      return Response.json({ dest, items: results });
    }
    return new Response('num-scout', { status: 200 });
  },
};
