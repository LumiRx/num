/**
 * WHAT'S ON THIS WEEK — headlines from the city's own what's-on publishers.
 *
 * Dre, 18 Sep 2026: "lets research pages like @secret.losangeles on IG. every
 * major city has one … add them in our suggestions." The research is in the
 * project (NUM-secret-city-sources-2026-09-18.md). The short version, which
 * decides everything in this file:
 *
 *   · The Secret <City> pages are Fever's (Secret Media Network). Fever's
 *     terms forbid scraping, "aggregating … content", deep-linking and even
 *     hyperlinking without consent. NOT HERE. That is a partnership email.
 *   · Time Out's terms forbid any AI/RAG use of its content. NOT HERE.
 *   · Resident Advisor forbids commercial extraction. NOT HERE.
 *   · The independents below PUBLISH AN RSS FEED — the conventional way a
 *     publisher says "syndicate my headlines, link back, credit me". That
 *     is exactly and only what this does.
 *
 * ── THE RULES ─────────────────────────────────────────────────────────────
 *   1. Title, link, date, source name. Never body text, never images.
 *   2. Every headline shown links OUT to the publisher, with their name.
 *   3. One fetch per source per six hours, with a UA that names us.
 *   4. A source can be switched off without a deploy: WHATSON_OFF="skint,tip".
 *   5. Nothing older than 14 days is kept; nothing older than 10 is shown.
 *   6. A feed that fails is recorded in num_whatson_fetch and skipped; the
 *      rest still run. A publisher who removes their feed is thereby off.
 */

/** dest = destinations.slug. Every feed here answered a named UA with real items on 18 Sep 2026. */
export const SOURCES = Object.freeze([
  { id: 'sortiraparis', dest: 'paris', name: 'Sortiraparis', home: 'https://www.sortiraparis.com/en/', feed: 'https://www.sortiraparis.com/rss/sortir', lang: 'fr' },
  { id: 'skint', dest: 'new-york', name: 'The Skint', home: 'https://theskint.com/', feed: 'https://theskint.com/feed/', lang: 'en' },
  { id: 'londonist', dest: 'london', name: 'Londonist', home: 'https://londonist.com/', feed: 'https://londonist.com/feed', lang: 'en' },
  { id: 'whatson-dubai', dest: 'dubai', name: 'What’s On Dubai', home: 'https://whatson.ae/', feed: 'https://whatson.ae/feed/', lang: 'en' },
  { id: 'honeycombers-sg', dest: 'singapore', name: 'Honeycombers', home: 'https://thehoneycombers.com/singapore/', feed: 'https://thehoneycombers.com/singapore/feed/', lang: 'en' },
  { id: 'honeycombers-bali', dest: 'bali', name: 'Honeycombers Bali', home: 'https://thehoneycombers.com/bali/', feed: 'https://thehoneycombers.com/bali/feed/', lang: 'en' },
  // tipBerlin (tip-berlin.de/feed/) answered our named User-Agent with a
  // bot-check interstitial on 18 Sep 2026. That is a publisher saying no
  // to automated reads, so it is not here; Berlin has no source yet.
]);

export const FETCH_EVERY_H = 6;
export const KEEP_DAYS = 14;
export const SHOW_DAYS = 10;
export const PER_SOURCE = 30;
const UA = 'NUM/1.0 (+https://itsnum.com; what’s-on headlines, linked and credited)';

