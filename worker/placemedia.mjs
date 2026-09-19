// PLACE MEDIA (19 Sep 2026) — a picture and the socials for a pick, on demand.
//
// Dre: "add social media and images and grid them out". Of 2.7 million rows
// in `places`, 2,585 carried a photo — harvested offline by
// scripts/enrich_photos.mjs, one destination at a time. A grid of cards with
// two pictures in eight is worse than a list. So the fill moves to the moment
// a place is actually shown: the app renders the answer at once, then asks
// here for the media of the picks that have none, and the cards fill in as
// it lands. What is found is stored, so the second guest never waits.
//
// ── THE RULES ─────────────────────────────────────────────────────────────
//   · Only the venue's OWN published preview image (og:image / twitter:image
//     on its own website) — the picture every chat app and search engine
//     shows for the same link. Never a photo from Google, Yelp or Instagram;
//     those are theirs, under terms that forbid copying them into our table.
//   · Only the venue's own social links, read from anchors on its own site.
//     A handle is never guessed from a name.
//   · A file that is a logo by its name is not a photo of the place.
//   · One fetch per place per 30 days whatever it found, so a site with no
//     image is not fetched on every answer.
//   · 2.5 s and 400 KB per site, eight places per call. The answer never
//     waits on this; the client asks after it has rendered.
//   · Failed reads throw and 503 — no `.catch(() => ({ results: [] }))`.
import { socialOf, photoOf } from './placelink.mjs';

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=600', ...extra } });