const off = (env) => new Set(String(env?.WHATSON_OFF ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const unescape = (s) => String(s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, '’').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/\s+/g, ' ').trim();

/**
 * The smallest RSS/Atom reader that works on the seven feeds above. Pure;
 * returns [{title, url, published}] newest first, deduped by url.
 */
export function parseFeed(xml) {
  const text = String(xml ?? '');
  const items = [];
  const blocks = text.match(/<item\b[\s\S]*?<\/item>/gi) ?? text.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const title = unescape((b.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1]);
    let url = unescape((b.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i) ?? [])[1]);
    if (!url) url = (b.match(/<link\b[^>]*href="([^"]+)"/i) ?? [])[1] ?? '';
    const date = (b.match(/<(?:pubDate|published|updated|dc:date)\b[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/i) ?? [])[1];
    const ts = date ? Date.parse(unescape(date)) : NaN;
    if (!title || !/^https?:\/\//.test(url)) continue;
    items.push({ title: title.slice(0, 160), url: url.trim().slice(0, 500), published: Number.isFinite(ts) ? new Date(ts).toISOString() : null });
  }
  const seen = new Set();
  return items.filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true)))
    .sort((a, b) => String(b.published ?? '').localeCompare(String(a.published ?? '')));
}

const hid = (url) => 'wo_' + [...url].reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 7).toString(36) + '_' + url.length;

/** One source: fetch if due, store the newest, trim the old. Never throws. */
export async function refreshSource(env, src, { fetchImpl = fetch, now = new Date() } = {}) {
  if (!env?.DB) return { source: src.id, skipped: 'no db' };
  const last = await env.DB.prepare('SELECT fetched_at FROM num_whatson_fetch WHERE source = ?1').bind(src.id).first();
  if (last?.fetched_at && now.getTime() - Date.parse(last.fetched_at) < FETCH_EVERY_H * 3600e3) return { source: src.id, skipped: 'fresh' };
  let items = [];
  let ok = 1, note = null;
  try {
    const r = await fetchImpl(src.feed, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    items = parseFeed(await r.text()).slice(0, PER_SOURCE);
    if (!items.length) { ok = 0; note = 'feed parsed to nothing'; }
  } catch (e) {
    ok = 0; note = String(e?.message ?? e).slice(0, 160);
  }
  await env.DB.prepare(
    'INSERT INTO num_whatson_fetch (source, fetched_at, ok, note) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(source) DO UPDATE SET fetched_at = excluded.fetched_at, ok = excluded.ok, note = excluded.note',
  ).bind(src.id, now.toISOString(), ok, note).run();
  let stored = 0;
  for (const it of items) {
    const r = await env.DB.prepare(
      'INSERT OR IGNORE INTO num_whatson (id, dest, source, title, url, published_at, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    ).bind(hid(it.url), src.dest, src.id, it.title, it.url, it.published, now.toISOString()).run();
    stored += Number(r?.meta?.changes ?? 0);
  }
  await env.DB.prepare("DELETE FROM num_whatson WHERE source = ?1 AND fetched_at < datetime('now', ?2)").bind(src.id, `-${KEEP_DAYS} days`).run();
  return { source: src.id, ok: !!ok, note, fetched: items.length, stored };
}

/** The cron entry: every source that is due and not switched off. */
export async function refreshWhatsOn(env, opts = {}) {
  const skip = off(env);
  const out = [];
  for (const src of SOURCES) {
    if (skip.has(src.id)) { out.push({ source: src.id, skipped: 'WHATSON_OFF' }); continue; }
    out.push(await refreshSource(env, src, opts));
  }
  return out;
}

/** What TONIGHT shows for a destination: the freshest headlines, credited. Throws on a failed read. */
export async function whatsOnFor(env, dest, { limit = 5 } = {}) {
  if (!env?.DB || !dest) return [];
  const skip = off(env);
  const { results } = await env.DB.prepare(
    "SELECT source, title, url, published_at FROM num_whatson WHERE dest = ?1 AND (published_at IS NULL OR published_at > datetime('now', ?2)) ORDER BY published_at DESC LIMIT ?3",
  ).bind(dest, `-${SHOW_DAYS} days`, Math.min(20, Math.max(1, limit | 0))).all();
  return (results ?? [])
    .filter((r) => !skip.has(r.source))
    .map((r) => {
      const s = SOURCES.find((x) => x.id === r.source);
      return { title: r.title, url: r.url, published: r.published_at, source: s?.name ?? r.source, source_url: s?.home ?? null, lang: s?.lang ?? 'en' };
    });
}