export const MAX_IDS = 8;
export const FETCH_MS = 2500;
export const MAX_BYTES = 400 * 1024;
export const RECHECK_DAYS = 30;
const UA = 'NUM-concierge/1.0 (link preview; https://itsnum.com; info@5arz.com)';
const LOGO_RE = /logo|favicon|icon[-_.]|sprite|placeholder|default[-_.]og|badge|avatar/i;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_place_social (
  place_id   TEXT PRIMARY KEY,
  instagram  TEXT,
  tiktok     TEXT,
  facebook   TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;
let ensured = false;
async function ensure(env) {
  if (ensured) return;
  await env.DB.prepare(SCHEMA).run();
  ensured = true;
}

/** Make a URL absolute against the page, https only, or null. */
export function absUrl(u, base) {
  try {
    const url = new URL(String(u ?? '').trim(), base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch { return null; }
}

/**
 * The page's own preview image: og:image, then twitter:image, then
 * og:image:secure_url. Attribute order varies (content before property on
 * half the web), so both orders are read. Logos by name are refused.
 */
export function ogImageFrom(html, base) {
  const s = String(html ?? '').slice(0, MAX_BYTES);
  const metas = [...s.matchAll(/<meta\s+[^>]*>/gi)].map((m) => m[0]);
  const want = ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'];
  const found = [];
  for (const tag of metas) {
    const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase();
    const content = (tag.match(/content\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!key || !content || !want.includes(key)) continue;
    found.push([want.indexOf(key), content]);
  }
  found.sort((a, b) => a[0] - b[0]);
  for (const [, content] of found) {
    const url = absUrl(content.replace(/&amp;/g, '&'), base);
    if (!url || LOGO_RE.test(url)) continue;
    if (!/^https:\/\//i.test(url)) continue; // an http image breaks a https page
    return url;
  }
  return null;
}

/**
 * The venue's own social links, from anchors on its page. Only profile-shaped
 * paths: /handle on Instagram, /@handle on TikTok, /page on Facebook. Posts,
 * reels, share links and the platforms' own utility paths are not handles.
 */
export function socialsFrom(html) {
  const s = String(html ?? '').slice(0, MAX_BYTES);
  const out = { instagram: null, tiktok: null, facebook: null };
  const NOT = /^(p|reel|reels|explore|accounts|share|stories|sharer|sharer\.php|profile\.php|pages|groups|hashtag|video|discover|tag|intent|login|about|help|privacy|policies|legal|terms|dialog|plugins|tr|events|watch|marketplace|gaming|business|ads|developers|embed|oembed|api|static|images|img|cdn|blog|search|home|foryou|upload|music|live|t)$/i;
  for (const m of s.matchAll(/https?:\/\/(?:www\.|m\.)?(instagram\.com|tiktok\.com|facebook\.com|fb\.com)\/([^\s"'<>?#/]+)/gi)) {
    const host = m[1].toLowerCase();
    const handle = m[2].replace(/^@/, '').replace(/\/+$/, '');
    if (!handle || handle.length > 40 || NOT.test(handle)) continue;
    if (host === 'instagram.com' && !out.instagram) out.instagram = `https://www.instagram.com/${handle}/`;
    else if (host === 'tiktok.com' && !out.tiktok) out.tiktok = `https://www.tiktok.com/@${handle}`;
    else if ((host === 'facebook.com' || host === 'fb.com') && !out.facebook) out.facebook = `https://www.facebook.com/${handle}`;
  }
  return out;
}

const isSocialSite = (u) => /instagram\.com|tiktok\.com|facebook\.com|fb\.com/i.test(String(u ?? ''));

/** Fetch a venue's own page, bounded; null on anything but a readable HTML 200. */
export async function readSite(url, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !/html|xml/i.test(type)) return null;
    const reader = res.body?.getReader?.();
    if (!reader) return (await res.text()).slice(0, MAX_BYTES);
    const chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
      if (size >= MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
    }
    const all = new Uint8Array(size); let o = 0;
    for (const c of chunks) { all.set(c.subarray(0, Math.min(c.byteLength, size - o)), o); o += c.byteLength; if (o >= size) break; }
    return new TextDecoder('utf-8', { fatal: false }).decode(all);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

const staleBefore = () => new Date(Date.now() - RECHECK_DAYS * 86400e3).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Media for up to eight places: what is stored, and for a row with no photo
 * and a real website not checked this month, what its page says now — saved
 * for next time, found or not.
 */
export async function mediaFor(env, ids, { fetchImpl = fetch, now = new Date() } = {}) {
  await ensure(env);
  const clean = [...new Set(ids.map((s) => String(s ?? '').trim()).filter((s) => s && s.length <= 60))].slice(0, MAX_IDS);
  if (!clean.length) return {};
  const marks = clean.map((_, i) => `?${i + 1}`).join(',');
  const { results: rows } = await env.DB.prepare(
    `SELECT id, website, photo_url, photo_attr, photo_checked_at FROM places WHERE id IN (${marks})`,
  ).bind(...clean).all();
  const { results: socials } = await env.DB.prepare(
    `SELECT place_id, instagram, tiktok, facebook FROM num_place_social WHERE place_id IN (${marks})`,
  ).bind(...clean).all();
  const socialBy = new Map((socials ?? []).map((r) => [r.place_id, r]));
  const out = {};
  const stale = staleBefore();
  await Promise.all((rows ?? []).map(async (row) => {
    const base = { ...photoOf(row), ...socialOf(row) };
    const stored = socialBy.get(row.id);
    if (stored) for (const k of ['instagram', 'tiktok', 'facebook']) if (stored[k]) base[k] = stored[k];
    const site = String(row.website ?? '').trim();
    const needPhoto = !base.photo && site && !isSocialSite(site) && (!row.photo_checked_at || row.photo_checked_at < stale);
    const needSocial = !stored && site && !isSocialSite(site);
    if (needPhoto || needSocial) {
      const url = absUrl(/^https?:\/\//i.test(site) ? site : `https://${site}`, undefined);
      const html = url ? await readSite(url, fetchImpl) : null;
      const stamp = now.toISOString().slice(0, 19).replace('T', ' ');
      if (html) {
        const photo = needPhoto ? ogImageFrom(html, url) : null;
        const soc = socialsFrom(html);
        if (needPhoto) {
          await env.DB.prepare(
            `UPDATE places SET photo_url = COALESCE(?2, photo_url), photo_source = CASE WHEN ?2 IS NOT NULL THEN 'website' ELSE photo_source END, photo_checked_at = ?3 WHERE id = ?1`,
          ).bind(row.id, photo, stamp).run();
          if (photo) { base.photo = photo; base.photo_attr = null; }
        }
        if (needSocial) {
          await env.DB.prepare(
            'INSERT OR REPLACE INTO num_place_social (place_id, instagram, tiktok, facebook, checked_at) VALUES (?1,?2,?3,?4,?5)',
          ).bind(row.id, soc.instagram, soc.tiktok, soc.facebook, stamp).run();
          for (const k of ['instagram', 'tiktok', 'facebook']) if (soc[k] && !base[k]) base[k] = soc[k];
        }
      } else {
        // Unreadable this month: say so on the row (and an empty socials row),
        // so the next eight answers that name this place do not each wait
        // 2.5 s on the same dead site.
        if (needPhoto) await env.DB.prepare('UPDATE places SET photo_checked_at = ?2 WHERE id = ?1').bind(row.id, stamp).run();
        if (needSocial) await env.DB.prepare('INSERT OR REPLACE INTO num_place_social (place_id, instagram, tiktok, facebook, checked_at) VALUES (?1,NULL,NULL,NULL,?2)').bind(row.id, stamp).run();
      }
    }
    out[row.id] = base;
  }));
  return out;
}

/** GET /api/places/media?ids=a,b,c → { media: { id: { photo, photo_attr, instagram, tiktok, facebook } } } */
export async function handlePlaceMedia(request, env, url) {
  if (!env.DB) return json({ error: 'media needs the database binding' }, 503);
  if (request.method !== 'GET') return json({ error: 'GET' }, 405);
  const ids = String(url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
  if (!ids.length) return json({ error: 'ids required' }, 400);
  const media = await mediaFor(env, ids);
  return json({ ok: true, media });
}
